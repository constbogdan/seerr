import type { AnidbItem } from '@server/api/animelist';
import animeList from '@server/api/animelist';
import type {
  JellyfinLibraryItem,
  JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import TheMovieDb from '@server/api/themoviedb';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { EpisodeNumberResult } from '@server/lib/downloadtracker';
import { prepareJellyfinAnimeMappings } from '@server/lib/jellyfinAnimeMappingCoordinator';
import {
  JellyfinScanner,
  createJellyfinScannerContext,
  type JellyfinScannerContext,
} from '@server/lib/scanners/jellyfin';
import type { Library } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';

export interface JellyfinTargetedMediaTarget {
  mediaId: number;
  mediaType: MediaType;
  is4k: boolean;
  tmdbId: number;
  tvdbId?: number;
  imdbId?: string;
  jellyfinMediaId?: string;
  episodes: EpisodeNumberResult[];
}

export type TargetedReadinessReason =
  | 'item_absent'
  | 'identity_missing'
  | 'identity_mismatch'
  | 'not_playable'
  | 'episode_identity_missing'
  | 'episode_absent'
  | 'canonical_state_unresolved'
  | 'media_server_unavailable'
  | 'lookup_failed'
  | 'processing_failed';

export type TargetedReadiness =
  | {
      state: 'ready';
      lookupMethod: 'exact-id' | 'bounded-search';
      lookupDurationMs: number;
      processingDurationMs: number;
      jellyfinRequestCount: number;
    }
  | {
      state: 'not_ready';
      reason: TargetedReadinessReason;
      lookupMethod: 'exact-id' | 'bounded-search';
      lookupDurationMs: number;
      jellyfinRequestCount: number;
    }
  | {
      state: 'unknown';
      reason: TargetedReadinessReason;
      errorType?: string;
      lookupMethod: 'exact-id' | 'bounded-search';
      lookupDurationMs: number;
      jellyfinRequestCount: number;
    };

interface TargetedLookupReady {
  state: 'ready';
  items: JellyfinLibraryItemExtended[];
  lookupMethod: 'exact-id' | 'bounded-search';
  lookupDurationMs: number;
  jellyfinRequestCount: number;
}

type TargetedLookup =
  | TargetedLookupReady
  | Exclude<TargetedReadiness, { state: 'ready' }>;

interface TargetedAvailabilityDependencies {
  prepareIdentityMappings: () => Promise<void>;
  getAnimeIdentity: (anidbId: number) => AnidbItem | undefined;
  isSeparate4kEnabled: (mediaType: MediaType) => boolean;
  createContext: () => Promise<JellyfinScannerContext | undefined>;
  getMovieTitles: (
    tmdbId: number
  ) => Promise<{ titles: string[]; imdbId?: string }>;
  getTvTitles: (
    tmdbId: number
  ) => Promise<{ titles: string[]; tvdbId?: number }>;
  processItems: (items: JellyfinLibraryItem[]) => Promise<{
    status: 'completed' | 'skipped' | 'aborted' | 'failed';
    durationMs: number;
    errorType?: string;
  }>;
  isSatisfied: (target: JellyfinTargetedMediaTarget) => Promise<boolean>;
  now: () => number;
}

const uniqueNonEmpty = (values: (string | undefined)[]): string[] => [
  ...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[]),
];

const hasVideoForQuality = (
  item: JellyfinLibraryItemExtended,
  is4k: boolean,
  separate4kEnabled: boolean
): boolean =>
  item.MediaSources?.some((source) =>
    source.MediaStreams.some((stream) => {
      if (stream.Type !== 'Video') return false;
      if (!separate4kEnabled && !is4k) return true;
      return is4k ? (stream.Width ?? 0) > 2000 : (stream.Width ?? 0) <= 2000;
    })
  ) ?? false;

const defaultIsSatisfied = async (
  target: JellyfinTargetedMediaTarget
): Promise<boolean> => {
  const media = await getRepository(Media).findOne({
    where: { id: target.mediaId },
    relations: { seasons: true },
  });
  if (!media) return false;

  if (target.mediaType === MediaType.MOVIE) {
    return (
      (target.is4k ? media.status4k : media.status) === MediaStatus.AVAILABLE
    );
  }

  const seasonNumbers = [
    ...new Set(target.episodes.map((episode) => episode.seasonNumber)),
  ];
  if (seasonNumbers.length === 0) return false;
  return seasonNumbers.every((seasonNumber) => {
    const season = media.seasons.find(
      (candidate) => candidate.seasonNumber === seasonNumber
    );
    const status = target.is4k ? season?.status4k : season?.status;
    return (
      status === MediaStatus.AVAILABLE ||
      status === MediaStatus.PARTIALLY_AVAILABLE
    );
  });
};

const defaultDependencies = (): TargetedAvailabilityDependencies => {
  const tmdb = new TheMovieDb();
  return {
    prepareIdentityMappings: prepareJellyfinAnimeMappings,
    getAnimeIdentity: (anidbId) => animeList.getFromAnidbId(anidbId),
    isSeparate4kEnabled: (mediaType) => {
      const settings = getSettings();
      return mediaType === MediaType.MOVIE
        ? settings.radarr.some((server) => server.is4k)
        : settings.sonarr.some((server) => server.is4k);
    },
    createContext: createJellyfinScannerContext,
    getMovieTitles: async (tmdbId) => {
      const movie = await tmdb.getMovie({ movieId: tmdbId });
      return {
        titles: uniqueNonEmpty([movie.title, movie.original_title]),
        imdbId: movie.imdb_id,
      };
    },
    getTvTitles: async (tmdbId) => {
      const show = await tmdb.getTvShow({ tvId: tmdbId });
      return {
        titles: uniqueNonEmpty([show.name, show.original_name]),
        tvdbId: show.external_ids?.tvdb_id,
      };
    },
    processItems: (items) =>
      new JellyfinScanner().processKnownJellyfinItems(items),
    isSatisfied: defaultIsSatisfied,
    now: Date.now,
  };
};

export class JellyfinTargetedAvailability {
  private readonly dependencies: TargetedAvailabilityDependencies;

  constructor(dependencies: Partial<TargetedAvailabilityDependencies> = {}) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
  }

  public async reconcile(
    target: JellyfinTargetedMediaTarget
  ): Promise<TargetedReadiness> {
    const lookup = await this.lookup(target);
    if (lookup.state !== 'ready') return lookup;

    const processing = await this.dependencies.processItems(lookup.items);
    if (processing.status !== 'completed') {
      return {
        state: 'unknown',
        reason: 'processing_failed',
        errorType: processing.errorType ?? processing.status,
        lookupMethod: lookup.lookupMethod,
        lookupDurationMs: lookup.lookupDurationMs,
        jellyfinRequestCount: lookup.jellyfinRequestCount,
      };
    }

    if (!(await this.dependencies.isSatisfied(target))) {
      return {
        state: 'not_ready',
        reason: 'canonical_state_unresolved',
        lookupMethod: lookup.lookupMethod,
        lookupDurationMs: lookup.lookupDurationMs,
        jellyfinRequestCount: lookup.jellyfinRequestCount,
      };
    }

    return {
      state: 'ready',
      lookupMethod: lookup.lookupMethod,
      lookupDurationMs: lookup.lookupDurationMs,
      processingDurationMs: processing.durationMs,
      jellyfinRequestCount: lookup.jellyfinRequestCount,
    };
  }

  public async lookup(
    target: JellyfinTargetedMediaTarget
  ): Promise<TargetedLookup> {
    const startedAt = this.dependencies.now();
    let requestCount = 0;
    let method: 'exact-id' | 'bounded-search' = target.jellyfinMediaId
      ? 'exact-id'
      : 'bounded-search';
    let exactFailureReason: TargetedReadinessReason | undefined;

    try {
      const context = await this.dependencies.createContext();
      if (!context) {
        return {
          state: 'unknown',
          reason: 'media_server_unavailable',
          lookupMethod: method,
          lookupDurationMs: this.dependencies.now() - startedAt,
          jellyfinRequestCount: requestCount,
        };
      }

      const separate4kEnabled = this.dependencies.isSeparate4kEnabled(
        target.mediaType
      );

      if (target.jellyfinMediaId) {
        requestCount += 1;
        const exact = await context.client.getItemData(target.jellyfinMediaId);
        if (exact) {
          if (exact.ProviderIds.AniDB) {
            await this.dependencies.prepareIdentityMappings();
          }
          const exactReady = await this.filterReadyItems(
            [exact],
            target,
            context,
            separate4kEnabled,
            () => (requestCount += 1)
          );
          if (exactReady.items.length > 0 && exactReady.complete) {
            return {
              state: 'ready',
              items: exactReady.items,
              lookupMethod: method,
              lookupDurationMs: this.dependencies.now() - startedAt,
              jellyfinRequestCount: requestCount,
            };
          }
          exactFailureReason = exactReady.reason;
        }
      }

      method = 'bounded-search';
      const canonical =
        target.mediaType === MediaType.MOVIE
          ? await this.dependencies.getMovieTitles(target.tmdbId)
          : await this.dependencies.getTvTitles(target.tmdbId);
      const identityTarget: JellyfinTargetedMediaTarget = {
        ...target,
        imdbId:
          target.imdbId ??
          ('imdbId' in canonical ? canonical.imdbId : undefined),
        tvdbId:
          target.tvdbId ??
          ('tvdbId' in canonical ? canonical.tvdbId : undefined),
      };
      const libraries = this.searchLibraries(
        context.libraries,
        target.mediaType
      );
      const candidates: JellyfinLibraryItemExtended[] = [];
      for (const library of libraries) {
        for (const title of canonical.titles) {
          requestCount += 1;
          candidates.push(
            ...(await context.client.searchItems({
              parentId: library.id,
              searchTerm: title,
              includeItemTypes:
                target.mediaType === MediaType.MOVIE
                  ? ['Movie', 'Series']
                  : ['Series'],
              limit: 25,
            }))
          );
        }
      }
      const uniqueCandidates = [
        ...new Map(candidates.map((item) => [item.Id, item])).values(),
      ];
      if (uniqueCandidates.some((item) => item.ProviderIds.AniDB)) {
        await this.dependencies.prepareIdentityMappings();
      }
      const ready = await this.filterReadyItems(
        uniqueCandidates,
        identityTarget,
        context,
        separate4kEnabled,
        () => (requestCount += 1)
      );
      if (ready.items.length > 0 && ready.complete) {
        return {
          state: 'ready',
          items: ready.items,
          lookupMethod: method,
          lookupDurationMs: this.dependencies.now() - startedAt,
          jellyfinRequestCount: requestCount,
        };
      }

      return {
        state: 'not_ready',
        reason:
          uniqueCandidates.length === 0
            ? (exactFailureReason ?? 'item_absent')
            : (ready.reason ?? 'not_playable'),
        lookupMethod: method,
        lookupDurationMs: this.dependencies.now() - startedAt,
        jellyfinRequestCount: requestCount,
      };
    } catch (error) {
      return {
        state: 'unknown',
        reason: 'lookup_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
        lookupMethod: method,
        lookupDurationMs: this.dependencies.now() - startedAt,
        jellyfinRequestCount: requestCount,
      };
    }
  }

  private searchLibraries(
    libraries: Library[],
    mediaType: MediaType
  ): Library[] {
    if (mediaType === MediaType.TV) {
      return libraries.filter((library) => library.type === 'show');
    }
    // Movie libraries are authoritative for ordinary films. Show libraries
    // remain bounded candidates for Seerr's existing AniDB anime-as-movie path.
    return libraries.filter(
      (library) => library.type === 'movie' || library.type === 'show'
    );
  }

  private identityMatches(
    item: JellyfinLibraryItemExtended,
    target: JellyfinTargetedMediaTarget
  ): 'match' | 'missing' | 'mismatch' {
    const providerIds = item.ProviderIds ?? {};
    const tmdbId = Number(providerIds.Tmdb || providerIds.TheMovieDb || 0);
    if (tmdbId) return tmdbId === target.tmdbId ? 'match' : 'mismatch';

    if (target.mediaType === MediaType.MOVIE && providerIds.Imdb) {
      return target.imdbId
        ? providerIds.Imdb === target.imdbId
          ? 'match'
          : 'mismatch'
        : 'missing';
    }
    if (target.mediaType === MediaType.TV && providerIds.Tvdb) {
      return target.tvdbId
        ? Number(providerIds.Tvdb) === target.tvdbId
          ? 'match'
          : 'mismatch'
        : 'missing';
    }

    if (providerIds.AniDB) {
      const mapping = this.dependencies.getAnimeIdentity(
        Number(providerIds.AniDB)
      );
      if (mapping?.tmdbId) {
        return mapping.tmdbId === target.tmdbId ? 'match' : 'mismatch';
      }
      if (
        target.mediaType === MediaType.MOVIE &&
        mapping?.imdbId &&
        target.imdbId
      ) {
        return mapping.imdbId === target.imdbId ? 'match' : 'mismatch';
      }
      if (
        target.mediaType === MediaType.TV &&
        mapping?.tvdbId &&
        target.tvdbId
      ) {
        return mapping.tvdbId === target.tvdbId ? 'match' : 'mismatch';
      }
    }

    return 'missing';
  }

  private async filterReadyItems(
    candidates: JellyfinLibraryItemExtended[],
    target: JellyfinTargetedMediaTarget,
    context: JellyfinScannerContext,
    separate4kEnabled: boolean,
    countRequest: () => void
  ): Promise<{
    items: JellyfinLibraryItemExtended[];
    complete: boolean;
    reason?: TargetedReadinessReason;
  }> {
    const identityMatches = candidates.filter((item) => {
      if (
        target.mediaType === MediaType.TV
          ? item.Type !== 'Series'
          : item.Type !== 'Movie' && item.Type !== 'Series'
      ) {
        return false;
      }
      return this.identityMatches(item, target) === 'match';
    });

    if (identityMatches.length === 0) {
      const hasMissingIdentity = candidates.some(
        (item) => this.identityMatches(item, target) === 'missing'
      );
      return {
        items: [],
        complete: false,
        reason: hasMissingIdentity ? 'identity_missing' : 'identity_mismatch',
      };
    }

    if (target.mediaType === MediaType.MOVIE) {
      const playable: JellyfinLibraryItemExtended[] = [];
      for (const item of identityMatches) {
        if (item.Type === 'Movie') {
          if (hasVideoForQuality(item, target.is4k, separate4kEnabled)) {
            playable.push(item);
          }
          continue;
        }

        // Existing Seerr anime-as-movie handling represents a movie as the
        // first playable episode of AniDB Season 1.
        countRequest();
        const seasons = await context.client.getSeasons(item.Id);
        const firstSeason = seasons.find((season) => season.IndexNumber === 1);
        if (!firstSeason) continue;
        countRequest();
        const episodes = await context.client.getEpisodes(
          item.Id,
          firstSeason.Id,
          { includeMediaInfo: true }
        );
        if (
          episodes.some(
            (episode) =>
              episode.LocationType !== 'Virtual' &&
              hasVideoForQuality(episode, target.is4k, separate4kEnabled)
          )
        ) {
          playable.push(item);
        }
      }
      return {
        items: playable,
        complete: playable.length > 0,
        ...(playable.length === 0 && { reason: 'not_playable' as const }),
      };
    }

    if (target.episodes.length === 0) {
      return {
        items: [],
        complete: false,
        reason: 'episode_identity_missing',
      };
    }

    const required = new Set(
      target.episodes.map(
        (episode) => `${episode.seasonNumber}:${episode.episodeNumber}`
      )
    );
    const proven = new Set<string>();
    const playableSeries: JellyfinLibraryItemExtended[] = [];
    for (const series of identityMatches) {
      countRequest();
      const seasons = await context.client.getSeasons(series.Id);
      let seriesProvedEpisode = false;
      for (const seasonNumber of [
        ...new Set(target.episodes.map((episode) => episode.seasonNumber)),
      ]) {
        const season = seasons.find(
          (candidate) => Number(candidate.IndexNumber) === seasonNumber
        );
        if (!season) continue;
        countRequest();
        const episodes = await context.client.getEpisodes(
          series.Id,
          season.Id,
          { includeMediaInfo: true }
        );
        for (const requiredEpisode of target.episodes.filter(
          (episode) => episode.seasonNumber === seasonNumber
        )) {
          const matched = episodes.find(
            (episode) =>
              episode.IndexNumber !== undefined &&
              episode.IndexNumber <= requiredEpisode.episodeNumber &&
              (episode.IndexNumberEnd ?? episode.IndexNumber) >=
                requiredEpisode.episodeNumber &&
              episode.LocationType !== 'Virtual' &&
              hasVideoForQuality(episode, target.is4k, separate4kEnabled)
          );
          if (matched) {
            proven.add(
              `${requiredEpisode.seasonNumber}:${requiredEpisode.episodeNumber}`
            );
            seriesProvedEpisode = true;
          }
        }
      }
      if (seriesProvedEpisode) playableSeries.push(series);
    }

    return {
      items: playableSeries,
      complete: [...required].every((episode) => proven.has(episode)),
      ...([...required].every((episode) => proven.has(episode))
        ? {}
        : { reason: 'episode_absent' as const }),
    };
  }
}

const jellyfinTargetedAvailability = new JellyfinTargetedAvailability();

export default jellyfinTargetedAvailability;
