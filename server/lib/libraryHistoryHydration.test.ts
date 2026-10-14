import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import type { RootFolder } from '@server/api/servarr/base';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import {
  IdentityResolutionState,
  LibraryMediaType,
  LibraryRemovalSource,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import { SourceCheckpoint } from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { loadCurrentViewingTargets } from '@server/lib/currentViewingTargets';
import {
  LibraryHistoryHydrationService,
  type LibraryHydrationDependencies,
} from '@server/lib/libraryHistoryHydration';
import libraryHydrationEpoch, {
  currentLibraryGeneration,
} from '@server/lib/libraryHydrationEpoch';
import type {
  JellyfinSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { In } from 'typeorm';

setupTestDb();

const root = (id: number, path: string): RootFolder => ({
  id,
  path,
  freeSpace: 1,
  totalSpace: 2,
  unmappedFolders: [],
});

const radarrServer = {
  id: 1,
  name: 'Radarr',
  hostname: 'radarr',
  port: 7878,
  apiKey: 'not-persisted',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeDirectory: '/media/movies',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
  minimumAvailability: 'released',
} as RadarrSettings;

const sonarrServer = {
  ...radarrServer,
  id: 2,
  name: 'Sonarr',
  hostname: 'sonarr',
  port: 8989,
  activeDirectory: '/media/shows',
  seriesType: 'standard',
  animeSeriesType: 'anime',
  enableSeasonFolders: true,
  monitorNewItems: 'all',
} as SonarrSettings;

const jellyfinSettings = {
  name: 'Jellyfin',
  ip: 'jellyfin',
  port: 8096,
  libraries: [{ id: 'library', name: 'Library', enabled: true, type: 'movie' }],
  serverId: 'jellyfin-server',
  apiKey: 'not-persisted',
} as JellyfinSettings;

const movie = (overrides: Partial<RadarrMovie> = {}): RadarrMovie =>
  ({
    id: 10,
    title: 'Exact Movie',
    year: 2025,
    isAvailable: true,
    monitored: true,
    tmdbId: 100,
    imdbId: 'tt0000100',
    titleSlug: 'exact-movie',
    folderName: 'Exact Movie (2025)',
    path: '/media/movies/Exact Movie (2025)',
    rootFolderPath: '/media/movies',
    profileId: 1,
    qualityProfileId: 1,
    added: '2025-01-01T00:00:00Z',
    hasFile: true,
    tags: [],
    movieFile: {
      id: 20,
      movieId: 10,
      relativePath: 'Exact Movie.mkv',
      size: 1_000,
      dateAdded: '2026-01-02T03:04:05Z',
      quality: { quality: { resolution: 2160 } },
      mediaInfo: {
        id: 20,
        audioBitrate: 1,
        audioChannels: 2,
        audioStreamCount: 1,
        videoBitDepth: 10,
        videoBitrate: 1,
        videoFps: 24,
      },
      qualityCutoffNotMet: false,
    },
    ...overrides,
  }) as RadarrMovie;

const show = (overrides: Partial<SonarrSeries> = {}): SonarrSeries =>
  ({
    id: 30,
    title: 'Exact Series',
    sortTitle: 'exact series',
    seasonCount: 2,
    status: 'continuing',
    overview: '',
    network: '',
    airTime: '',
    images: [],
    remotePoster: '',
    seasons: [
      { seasonNumber: 0, monitored: true },
      { seasonNumber: 1, monitored: true },
    ],
    year: 2024,
    path: '/media/shows/Exact Series',
    rootFolderPath: '/media/shows',
    profileId: 1,
    languageProfileId: 1,
    seasonFolder: true,
    monitored: true,
    monitorNewItems: 'all',
    useSceneNumbering: false,
    runtime: 45,
    tvdbId: 300,
    tvRageId: 0,
    tvMazeId: 0,
    firstAired: '2024-01-01',
    seriesType: 'standard',
    cleanTitle: 'exactseries',
    imdbId: 'tt0000300',
    titleSlug: 'exact-series',
    certification: '',
    genres: [],
    tags: [],
    added: '2024-01-01T00:00:00Z',
    ratings: { votes: 1, value: 8 },
    qualityProfileId: 1,
    statistics: {
      seasonCount: 2,
      episodeFileCount: 1,
      episodeCount: 4,
      totalEpisodeCount: 4,
      sizeOnDisk: 2_000,
      releaseGroups: [],
      percentOfEpisodes: 50,
    },
    ...overrides,
  }) as SonarrSeries;

const episodes: SonarrEpisode[] = [
  {
    id: 301,
    seriesId: 30,
    episodeFileId: 0,
    seasonNumber: 0,
    episodeNumber: 1,
    title: 'Special',
    airDate: '2024-01-01',
    airDateUtc: '2024-01-01T00:00:00Z',
    overview: '',
    hasFile: false,
    monitored: true,
    absoluteEpisodeNumber: 0,
    unverifiedSceneNumbering: false,
  },
  {
    id: 302,
    seriesId: 30,
    episodeFileId: 0,
    seasonNumber: 1,
    episodeNumber: 1,
    title: 'Future',
    airDate: '2030-01-01',
    airDateUtc: '2030-01-01T00:00:00Z',
    overview: '',
    hasFile: false,
    monitored: true,
    absoluteEpisodeNumber: 1,
    unverifiedSceneNumbering: false,
  },
  {
    id: 303,
    seriesId: 30,
    episodeFileId: 40,
    seasonNumber: 1,
    episodeNumber: 2,
    title: 'Part One',
    airDate: '2024-01-02',
    airDateUtc: '2024-01-02T00:00:00Z',
    overview: '',
    hasFile: true,
    monitored: true,
    absoluteEpisodeNumber: 2,
    tvdbId: 3002,
    unverifiedSceneNumbering: false,
  },
  {
    id: 304,
    seriesId: 30,
    episodeFileId: 40,
    seasonNumber: 1,
    episodeNumber: 3,
    title: 'Part Two',
    airDate: '2024-01-02',
    airDateUtc: '2024-01-02T00:00:00Z',
    overview: '',
    hasFile: true,
    monitored: true,
    absoluteEpisodeNumber: 3,
    tvdbId: 3003,
    unverifiedSceneNumbering: false,
  },
];

const episodeFiles: SonarrEpisodeFile[] = [
  {
    id: 40,
    seriesId: 30,
    seasonNumber: 1,
    relativePath: 'Season 01/S01E02-E03.mkv',
    size: 2_000,
    dateAdded: '2026-02-03T04:05:06Z',
    quality: { quality: { resolution: 1080 } },
  },
];

const jellyfinItems: JellyfinLibraryItemExtended[] = [
  {
    Id: 'jf-movie',
    Name: 'Exact Movie',
    Type: 'Movie',
    LocationType: 'FileSystem',
    HasSubtitles: false,
    MediaType: 'Video',
    ProviderIds: { Tmdb: '100', Imdb: 'tt0000100' },
    Path: '/library/movies/Exact Movie.mkv',
    DateCreated: '2026-01-02T03:05:00Z',
  },
  {
    Id: 'jf-series',
    Name: 'Exact Series',
    Type: 'Series',
    LocationType: 'FileSystem',
    HasSubtitles: false,
    MediaType: 'Video',
    ProviderIds: { Tvdb: '300' },
  },
  {
    Id: 'jf-episode',
    Name: 'Part One',
    Type: 'Episode',
    LocationType: 'FileSystem',
    HasSubtitles: false,
    MediaType: 'Video',
    ProviderIds: { Tvdb: '3002' },
    SeriesId: 'jf-series',
    ParentIndexNumber: 1,
    IndexNumber: 2,
  },
];

const dependencies = ({
  movies = [movie()],
  shows = [show()],
  sonarrEpisodes = episodes,
  files = episodeFiles,
  jellyfin = jellyfinItems,
  radarrFailure = false,
  sonarrFailure = false,
  metadataFailure = false,
  radarrPath = '/media/movies',
}: {
  movies?: RadarrMovie[];
  shows?: SonarrSeries[];
  sonarrEpisodes?: SonarrEpisode[];
  files?: SonarrEpisodeFile[];
  jellyfin?: JellyfinLibraryItemExtended[];
  radarrFailure?: boolean;
  sonarrFailure?: boolean;
  metadataFailure?: boolean;
  radarrPath?: string;
} = {}): LibraryHydrationDependencies => {
  let time = Date.parse('2026-10-01T00:00:00Z');
  return {
    radarrServers: () => [radarrServer],
    sonarrServers: () => [sonarrServer],
    jellyfinSettings: () => jellyfinSettings,
    createRadarrClient: () => ({
      getRootFolders: async () => {
        if (radarrFailure) throw new Error('temporary failure');
        return [root(6, radarrPath)];
      },
      getMovies: async () => {
        if (radarrFailure) throw new Error('temporary failure');
        return movies;
      },
    }),
    createSonarrClient: () => ({
      getRootFolders: async () => {
        if (sonarrFailure) throw new Error('temporary failure');
        return [root(1, '/media/shows')];
      },
      getSeries: async () => {
        if (sonarrFailure) throw new Error('temporary failure');
        return shows;
      },
      getEpisodes: async () => {
        if (sonarrFailure) throw new Error('temporary failure');
        return sonarrEpisodes;
      },
      getEpisodeFiles: async () => {
        if (sonarrFailure) throw new Error('temporary failure');
        return files;
      },
    }),
    createJellyfinContext: async () => ({
      client: { getAllItems: async () => jellyfin },
      libraries: [{ id: 'library', enabled: true }],
    }),
    createQueryMetadataClient: () => ({
      getMovieForScan: async ({ movieId }) => {
        if (metadataFailure) throw new Error('provider failure');
        return {
          id: movieId,
          title: movieId === 100 ? 'Exact Movie' : `English Movie ${movieId}`,
          release_date: '2025-01-01',
        };
      },
      getTvShowForScan: async ({ tvId }) => {
        if (metadataFailure) throw new Error('provider failure');
        return {
          id: tvId,
          name: tvId === 999 ? 'Exact Series' : `English Series ${tvId}`,
          first_air_date: '2024-01-01',
        };
      },
      getShowByTvdbIdForScan: async ({ tvdbId }) => {
        if (metadataFailure) throw new Error('provider failure');
        return {
          id: tvdbId === 300 ? 999 : tvdbId,
          name: tvdbId === 300 ? 'Exact Series' : `English Series ${tvdbId}`,
          first_air_date: '2024-01-01',
        };
      },
      resolveImdbIdForScan: async ({ imdbId }) => Number(imdbId.slice(2)),
    }),
    now: () => new Date((time += 1_000)),
  };
};

describe('Current Library Hydration', () => {
  it('tracks scoped Jellyfin Episode aliases by successful Library generation', async () => {
    const firstId = '11111111111111111111111111111111';
    const replacementId = '22222222222222222222222222222222';
    const withEpisodeId = (id: string) =>
      jellyfinItems.map((item) =>
        item.Type === 'Episode' ? { ...item, Id: id } : item
      );

    await new LibraryHistoryHydrationService(
      dependencies({ jellyfin: withEpisodeId(firstId) })
    ).run();
    const firstCheckpoint = await getRepository(
      SourceCheckpoint
    ).findOneByOrFail({
      source: 'jellyfin',
      sourceScope: jellyfinSettings.serverId,
      stage: 'current-library',
    });
    const firstIdentity = await getRepository(
      CanonicalEpisodeIdentity
    ).findOneByOrFail({
      provider: 'jellyfin',
      sourceScope: jellyfinSettings.serverId,
      value: firstId,
    });
    assert.equal(
      firstIdentity.lastSeenSourceGeneration,
      firstCheckpoint.sourceGeneration
    );

    await new LibraryHistoryHydrationService(
      dependencies({ jellyfin: withEpisodeId(replacementId) })
    ).run();
    const secondCheckpoint = await getRepository(
      SourceCheckpoint
    ).findOneByOrFail({
      source: 'jellyfin',
      sourceScope: jellyfinSettings.serverId,
      stage: 'current-library',
    });
    const aliases = await getRepository(CanonicalEpisodeIdentity).find({
      where: {
        provider: 'jellyfin',
        sourceScope: jellyfinSettings.serverId,
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    assert.notEqual(
      secondCheckpoint.sourceGeneration,
      firstCheckpoint.sourceGeneration
    );
    assert.equal(aliases.length, 2);
    assert.equal(aliases[0].value, firstId);
    assert.equal(
      aliases[0].lastSeenSourceGeneration,
      firstCheckpoint.sourceGeneration
    );
    assert.equal(aliases[1].value, replacementId);
    assert.equal(
      aliases[1].lastSeenSourceGeneration,
      secondCheckpoint.sourceGeneration
    );
    assert.deepEqual(
      (await loadCurrentViewingTargets(jellyfinSettings.serverId))
        .filter(({ mediaType }) => mediaType === 'episode')
        .map(({ sourceItemId }) => sourceItemId),
      [replacementId]
    );
  });

  it('hydrates roots, exact media, Specials, future episodes, distinct files, Jellyfin aliases, Seerr links, and Requests idempotently', async () => {
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    const currentMovie = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 100,
        status: MediaStatus.AVAILABLE,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        media: currentMovie,
        requestedBy: admin,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.DECLINED,
        is4k: false,
      })
    );
    const currentSeries = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.TV,
        tmdbId: 999,
        tvdbId: 300,
        status: MediaStatus.PENDING,
      })
    );

    const service = new LibraryHistoryHydrationService(dependencies());
    const first = await service.run();
    assert.equal(first.complete, true);
    assert.equal(first.queryMetadata.uniqueProviderIdentities, 2);
    assert.equal(first.queryMetadata.enriched, 2);
    assert.equal(first.queryMetadata.concurrency, 4);
    assert.equal(await getRepository(StorageRoot).count(), 2);
    assert.equal(await getRepository(CanonicalMedia).count(), 2);
    assert.equal(await getRepository(CanonicalSeason).count(), 2);
    assert.equal(await getRepository(CanonicalEpisode).count(), 4);
    assert.equal(await getRepository(LibraryFile).count(), 2);
    assert.deepEqual(
      (
        await getRepository(LibraryFile).find({
          order: { sourceSystem: 'ASC' },
        })
      ).map(({ sourceSystem, resolution }) => [sourceSystem, resolution]),
      [
        ['radarr', 2160],
        ['sonarr', 1080],
      ]
    );
    assert.equal(await getRepository(LibraryFileEpisode).count(), 2);
    assert.equal(
      await getRepository(CanonicalEpisode).countBy({ isSpecial: true }),
      1
    );
    assert.equal(
      (
        await getRepository(CanonicalEpisode).findOneByOrFail({
          episodeNumber: 1,
          isSpecial: false,
        })
      ).airDate,
      '2030-01-01'
    );
    const movieCanonical = await getRepository(CanonicalMedia).findOneByOrFail({
      mediaType: LibraryMediaType.MOVIE,
    });
    const seriesCanonical = await getRepository(CanonicalMedia).findOneByOrFail(
      {
        mediaType: LibraryMediaType.SERIES,
      }
    );
    assert.equal(movieCanonical.currentMediaId, currentMovie.id);
    assert.equal(seriesCanonical.currentMediaId, currentSeries.id);
    assert.equal(movieCanonical.titleSnapshot, 'Exact Movie');
    assert.equal(movieCanonical.year, 2025);
    assert.equal(seriesCanonical.titleSnapshot, 'Exact Series');
    assert.equal(seriesCanonical.year, 2024);
    assert.ok(
      await getRepository(CanonicalMediaIdentity).findOneBy({
        canonicalMediaId: seriesCanonical.id,
        provider: 'tmdb',
        sourceScope: '',
        value: '999',
      })
    );
    assert.equal(currentMovie.status, MediaStatus.AVAILABLE);
    assert.equal(currentSeries.status, MediaStatus.PENDING);
    assert.equal(
      first.sources.find(({ source }) => source === 'seerr')?.requestsLinked,
      1
    );
    assert.equal(
      first.sources.find(({ source }) => source === 'seerr')?.requestsInspected,
      1
    );
    assert.equal(
      first.sources.find(({ source }) => source === 'seerr')
        ?.requestsUnresolved,
      0
    );
    const moviePresence = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'radarr',
      isCurrent: true,
    });
    assert.equal(moviePresence.addedAtSource, 'radarr-movie-file-date-added');
    assert.equal(
      moviePresence.addedAt?.toISOString(),
      '2026-01-02T03:04:05.000Z'
    );
    assert.equal(moviePresence.jellyfinVisible, true);

    const structuralCounts = async () => ({
      roots: await getRepository(StorageRoot).count(),
      canonical: await getRepository(CanonicalMedia).count(),
      seasons: await getRepository(CanonicalSeason).count(),
      episodes: await getRepository(CanonicalEpisode).count(),
      presences: await getRepository(LibraryPresence).count(),
      files: await getRepository(LibraryFile).count(),
      aliases: await getRepository(CanonicalMediaIdentity).count(),
    });
    const before = await structuralCounts();
    const second = await service.run();
    assert.equal(second.complete, true);
    assert.deepEqual(await structuralCounts(), before);
  });

  it('preserves a confirmed resolution when a later response omits file quality', async () => {
    await new LibraryHistoryHydrationService(dependencies()).run();
    const withoutQuality = movie();
    assert.ok(withoutQuality.movieFile);
    withoutQuality.movieFile = {
      ...withoutQuality.movieFile,
      quality: undefined,
    };

    await new LibraryHistoryHydrationService(
      dependencies({ movies: [withoutQuality] })
    ).run();

    const file = await getRepository(LibraryFile).findOneByOrFail({
      sourceSystem: 'radarr',
      sourceFileId: 'movie-file:20',
      isCurrent: true,
    });
    assert.equal(file.resolution, 2160);
  });

  it('keeps deterministic English query caches independent of source title and provider failure', async () => {
    const service = new LibraryHistoryHydrationService(dependencies());
    await service.run();
    const movieCanonical = await getRepository(CanonicalMedia).findOneByOrFail({
      mediaType: LibraryMediaType.MOVIE,
    });
    const seriesCanonical = await getRepository(CanonicalMedia).findOneByOrFail(
      { mediaType: LibraryMediaType.SERIES }
    );

    const localized = jellyfinItems.map((item) =>
      item.Type === 'Movie'
        ? { ...item, Name: 'Ștergătorul', ProductionYear: 1996 }
        : item.Type === 'Series'
          ? { ...item, Name: '本地化系列', ProductionYear: 1999 }
          : item
    );
    const failed = await new LibraryHistoryHydrationService(
      dependencies({ jellyfin: localized, metadataFailure: true })
    ).run();
    assert.equal(failed.queryMetadata.failures, 2);
    assert.equal(
      (
        await getRepository(CanonicalMedia).findOneByOrFail({
          id: movieCanonical.id,
        })
      ).titleSnapshot,
      'Exact Movie'
    );
    assert.equal(
      (
        await getRepository(CanonicalMedia).findOneByOrFail({
          id: seriesCanonical.id,
        })
      ).titleSnapshot,
      'Exact Series'
    );
  });

  it('updates a root path without duplication and closes only after complete authoritative absence', async () => {
    await new LibraryHistoryHydrationService(dependencies()).run();
    const namedRoot = await getRepository(StorageRoot).findOneByOrFail({
      servarrType: 'radarr',
      serviceId: 1,
    });
    namedRoot.displayName = 'Movies Overflow';
    namedRoot.isAnimation = true;
    namedRoot.color = '#fb923c';
    await getRepository(StorageRoot).save(namedRoot);
    await new LibraryHistoryHydrationService(
      dependencies({ radarrPath: '/volume4/media-movies/movies' })
    ).run();
    assert.equal(
      await getRepository(StorageRoot).countBy({
        servarrType: 'radarr',
        serviceId: 1,
      }),
      1
    );
    const updatedRoot = await getRepository(StorageRoot).findOneByOrFail({
      servarrType: 'radarr',
      serviceId: 1,
    });
    assert.equal(updatedRoot.pathSnapshot, '/volume4/media-movies/movies');
    assert.equal(updatedRoot.displayName, 'Movies Overflow');
    assert.equal(updatedRoot.isAnimation, true);
    assert.equal(updatedRoot.color, '#fb923c');

    await new LibraryHistoryHydrationService(
      dependencies({ movies: [] })
    ).run();
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'radarr',
        isCurrent: true,
      }),
      0
    );
    assert.equal(
      await getRepository(LibraryFile).countBy({
        sourceSystem: 'radarr',
        isCurrent: true,
      }),
      0
    );
    assert.equal(
      await getRepository(LibraryPresence).countBy({ sourceSystem: 'radarr' }),
      1
    );
  });

  it('opens a new presence generation when the same scoped source identity returns', async () => {
    await new LibraryHistoryHydrationService(dependencies()).run();
    const first = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
      sourceItemId: 'movie:10',
      isCurrent: true,
    });
    assert.equal(first.sourceGeneration, '1');

    await new LibraryHistoryHydrationService(
      dependencies({ movies: [] })
    ).run();
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        sourceItemId: 'movie:10',
        isCurrent: true,
      }),
      0
    );

    await new LibraryHistoryHydrationService(dependencies()).run();
    const generations = await getRepository(LibraryPresence).find({
      where: {
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        sourceItemId: 'movie:10',
      },
      order: { id: 'ASC' },
    });
    assert.deepEqual(
      generations.map((presence) => [
        presence.sourceGeneration,
        presence.isCurrent,
        presence.canonicalMediaId,
      ]),
      [
        ['1', false, first.canonicalMediaId],
        ['2', true, first.canonicalMediaId],
      ]
    );
    assert.ok(generations[0].removedAt);
    assert.equal(generations[0].removalSource, LibraryRemovalSource.EXTERNAL);
    assert.equal(generations[1].removedAt, null);
  });

  it('does not overwrite application-captured provenance during later authoritative absence', async () => {
    await new LibraryHistoryHydrationService(dependencies()).run();
    const radarrPresence = await getRepository(LibraryPresence).findOneByOrFail(
      {
        sourceSystem: 'radarr',
        isCurrent: true,
      }
    );
    const radarrFile = await getRepository(LibraryFile).findOneByOrFail({
      libraryPresenceId: radarrPresence.id,
      isCurrent: true,
    });
    const jellyfinPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      sourceSystem: 'jellyfin',
      sourceItemId: 'movie:jf-movie',
      isCurrent: true,
    });
    const removedAt = new Date('2026-10-01T12:00:00.000Z');
    Object.assign(radarrPresence, {
      isCurrent: false,
      removedAt,
      removalSource: LibraryRemovalSource.MANUAL,
    });
    Object.assign(radarrFile, {
      isCurrent: false,
      removedAt,
      removalSource: LibraryRemovalSource.MANUAL,
    });
    Object.assign(jellyfinPresence, {
      isCurrent: false,
      removedAt,
      removalSource: LibraryRemovalSource.SCHEDULED,
    });
    await getRepository(LibraryPresence).save([
      radarrPresence,
      jellyfinPresence,
    ]);
    await getRepository(LibraryFile).save(radarrFile);

    await new LibraryHistoryHydrationService(
      dependencies({ movies: [], jellyfin: jellyfinItems.slice(1) })
    ).run();

    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: radarrPresence.id,
        })
      ).removalSource,
      LibraryRemovalSource.MANUAL
    );
    assert.equal(
      (await getRepository(LibraryFile).findOneByOrFail({ id: radarrFile.id }))
        .removalSource,
      LibraryRemovalSource.MANUAL
    );
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: jellyfinPresence.id,
        })
      ).removalSource,
      LibraryRemovalSource.SCHEDULED
    );
  });

  it('closes Sonarr state only after a complete empty enumeration', async () => {
    await new LibraryHistoryHydrationService(dependencies()).run();
    const currentFile = await getRepository(LibraryFile).findOneByOrFail({
      sourceSystem: 'sonarr',
      isCurrent: true,
    });
    const linkedEpisodeIds = (
      await getRepository(LibraryFileEpisode).findBy({
        libraryFileId: currentFile.id,
      })
    ).map((link) => link.canonicalEpisodeId);
    assert.ok(linkedEpisodeIds.length > 0);
    await new LibraryHistoryHydrationService(
      dependencies({ shows: [], sonarrEpisodes: [], files: [] })
    ).run();
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'sonarr',
        isCurrent: true,
      }),
      0
    );
    assert.equal(
      await getRepository(LibraryFile).countBy({
        sourceSystem: 'sonarr',
        isCurrent: true,
      }),
      0
    );
    const closedFile = await getRepository(LibraryFile).findOneByOrFail({
      id: currentFile.id,
    });
    assert.equal(closedFile.isCurrent, false);
    assert.ok(closedFile.removedAt);
    assert.equal(closedFile.removalSource, LibraryRemovalSource.EXTERNAL);
    assert.equal(closedFile.sizeBytes, currentFile.sizeBytes);
    assert.deepEqual(
      (
        await getRepository(LibraryFileEpisode).findBy({
          libraryFileId: currentFile.id,
        })
      ).map((link) => link.canonicalEpisodeId),
      linkedEpisodeIds
    );
    assert.equal(
      await getRepository(CanonicalEpisode).countBy({
        id: In(linkedEpisodeIds),
      }),
      linkedEpisodeIds.length
    );
  });

  it('retains historical Episode denominators through partial and entire Series removal', async () => {
    const s1 = {
      ...episodes[2],
      id: 501,
      episodeFileId: 51,
      seasonNumber: 1,
      episodeNumber: 1,
      tvdbId: 5001,
    } as SonarrEpisode;
    const s2 = {
      ...episodes[2],
      id: 502,
      episodeFileId: 52,
      seasonNumber: 2,
      episodeNumber: 1,
      tvdbId: 5002,
    } as SonarrEpisode;
    const special = {
      ...episodes[2],
      id: 500,
      episodeFileId: 50,
      seasonNumber: 0,
      episodeNumber: 1,
      tvdbId: 5000,
    } as SonarrEpisode;
    const files = [
      {
        ...episodeFiles[0],
        id: 50,
        seasonNumber: 0,
        relativePath: 'Specials/S00E01.mkv',
        size: 500,
      },
      {
        ...episodeFiles[0],
        id: 51,
        seasonNumber: 1,
        relativePath: 'Season 01/S01E01.mkv',
        size: 1_000,
      },
      {
        ...episodeFiles[0],
        id: 52,
        seasonNumber: 2,
        relativePath: 'Season 02/S02E01.mkv',
        size: 2_000,
      },
    ] as SonarrEpisodeFile[];
    const series = show({
      seasons: [
        { seasonNumber: 0, monitored: true },
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: true },
      ],
    });
    await new LibraryHistoryHydrationService(
      dependencies({
        shows: [series],
        sonarrEpisodes: [special, s1, s2],
        files,
      })
    ).run();
    const canonicalSeries = await getRepository(CanonicalMedia).findOneByOrFail(
      {
        mediaType: LibraryMediaType.SERIES,
      }
    );
    const seasons = await getRepository(CanonicalSeason).findBy({
      seriesId: canonicalSeries.id,
    });
    const regularSeasons = seasons.filter((season) => season.seasonNumber > 0);
    const regularEpisodes = await getRepository(CanonicalEpisode).findBy({
      seasonId: In(regularSeasons.map((season) => season.id)),
    });
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: jellyfinSettings.serverId,
        sourceUserId: 'history-viewer',
        userId: 1,
      })
    );
    await getRepository(ViewingEvidence).save([
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: jellyfinSettings.serverId,
        sourceClass: 'current-user-data',
        sourceActivityId: 'history-viewer:s1:played',
        viewerId: viewer.id,
        canonicalMediaId: canonicalSeries.id,
        canonicalEpisodeId: regularEpisodes[0].id,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      }),
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: jellyfinSettings.serverId,
        sourceClass: 'current-user-data',
        sourceActivityId: 'history-viewer:s2:partial',
        viewerId: viewer.id,
        canonicalMediaId: canonicalSeries.id,
        canonicalEpisodeId: regularEpisodes[1].id,
        progressBasisPoints: 4200,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      }),
    ]);

    await new LibraryHistoryHydrationService(
      dependencies({
        shows: [series],
        sonarrEpisodes: [
          { ...special, hasFile: false, episodeFileId: 0 },
          { ...s1, hasFile: false, episodeFileId: 0 },
          s2,
        ],
        files: [files[2]],
      })
    ).run();
    const s1File = await getRepository(LibraryFile).findOneByOrFail({
      sourceSystem: 'sonarr',
      sourceFileId: 'episode-file:51',
    });
    assert.equal(s1File.isCurrent, false);
    assert.ok(s1File.removedAt);
    assert.equal(
      await getRepository(LibraryFileEpisode).countBy({
        libraryFileId: s1File.id,
      }),
      1
    );
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'sonarr',
        isCurrent: true,
        canonicalMediaId: canonicalSeries.id,
      }),
      1
    );

    await new LibraryHistoryHydrationService(
      dependencies({
        shows: [],
        sonarrEpisodes: [],
        files: [],
        jellyfin: [],
      })
    ).run();
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'sonarr',
        isCurrent: true,
        canonicalMediaId: canonicalSeries.id,
      }),
      0
    );
    assert.equal(
      await getRepository(LibraryFile).countBy({
        sourceSystem: 'sonarr',
        isCurrent: true,
      }),
      0
    );
    assert.equal(await getRepository(LibraryFileEpisode).count(), 3);
    assert.equal(await getRepository(ViewingEvidence).count(), 2);
    const historicalRows = (await getRepository(LibraryFileEpisode)
      .createQueryBuilder('link')
      .innerJoin('link.libraryFile', 'file')
      .innerJoin('file.libraryPresence', 'presence')
      .innerJoin('link.canonicalEpisode', 'episode')
      .innerJoin('episode.season', 'season')
      .select('DISTINCT episode.id', 'episodeId')
      .where('presence.canonicalMediaId = :seriesId', {
        seriesId: canonicalSeries.id,
      })
      .andWhere('season.seasonNumber > 0')
      .andWhere('episode.isSpecial = :special', { special: false })
      .getRawMany()) as { episodeId: number | string }[];
    assert.equal(historicalRows.length, 2);
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        canonicalMediaId: canonicalSeries.id,
        canonicalEpisodeId: In(
          historicalRows.map((row) => Number(row.episodeId))
        ),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      }),
      1
    );
  });

  it('preserves last-good state and checkpoints when enumeration is incomplete', async () => {
    await new LibraryHistoryHydrationService(dependencies()).run();
    const failed = await new LibraryHistoryHydrationService(
      dependencies({ radarrFailure: true })
    ).run();
    assert.equal(failed.complete, false);
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'radarr',
        isCurrent: true,
      }),
      1
    );
    assert.equal(
      await getRepository(LibraryFile).countBy({
        sourceSystem: 'radarr',
        isCurrent: true,
      }),
      1
    );
    const checkpoint = await getRepository(SourceCheckpoint).findOneByOrFail({
      source: 'radarr',
      sourceScope: 'service:1',
      stage: 'current-library',
    });
    assert.ok(checkpoint.lastSuccessfulAt);

    const failedSonarr = await new LibraryHistoryHydrationService(
      dependencies({ sonarrFailure: true })
    ).run();
    assert.equal(failedSonarr.complete, false);
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'sonarr',
        isCurrent: true,
      }),
      1
    );
    assert.equal(
      await getRepository(LibraryFile).countBy({
        sourceSystem: 'sonarr',
        isCurrent: true,
      }),
      1
    );
  });

  it('keeps managed-without-file truth separate from physical files and Jellyfin absence', async () => {
    const noFile = movie({ hasFile: false, movieFile: undefined });
    await new LibraryHistoryHydrationService(
      dependencies({ movies: [noFile], jellyfin: [] })
    ).run();
    const presence = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'radarr',
      isCurrent: true,
    });
    assert.equal(presence.servarrManaged, true);
    assert.equal(presence.servarrHasFile, false);
    assert.equal(presence.jellyfinVisible, false);
    assert.equal(
      await getRepository(LibraryFile).countBy({ sourceSystem: 'radarr' }),
      0
    );

    await new LibraryHistoryHydrationService(
      dependencies({ jellyfin: [] })
    ).run();
    const physicalPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      sourceSystem: 'radarr',
      isCurrent: true,
      servarrHasFile: true,
    });
    assert.equal(physicalPresence.jellyfinVisible, false);
    assert.equal(physicalPresence.isCurrent, true);
  });

  it('does not title-match conflicting exact Monster identities', async () => {
    await new LibraryHistoryHydrationService(
      dependencies({
        movies: [
          movie({
            title: 'Monster',
            tmdbId: 1_050_035,
            imdbId: '',
            movieFile: undefined,
            hasFile: false,
          }),
        ],
        jellyfin: [
          {
            ...jellyfinItems[0],
            Id: 'monster-jellyfin',
            Name: 'Monster',
            ProviderIds: { Tmdb: '1203484' },
          },
        ],
      })
    ).run();
    assert.equal(
      await getRepository(CanonicalMedia).countBy({
        mediaType: LibraryMediaType.MOVIE,
      }),
      2
    );
  });

  it('converges current projection after an upstream identity correction without fuzzy matching', async () => {
    const radarrMovie = movie({
      id: 729,
      title: 'Good News',
      tmdbId: 1_296_404,
      imdbId: 'tt33550069',
    });
    const wrongJellyfin = {
      ...jellyfinItems[0],
      Id: 'good-news-before-correction',
      Name: 'Good News',
      ProviderIds: { Tmdb: '1218681', Imdb: 'tt31307458' },
    };
    await new LibraryHistoryHydrationService(
      dependencies({
        movies: [radarrMovie],
        shows: [],
        sonarrEpisodes: [],
        files: [],
        jellyfin: [wrongJellyfin],
      })
    ).run();
    assert.equal(
      new Set(
        (await getRepository(LibraryPresence).findBy({ isCurrent: true })).map(
          (presence) => presence.canonicalMediaId
        )
      ).size,
      2
    );

    await new LibraryHistoryHydrationService(
      dependencies({
        movies: [radarrMovie],
        shows: [],
        sonarrEpisodes: [],
        files: [],
        jellyfin: [
          {
            ...wrongJellyfin,
            Id: 'good-news-after-correction',
            ProviderIds: { Tmdb: '1296404', Imdb: 'tt33550069' },
          },
        ],
      })
    ).run();

    const currentPresences = await getRepository(LibraryPresence).findBy({
      isCurrent: true,
    });
    assert.equal(
      new Set(currentPresences.map(({ canonicalMediaId }) => canonicalMediaId))
        .size,
      1
    );
    assert.deepEqual(
      new Set(currentPresences.map(({ sourceSystem }) => sourceSystem)),
      new Set(['radarr', 'jellyfin'])
    );
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'jellyfin',
        sourceItemId: 'movie:good-news-before-correction',
        isCurrent: true,
      }),
      0
    );
  });

  it('reuses one canonical across a changed Jellyfin ID with the same exact provider identity', async () => {
    const firstId = 'provider-stable-first-id';
    const secondId = 'provider-stable-second-id';
    const item = {
      ...jellyfinItems[0],
      Id: firstId,
      ProviderIds: { Tmdb: '100', Imdb: 'tt0000100' },
    };
    const run = (jellyfin: JellyfinLibraryItemExtended[]) =>
      new LibraryHistoryHydrationService(dependencies({ jellyfin })).run();
    await run([item]);
    const first = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'jellyfin',
      sourceItemId: `movie:${firstId}`,
    });
    await run([]);
    assert.equal(
      (await getRepository(LibraryPresence).findOneByOrFail({ id: first.id }))
        .isCurrent,
      false
    );
    await run([{ ...item, Id: secondId }]);
    const second = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'jellyfin',
      sourceItemId: `movie:${secondId}`,
      isCurrent: true,
    });
    assert.equal(second.canonicalMediaId, first.canonicalMediaId);
    assert.equal(
      await getRepository(CanonicalMediaIdentity).countBy({
        canonicalMediaId: first.canonicalMediaId,
        provider: 'tmdb',
        sourceScope: '',
        value: '100',
      }),
      1
    );
  });

  it('reassigns a stable scoped source alias after an exact provider identity correction', async () => {
    const radarrMovie = movie({
      id: 729,
      title: 'Good News',
      tmdbId: 1_296_404,
      imdbId: 'tt33550069',
    });
    const jellyfinId = 'stable-good-news-item';
    const wrongJellyfin = {
      ...jellyfinItems[0],
      Id: jellyfinId,
      Name: 'Good News',
      ProviderIds: { Tmdb: '1218681', Imdb: 'tt31307458' },
    };
    const run = (item = wrongJellyfin) =>
      new LibraryHistoryHydrationService(
        dependencies({
          movies: [radarrMovie],
          shows: [],
          sonarrEpisodes: [],
          files: [],
          jellyfin: [item],
        })
      ).run();

    await run();
    const staleJellyfinPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      sourceSystem: 'jellyfin',
      sourceItemId: `movie:${jellyfinId}`,
      isCurrent: true,
    });
    const staleCanonicalId = staleJellyfinPresence.canonicalMediaId;

    await new LibraryHistoryHydrationService(
      dependencies({
        movies: [radarrMovie],
        shows: [],
        sonarrEpisodes: [],
        files: [],
        jellyfin: [],
      })
    ).run();
    const closedPresence = await getRepository(LibraryPresence).findOneByOrFail(
      {
        id: staleJellyfinPresence.id,
      }
    );
    assert.equal(closedPresence.isCurrent, false);
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: jellyfinSettings.serverId,
        sourceUserId: 'good-news-viewer',
        userId: 1,
      })
    );
    const staleState = await getRepository(CurrentViewingState).save(
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: jellyfinSettings.serverId,
        sourceItemId: jellyfinId,
        mediaType: 'movie',
        canonicalMediaId: staleCanonicalId,
        played: true,
        playCount: 1,
        observedAt: new Date('2026-10-01T00:00:00.000Z'),
      })
    );
    const staleEvidence = await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: jellyfinSettings.serverId,
        sourceClass: 'current-user-data',
        sourceActivityId: 'good-news-viewer:stable-good-news-item:played',
        sourceUserId: 'good-news-viewer',
        sourceItemId: jellyfinId,
        viewerId: viewer.id,
        canonicalMediaId: staleCanonicalId,
      })
    );

    await run({
      ...wrongJellyfin,
      ProviderIds: { Tmdb: '1296404', Imdb: 'tt33550069' },
    });

    const correctIdentity = await getRepository(
      CanonicalMediaIdentity
    ).findOneByOrFail({
      provider: 'tmdb',
      sourceScope: '',
      mediaType: LibraryMediaType.MOVIE,
      value: '1296404',
    });
    const correctedPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      sourceSystem: 'jellyfin',
      sourceItemId: `movie:${jellyfinId}`,
      isCurrent: true,
    });
    assert.notEqual(correctedPresence.id, staleJellyfinPresence.id);
    assert.equal(correctedPresence.sourceGeneration, '2');
    assert.equal(
      correctedPresence.canonicalMediaId,
      correctIdentity.canonicalMediaId
    );
    assert.notEqual(correctedPresence.canonicalMediaId, staleCanonicalId);
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: staleJellyfinPresence.id,
        })
      ).canonicalMediaId,
      correctIdentity.canonicalMediaId
    );
    assert.equal(
      (
        await getRepository(CurrentViewingState).findOneByOrFail({
          id: staleState.id,
        })
      ).canonicalMediaId,
      correctIdentity.canonicalMediaId
    );
    assert.equal(
      (
        await getRepository(ViewingEvidence).findOneByOrFail({
          id: staleEvidence.id,
        })
      ).canonicalMediaId,
      correctIdentity.canonicalMediaId
    );
    assert.equal(
      (
        await getRepository(CanonicalMediaIdentity).findOneByOrFail({
          provider: 'jellyfin',
          sourceScope: jellyfinSettings.serverId,
          mediaType: LibraryMediaType.MOVIE,
          value: jellyfinId,
        })
      ).canonicalMediaId,
      correctIdentity.canonicalMediaId
    );
    assert.ok(
      await getRepository(CanonicalMediaIdentity).findOneBy({
        canonicalMediaId: staleCanonicalId,
        provider: 'tmdb',
        sourceScope: '',
        mediaType: LibraryMediaType.MOVIE,
        value: '1218681',
      })
    );

    closedPresence.canonicalMediaId = staleCanonicalId;
    staleState.canonicalMediaId = staleCanonicalId;
    staleEvidence.canonicalMediaId = staleCanonicalId;
    await getRepository(LibraryPresence).save(closedPresence);
    await getRepository(CurrentViewingState).save(staleState);
    await getRepository(ViewingEvidence).save(staleEvidence);

    await run({
      ...wrongJellyfin,
      ProviderIds: { Tmdb: '1296404', Imdb: 'tt33550069' },
    });
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: closedPresence.id,
        })
      ).canonicalMediaId,
      correctIdentity.canonicalMediaId
    );
    assert.equal(
      (
        await getRepository(CurrentViewingState).findOneByOrFail({
          id: staleState.id,
        })
      ).canonicalMediaId,
      correctIdentity.canonicalMediaId
    );
    assert.equal(
      (
        await getRepository(ViewingEvidence).findOneByOrFail({
          id: staleEvidence.id,
        })
      ).canonicalMediaId,
      correctIdentity.canonicalMediaId
    );
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'jellyfin',
        sourceItemId: `movie:${jellyfinId}`,
        isCurrent: true,
      }),
      1
    );
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'jellyfin',
        sourceItemId: `movie:${jellyfinId}`,
      }),
      2
    );
  });

  it('leaves incompatible exact Seerr identity unlinked and preserves status', async () => {
    const first = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'First exact identity',
      })
    );
    const second = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Second exact identity',
      })
    );
    await getRepository(CanonicalMediaIdentity).save([
      new CanonicalMediaIdentity({
        canonicalMediaId: first.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        value: '700',
      }),
      new CanonicalMediaIdentity({
        canonicalMediaId: second.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'imdb',
        value: 'tt0000700',
      }),
    ]);
    const media = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 700,
        imdbId: 'tt0000700',
        status: MediaStatus.PROCESSING,
      })
    );

    const result = await new LibraryHistoryHydrationService(
      dependencies({
        movies: [],
        shows: [],
        sonarrEpisodes: [],
        files: [],
        jellyfin: [],
      })
    ).run();
    const seerr = result.sources.find(({ source }) => source === 'seerr');
    assert.equal(seerr?.mediaLinksConflicting, 1);
    assert.equal(
      (await getRepository(CanonicalMedia).findOneByOrFail({ id: first.id }))
        .currentMediaId,
      null
    );
    assert.equal(
      (await getRepository(CanonicalMedia).findOneByOrFail({ id: second.id }))
        .currentMediaId,
      null
    );
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ id: media.id })).status,
      MediaStatus.PROCESSING
    );
  });

  it('does not attach a Jellyfin Episode alias when exact provider identity conflicts', async () => {
    const unrelatedSeries = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Unrelated',
      })
    );
    const unrelatedSeason = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: unrelatedSeries.id, seasonNumber: 1 })
    );
    const unrelatedEpisode = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: unrelatedSeason.id,
        episodeNumber: 99,
      })
    );
    await getRepository(CanonicalEpisodeIdentity).save(
      new CanonicalEpisodeIdentity({
        canonicalEpisodeId: unrelatedEpisode.id,
        provider: 'tvdb',
        value: '3002',
      })
    );

    const result = await new LibraryHistoryHydrationService(
      dependencies()
    ).run();
    const jellyfin = result.sources.find(({ source }) => source === 'jellyfin');
    assert.ok((jellyfin?.conflicts ?? 0) > 0);
    assert.equal(
      await getRepository(CanonicalEpisodeIdentity).countBy({
        provider: 'jellyfin',
        sourceScope: 'jellyfin-server',
        value: 'jf-episode',
      }),
      0
    );
  });

  it('leaves existing viewing evidence untouched', async () => {
    await new LibraryHistoryHydrationService(dependencies()).run();
    const canonical = await getRepository(CanonicalMedia).findOneByOrFail({
      mediaType: LibraryMediaType.MOVIE,
    });
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'fixture',
        sourceScope: 'test',
        sourceClass: 'historical',
        sourceActivityId: 'activity',
        canonicalMediaId: canonical.id,
      })
    );
    await new LibraryHistoryHydrationService(dependencies()).run();
    assert.equal(await getRepository(ViewingEvidence).count(), 1);
  });

  it('coalesces overlapping invocations into one single-flight run', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const deps = dependencies();
    const originalFactory = deps.createRadarrClient;
    deps.createRadarrClient = (server) => {
      const client = originalFactory(server);
      return {
        ...client,
        getMovies: async () => {
          calls++;
          await blocked;
          return client.getMovies();
        },
      };
    };
    const service = new LibraryHistoryHydrationService(deps);
    const first = service.run();
    const second = service.run();
    assert.strictEqual(first, second);
    release?.();
    await first;
    assert.equal(calls, 1);
  });

  it('rejects a stale Servarr snapshot after fenced removal and accepts a newer observation', async () => {
    const initialResult = await new LibraryHistoryHydrationService(
      dependencies()
    ).run();
    assert.equal(
      initialResult.sources.find(({ source }) => source === 'radarr')?.complete,
      true,
      JSON.stringify(initialResult.sources)
    );
    const originalPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
      isCurrent: true,
    });

    let snapshotRead!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      snapshotRead = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const staleDependencies = dependencies();
    const createRadarrClient = staleDependencies.createRadarrClient;
    staleDependencies.createRadarrClient = (server) => {
      const client = createRadarrClient(server);
      return {
        ...client,
        getMovies: async () => {
          snapshotRead();
          await snapshotGate;
          return client.getMovies();
        },
      };
    };

    const staleRun = new LibraryHistoryHydrationService(
      staleDependencies
    ).run();
    await snapshotStarted;
    await dataSource.transaction('SERIALIZABLE', async (manager) => {
      await currentLibraryGeneration.advance(manager);
      await libraryHydrationEpoch.advance(manager, 'radarr', 'service:1');
      const presence = await manager
        .getRepository(LibraryPresence)
        .findOneByOrFail({ id: originalPresence.id });
      presence.isCurrent = false;
      presence.servarrHasFile = false;
      presence.removedAt = new Date('2026-10-02T00:00:00.000Z');
      presence.removalSource = LibraryRemovalSource.MANUAL;
      await manager.getRepository(LibraryPresence).save(presence);
      const files = await manager.getRepository(LibraryFile).findBy({
        libraryPresenceId: presence.id,
        isCurrent: true,
      });
      for (const file of files) {
        file.isCurrent = false;
        file.removedAt = presence.removedAt;
        file.removalSource = LibraryRemovalSource.MANUAL;
      }
      await manager.getRepository(LibraryFile).save(files);
    });
    releaseSnapshot();

    const staleResult = await staleRun;
    assert.equal(
      staleResult.sources.find(({ source }) => source === 'radarr')?.complete,
      false
    );
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        isCurrent: true,
      }),
      0
    );

    const freshResult = await new LibraryHistoryHydrationService(
      dependencies()
    ).run();
    assert.equal(
      freshResult.sources.find(({ source }) => source === 'radarr')?.complete,
      true
    );
    const replacement = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
      isCurrent: true,
    });
    assert.notEqual(replacement.id, originalPresence.id);
    assert.equal(replacement.sourceGeneration, '2');
  });
});
