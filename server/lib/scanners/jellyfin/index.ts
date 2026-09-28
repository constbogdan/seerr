import animeList from '@server/api/animelist';
import type {
  JellyfinLibraryItem,
  JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import { getMetadataProvider } from '@server/api/metadata';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type {
  TmdbKeyword,
  TmdbTvDetails,
  TmdbTvScanDetails,
} from '@server/api/themoviedb/interfaces';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { prepareJellyfinAnimeMappings } from '@server/lib/jellyfinAnimeMappingCoordinator';
import jellyfinCanonicalProcessingCoordinator from '@server/lib/jellyfinCanonicalProcessingCoordinator';
import type {
  ProcessableSeason,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { getHostname } from '@server/utils/getHostname';
import { uniqWith } from 'lodash';

interface JellyfinSyncStatus extends StatusBase {
  currentLibrary: Library;
  libraries: Library[];
}

export interface JellyfinScanOutcome {
  status: 'completed' | 'skipped' | 'aborted' | 'failed';
  durationMs: number;
  errorType?: string;
}

export interface JellyfinScannerContext {
  client: JellyfinAPI;
  libraries: Library[];
}

export const createJellyfinScannerContext = async (): Promise<
  JellyfinScannerContext | undefined
> => {
  const settings = getSettings();
  if (
    settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
    settings.main.mediaServerType !== MediaServerType.EMBY
  ) {
    return undefined;
  }

  const admin = await getRepository(User).findOne({
    where: { id: 1 },
    select: ['id', 'jellyfinUserId', 'jellyfinDeviceId'],
    order: { id: 'ASC' },
  });
  if (!admin) return undefined;

  const client = new JellyfinAPI(
    getHostname(),
    settings.jellyfin.apiKey,
    admin.jellyfinDeviceId
  );
  client.setUserId(admin.jellyfinUserId ?? '');

  return {
    client,
    libraries: settings.jellyfin.libraries.filter((library) => library.enabled),
  };
};

export class JellyfinScanner
  extends BaseScanner<JellyfinLibraryItem>
  implements RunnableScanner<JellyfinSyncStatus>
{
  private jfClient: JellyfinAPI;
  private libraries: Library[];
  private currentLibrary: Library;
  private isRecentOnly = false;
  private processedAnidbSeason: Map<number, Map<number, number>>;

  constructor({ isRecentOnly }: { isRecentOnly?: boolean } = {}) {
    super('Jellyfin Sync');
    this.isRecentOnly = isRecentOnly ?? false;
  }

  private async extractMovieIds(jellyfinitem: JellyfinLibraryItem): Promise<{
    tmdbId: number;
    imdbId?: string;
    metadata: JellyfinLibraryItemExtended;
  } | null> {
    let metadata = await this.jfClient.getItemData(jellyfinitem.Id);

    if (!metadata?.Id) {
      this.log('No Id metadata for this title. Skipping', 'debug', {
        jellyfinItemId: jellyfinitem.Id,
      });
      return null;
    }

    const anidbId = Number(metadata.ProviderIds.AniDB ?? null);
    let tmdbId = Number(
      metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb || null
    );
    let imdbId = metadata.ProviderIds.Imdb;

    // We use anidb only if we have the anidbId and nothing else
    if (anidbId && !imdbId && !tmdbId) {
      const result = animeList.getFromAnidbId(anidbId);
      tmdbId = Number(result?.tmdbId ?? null);
      imdbId = result?.imdbId;
    }

    if (imdbId && !tmdbId) {
      tmdbId = await this.tmdb.resolveImdbIdForScan({
        imdbId: imdbId,
      });
    }

    if (!tmdbId) {
      throw new Error('Unable to find TMDb ID');
    }

    // With AniDB we can have mixed libraries with movies in a "show" library
    // We take the first episode of the first season (the movie) and use it to
    // get more information, like the MediaSource
    if (anidbId && metadata.Type === 'Series') {
      const season = (await this.jfClient.getSeasons(jellyfinitem.Id)).find(
        (md) => {
          return md.IndexNumber === 1;
        }
      );
      if (!season) {
        this.log('No season found for anidb movie', 'debug', {
          jellyfinitem,
        });
        return null;
      }
      const episodes = await this.jfClient.getEpisodes(
        jellyfinitem.Id,
        season.Id
      );
      if (!episodes[0]) {
        this.log('No episode found for anidb movie', 'debug', {
          jellyfinitem,
        });
        return null;
      }
      metadata = await this.jfClient.getItemData(episodes[0].Id);
      if (!metadata) {
        this.log('No metadata found for anidb movie', 'debug', {
          jellyfinitem,
        });
        return null;
      }
    }

    return { tmdbId, imdbId, metadata };
  }

  private async processJellyfinMovie(
    jellyfinitem: JellyfinLibraryItem
  ): Promise<boolean> {
    try {
      const extracted = await this.extractMovieIds(jellyfinitem);
      if (!extracted) return false;

      const { tmdbId, imdbId, metadata } = extracted;

      const has4k = metadata.MediaSources?.some((MediaSource) => {
        return MediaSource.MediaStreams.filter(
          (MediaStream) => MediaStream.Type === 'Video'
        ).some((MediaStream) => {
          return (MediaStream.Width ?? 0) > 2000;
        });
      });

      const hasOtherResolution = metadata.MediaSources?.some((MediaSource) => {
        return MediaSource.MediaStreams.filter(
          (MediaStream) => MediaStream.Type === 'Video'
        ).some((MediaStream) => {
          return (MediaStream.Width ?? 0) <= 2000;
        });
      });

      const mediaAddedAt = metadata.DateCreated
        ? new Date(metadata.DateCreated)
        : undefined;

      if (hasOtherResolution || (!this.enable4kMovie && has4k)) {
        await this.processMovie(tmdbId, {
          is4k: false,
          mediaAddedAt,
          jellyfinMediaId: metadata.Id,
          imdbId,
          title: metadata.Name,
        });
      }

      if (has4k && this.enable4kMovie) {
        await this.processMovie(tmdbId, {
          is4k: true,
          mediaAddedAt,
          jellyfinMediaId: metadata.Id,
          imdbId,
          title: metadata.Name,
        });
      }
      return true;
    } catch (e) {
      this.log(
        `Failed to process Jellyfin item, id: ${jellyfinitem.Id}`,
        'error',
        {
          errorMessage: e.message,
          jellyfinitem,
        }
      );
      return false;
    }
  }

  private async getTvShow({
    tmdbId,
    tvdbId,
  }: {
    tmdbId?: number;
    tvdbId?: number;
  }): Promise<TmdbTvScanDetails | TmdbTvDetails> {
    let tvShow;

    if (tmdbId) {
      tvShow = await this.tmdb.getTvShowForScan({
        tvId: Number(tmdbId),
      });
    } else if (tvdbId) {
      tvShow = await this.tmdb.getShowByTvdbIdForScan({
        tvdbId: Number(tvdbId),
      });
    } else {
      throw new Error('No ID provided');
    }

    const metadataProvider = tvShow.keywords.results.some(
      (keyword: TmdbKeyword) => keyword.id === ANIME_KEYWORD_ID
    )
      ? await getMetadataProvider('anime')
      : await getMetadataProvider('tv');

    if (!(metadataProvider instanceof TheMovieDb)) {
      tvShow = await metadataProvider.getTvShow({
        tvId: Number(tmdbId),
      });
    }

    return tvShow;
  }

  private async processJellyfinShow(
    jellyfinitem: JellyfinLibraryItem
  ): Promise<boolean> {
    let tvShow: TmdbTvScanDetails | TmdbTvDetails | null = null;

    try {
      const Id =
        jellyfinitem.SeriesId ?? jellyfinitem.SeasonId ?? jellyfinitem.Id;
      const metadata = await this.jfClient.getItemData(Id);

      if (!metadata?.Id) {
        this.log('No Id metadata for this title. Skipping', 'debug', {
          jellyfinItemId: jellyfinitem.Id,
        });
        return false;
      }

      if (metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb) {
        try {
          tvShow = await this.getTvShow({
            tmdbId: Number(
              metadata.ProviderIds.Tmdb || metadata.ProviderIds.TheMovieDb
            ),
          });
        } catch {
          this.log('Unable to find TMDb ID for this title.', 'debug', {
            jellyfinitem,
          });
        }
      }

      if (!tvShow && metadata.ProviderIds.Tvdb) {
        try {
          tvShow = await this.getTvShow({
            tvdbId: Number(metadata.ProviderIds.Tvdb),
          });
        } catch {
          this.log('Unable to find TVDb ID for this title.', 'debug', {
            jellyfinitem,
          });
        }
      }

      let tvdbSeasonFromAnidb: number | undefined;
      if (!tvShow && metadata.ProviderIds.AniDB) {
        const anidbId = Number(metadata.ProviderIds.AniDB);
        const result = animeList.getFromAnidbId(anidbId);
        tvdbSeasonFromAnidb = result?.tvdbSeason;
        if (result?.tvdbId) {
          try {
            tvShow = await this.tmdb.getShowByTvdbIdForScan({
              tvdbId: result.tvdbId,
            });
          } catch {
            this.log('Unable to find AniDB ID for this title.', 'debug', {
              jellyfinitem,
            });
          }
        }
        // With AniDB we can have mixed libraries with movies in a "show" library
        else if (result?.imdbId || result?.tmdbId) {
          return this.processJellyfinMovie(jellyfinitem);
        }
      }

      if (tvShow) {
        const seasons = tvShow.seasons;
        const jellyfinSeasons = await this.jfClient.getSeasons(Id);

        const processableSeasons: ProcessableSeason[] = [];

        const settings = getSettings();
        const filteredSeasons = settings.main.enableSpecialEpisodes
          ? seasons
          : seasons.filter((sn) => sn.season_number !== 0);

        for (const season of filteredSeasons) {
          const matchedJellyfinSeason = jellyfinSeasons.find((md) => {
            if (tvdbSeasonFromAnidb) {
              // In AniDB we don't have the concept of seasons,
              // we have multiple shows with only Season 1 (and sometimes a season with index 0 for specials).
              // We use tvdbSeasonFromAnidb to check if we are on the correct TMDB season and
              // md.IndexNumber === 1 to be sure to find the correct season on jellyfin
              return (
                tvdbSeasonFromAnidb === season.season_number &&
                md.IndexNumber === 1
              );
            } else {
              return Number(md.IndexNumber) === season.season_number;
            }
          });

          // Check if we found the matching season and it has all the available episodes
          if (matchedJellyfinSeason) {
            let totalStandard = 0;
            let total4k = 0;

            if (!this.enable4kShow) {
              const episodes = await this.jfClient.getEpisodes(
                Id,
                matchedJellyfinSeason.Id
              );

              for (const episode of episodes) {
                let episodeCount = 1;

                // count number of combined episodes
                if (
                  episode.IndexNumber !== undefined &&
                  episode.IndexNumberEnd !== undefined
                ) {
                  episodeCount =
                    episode.IndexNumberEnd - episode.IndexNumber + 1;
                }

                totalStandard += episodeCount;
              }
            } else {
              // 4K detection enabled - request media info to check resolution
              const episodes = await this.jfClient.getEpisodes(
                Id,
                matchedJellyfinSeason.Id,
                { includeMediaInfo: true }
              );

              for (const episode of episodes) {
                let episodeCount = 1;

                // count number of combined episodes
                if (
                  episode.IndexNumber !== undefined &&
                  episode.IndexNumberEnd !== undefined
                ) {
                  episodeCount =
                    episode.IndexNumberEnd - episode.IndexNumber + 1;
                }

                const has4k = episode.MediaSources?.some((MediaSource) =>
                  MediaSource.MediaStreams.some(
                    (MediaStream) =>
                      MediaStream.Type === 'Video' &&
                      (MediaStream.Width ?? 0) > 2000
                  )
                );

                const hasStandard = episode.MediaSources?.some((MediaSource) =>
                  MediaSource.MediaStreams.some(
                    (MediaStream) =>
                      MediaStream.Type === 'Video' &&
                      (MediaStream.Width ?? 0) <= 2000
                  )
                );

                // Count in both if episode has both versions
                // TODO: Make this more robust in the future
                // Currently, this detection is based solely on file resolution, not which
                // Radarr/Sonarr instance the file came from. If a 4K request results in
                // 1080p files (no 4K release available yet), those files will be counted
                // as "standard" even though they're in the 4K library. This can cause
                // non-4K users to see content as "available" when they can't access it.
                // See issue https://github.com/seerr-team/seerr/issues/1744 for details.
                if (hasStandard) totalStandard += episodeCount;
                if (has4k) total4k += episodeCount;
              }
            }

            // With AniDB we can have multiple shows for one season, so we need to save
            // the episode from all the jellyfin entries to get the total
            if (tvdbSeasonFromAnidb) {
              let show = this.processedAnidbSeason.get(tvShow.id);

              if (!show) {
                show = new Map([[season.season_number, totalStandard]]);
                this.processedAnidbSeason.set(tvShow.id, show);
              } else {
                const currentCount = show.get(season.season_number) ?? 0;
                const newCount = currentCount + totalStandard;
                show.set(season.season_number, newCount);
                totalStandard = newCount;
              }
            }

            processableSeasons.push({
              seasonNumber: season.season_number,
              totalEpisodes: season.episode_count,
              episodes: totalStandard,
              episodes4k: total4k,
            });
          } else {
            processableSeasons.push({
              seasonNumber: season.season_number,
              totalEpisodes: season.episode_count,
              episodes: 0,
              episodes4k: 0,
            });
          }
        }

        await this.processShow(
          tvShow.id,
          tvShow.external_ids?.tvdb_id,
          processableSeasons,
          {
            mediaAddedAt: metadata.DateCreated
              ? new Date(metadata.DateCreated)
              : undefined,
            jellyfinMediaId: Id,
            title: tvShow.name,
          }
        );
        return true;
      } else {
        this.log(
          `No information found for the show: ${metadata.Name}`,
          'debug',
          {
            jellyfinitem,
          }
        );
        return false;
      }
    } catch (e) {
      this.log(
        `Failed to process Jellyfin item. Id: ${
          jellyfinitem.SeriesId ?? jellyfinitem.SeasonId ?? jellyfinitem.Id
        }`,
        'error',
        { errorMessage: e.message, jellyfinitem }
      );
      return false;
    }
  }

  private async processItem(item: JellyfinLibraryItem): Promise<boolean> {
    if (item.Type === 'Movie') {
      return this.processJellyfinMovie(item);
    } else if (item.Type === 'Series') {
      return this.processJellyfinShow(item);
    }
    return false;
  }

  public async run(): Promise<JellyfinScanOutcome> {
    return jellyfinCanonicalProcessingCoordinator.runExclusive(() =>
      this.runUncoordinated()
    );
  }

  private async runUncoordinated(): Promise<JellyfinScanOutcome> {
    const startedAt = Date.now();
    const settings = getSettings();
    if (
      settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
      settings.main.mediaServerType !== MediaServerType.EMBY
    ) {
      return { status: 'skipped', durationMs: Date.now() - startedAt };
    }
    const context = await createJellyfinScannerContext();
    if (!context) {
      this.log('No admin configured. Jellyfin sync skipped.', 'warn');
      return { status: 'skipped', durationMs: Date.now() - startedAt };
    }

    const sessionId = this.startRun();

    try {
      this.jfClient = context.client;
      this.libraries = context.libraries;

      await prepareJellyfinAnimeMappings();

      if (this.isRecentOnly) {
        for (const library of this.libraries) {
          this.currentLibrary = library;
          // Reset AniDB season tracking per library
          this.processedAnidbSeason = new Map();
          this.log(
            `Beginning to process recently added for library: ${library.name}`,
            'info'
          );
          const libraryItems = await this.jfClient.getRecentlyAdded(library.id);

          // Bundle items up by rating keys
          this.items = uniqWith(libraryItems, (mediaA, mediaB) => {
            if (mediaA.SeriesId && mediaB.SeriesId) {
              return mediaA.SeriesId === mediaB.SeriesId;
            }

            if (mediaA.SeasonId && mediaB.SeasonId) {
              return mediaA.SeasonId === mediaB.SeasonId;
            }

            return mediaA.Id === mediaB.Id;
          });

          await this.loop(
            async (item) => {
              await this.processItem(item);
            },
            { sessionId }
          );
        }
      } else {
        for (const library of this.libraries) {
          this.currentLibrary = library;
          // Reset AniDB season tracking per library
          this.processedAnidbSeason = new Map();
          this.log(`Beginning to process library: ${library.name}`, 'info');
          this.items = await this.jfClient.getLibraryContents(library.id);
          await this.loop(
            async (item) => {
              await this.processItem(item);
            },
            { sessionId }
          );
        }
      }

      this.log(
        this.isRecentOnly
          ? 'Recently Added Scan Complete'
          : 'Full Scan Complete',
        'info'
      );
      return { status: 'completed', durationMs: Date.now() - startedAt };
    } catch (e) {
      this.log('Sync interrupted', 'error', { errorMessage: e.message });
      return {
        status:
          e instanceof Error && /aborted/i.test(e.message)
            ? 'aborted'
            : 'failed',
        durationMs: Date.now() - startedAt,
        errorType: e instanceof Error ? e.name : 'UnknownError',
      };
    } finally {
      this.endRun(sessionId);
    }
  }

  public async processKnownJellyfinItems(
    items: JellyfinLibraryItem[]
  ): Promise<JellyfinScanOutcome> {
    const startedAt = Date.now();
    const context = await createJellyfinScannerContext();
    if (!context || items.length === 0) {
      return { status: 'skipped', durationMs: Date.now() - startedAt };
    }

    return jellyfinCanonicalProcessingCoordinator.runExclusive(async () => {
      await prepareJellyfinAnimeMappings();
      const sessionId = this.startRun();
      try {
        this.jfClient = context.client;
        this.libraries = context.libraries;
        this.processedAnidbSeason = new Map();
        const uniqueItems = [
          ...new Map(items.map((item) => [item.Id, item])).values(),
        ];
        let failures = 0;
        for (const item of uniqueItems) {
          if (!(await this.processItem(item))) failures += 1;
        }

        return {
          status: failures === 0 ? 'completed' : 'failed',
          durationMs: Date.now() - startedAt,
          ...(failures > 0 && { errorType: 'ItemProcessingFailed' }),
        };
      } catch (e) {
        this.log('Targeted Jellyfin processing failed', 'error', {
          errorType: e instanceof Error ? e.name : 'UnknownError',
        });
        return {
          status: 'failed',
          durationMs: Date.now() - startedAt,
          errorType: e instanceof Error ? e.name : 'UnknownError',
        };
      } finally {
        this.endRun(sessionId);
      }
    });
  }

  public status(): JellyfinSyncStatus {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
      currentLibrary: this.currentLibrary,
      libraries: this.libraries,
    };
  }
}

export const jellyfinFullScanner = new JellyfinScanner();
export const jellyfinRecentScanner = new JellyfinScanner({
  isRecentOnly: true,
});
