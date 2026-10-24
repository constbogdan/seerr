import RadarrAPI, { type RadarrMovie } from '@server/api/servarr/radarr';
import SonarrAPI, {
  type SonarrEpisode,
  type SonarrEpisodeFile,
  type SonarrSeries,
} from '@server/api/servarr/sonarr';
import {
  LibraryMediaType,
  LibraryRemovalSource,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import { RemovalTargetType } from '@server/constants/removal';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import { SourceCheckpoint } from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import {
  AcquisitionMonitor,
  fanOutConfirmedImports,
} from '@server/lib/acquisitionMonitor';
import { BackgroundDatabaseWriteCoordinator } from '@server/lib/backgroundDatabaseWriteCoordinator';
import { DownloadTracker } from '@server/lib/downloadtracker';
import { LibraryService } from '@server/lib/library';
import { resolveCurrentRemovalTargetsForEligibility } from '@server/lib/libraryBulkEligibilityResolver';
import {
  CurrentLibraryGenerationService,
  LibraryHydrationEpochService,
} from '@server/lib/libraryHydrationEpoch';
import { LibraryHydrationRunCoordinator } from '@server/lib/libraryHydrationRunCoordinator';
import { loadActiveNextSeasonSeries } from '@server/lib/nextSeason';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import { classifyMovieLibraryStatusByTmdbIds } from '@server/lib/watchlistLibraryStatus';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  LIBRARY_TARGETED_REFRESH_ACTIVE_WINDOW_MS,
  LIBRARY_TARGETED_REFRESH_DEBOUNCE_MS,
  LIBRARY_TARGETED_REFRESH_MAX_RETRY_MS,
  LIBRARY_TARGETED_REFRESH_RETRY_MS,
  LibraryTargetedIdentityConflictError,
  LibraryTargetedNotReadyError,
  LibraryTargetedPersistence,
  LibraryTargetedRefreshExecutor,
  LibraryTargetedRefreshService,
  servarrPhysicalServerKey,
  type LibraryTargetedRefreshTarget,
} from './libraryTargetedRefresh';

setupTestDb();

const now = new Date('2026-10-24T12:00:00.000Z');

const generationService = () =>
  new CurrentLibraryGenerationService(
    new LibraryHydrationEpochService(dataSource)
  );

const epochService = () => new LibraryHydrationEpochService(dataSource);

const radarrServer = {
  id: 1,
  name: 'Radarr',
  hostname: 'radarr',
  port: 7878,
  apiKey: 'test-only',
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

const movie = (overrides: Partial<RadarrMovie> = {}): RadarrMovie =>
  ({
    id: 10,
    title: 'Targeted Movie',
    year: 2026,
    isAvailable: true,
    monitored: true,
    tmdbId: 100,
    imdbId: 'tt0000100',
    titleSlug: 'targeted-movie',
    folderName: 'Targeted Movie (2026)',
    path: '/media/movies/Targeted Movie (2026)',
    rootFolderPath: '/media/movies',
    profileId: 1,
    qualityProfileId: 1,
    added: '2026-10-24T11:00:00Z',
    hasFile: true,
    tags: [],
    movieFile: {
      id: 20,
      movieId: 10,
      relativePath: 'Targeted Movie.mkv',
      size: 1_000,
      dateAdded: '2026-10-24T11:59:00Z',
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

const series = (overrides: Partial<SonarrSeries> = {}): SonarrSeries =>
  ({
    id: 30,
    title: 'Targeted Series',
    sortTitle: 'targeted series',
    seasonCount: 2,
    status: 'continuing',
    overview: '',
    network: '',
    airTime: '',
    images: [],
    remotePoster: '',
    seasons: [
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: true },
    ],
    year: 2026,
    path: '/media/shows/Targeted Series',
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
    firstAired: '2026-01-01',
    seriesType: 'standard',
    cleanTitle: 'targetedseries',
    imdbId: 'tt0000300',
    titleSlug: 'targeted-series',
    certification: '',
    genres: [],
    tags: [],
    added: '2026-01-01T00:00:00Z',
    ratings: { votes: 1, value: 8 },
    qualityProfileId: 1,
    statistics: {
      seasonCount: 2,
      episodeFileCount: 1,
      episodeCount: 3,
      totalEpisodeCount: 3,
      sizeOnDisk: 2_000,
      releaseGroups: [],
      percentOfEpisodes: 67,
    },
    ...overrides,
  }) as SonarrSeries;

const episodes: SonarrEpisode[] = [
  {
    id: 301,
    seriesId: 30,
    episodeFileId: 40,
    seasonNumber: 1,
    episodeNumber: 1,
    title: 'One',
    airDate: '2026-01-01',
    airDateUtc: '2026-01-01T00:00:00Z',
    overview: '',
    hasFile: true,
    monitored: true,
    absoluteEpisodeNumber: 1,
    tvdbId: 3001,
    unverifiedSceneNumbering: false,
  },
  {
    id: 302,
    seriesId: 30,
    episodeFileId: 40,
    seasonNumber: 1,
    episodeNumber: 2,
    title: 'Two',
    airDate: '2026-01-02',
    airDateUtc: '2026-01-02T00:00:00Z',
    overview: '',
    hasFile: true,
    monitored: true,
    absoluteEpisodeNumber: 2,
    tvdbId: 3002,
    unverifiedSceneNumbering: false,
  },
  {
    id: 303,
    seriesId: 30,
    episodeFileId: 0,
    seasonNumber: 2,
    episodeNumber: 1,
    title: 'Later',
    airDate: '2027-01-01',
    airDateUtc: '2027-01-01T00:00:00Z',
    overview: '',
    hasFile: false,
    monitored: true,
    absoluteEpisodeNumber: 3,
    tvdbId: 3003,
    unverifiedSceneNumbering: false,
  },
];

const files: SonarrEpisodeFile[] = [
  {
    id: 40,
    seriesId: 30,
    seasonNumber: 1,
    relativePath: 'Season 01/S01E01-E02.mkv',
    size: 2_000,
    dateAdded: '2026-10-24T11:59:00Z',
    quality: { quality: { resolution: 1080 } },
  },
];

const movieTarget = (): LibraryTargetedRefreshTarget => ({
  key: `radarr:${servarrPhysicalServerKey(radarrServer)}:10`,
  provider: 'radarr',
  physicalServerKey: servarrPhysicalServerKey(radarrServer),
  externalId: 10,
  servers: [radarrServer],
  downloadIds: ['download-movie'],
  episodes: [],
});

const seriesTarget = (
  episodeIds: number[] = [301]
): LibraryTargetedRefreshTarget => ({
  key: `sonarr:${servarrPhysicalServerKey(sonarrServer)}:30`,
  provider: 'sonarr',
  physicalServerKey: servarrPhysicalServerKey(sonarrServer),
  externalId: 30,
  servers: [sonarrServer],
  downloadIds: ['download-series'],
  episodes: episodeIds.map((id) => {
    const episode = episodes.find((candidate) => candidate.id === id);
    assert.ok(episode);
    return {
      id: episode.id,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      absoluteEpisodeNumber: episode.absoluteEpisodeNumber,
    };
  }),
});

const executor = (input: {
  currentMovie?: () => RadarrMovie;
  currentSeries?: () => SonarrSeries;
  currentEpisodes?: () => SonarrEpisode[];
  currentFiles?: () => SonarrEpisodeFile[];
}) => {
  const getMovie = mock.fn(async () => (input.currentMovie ?? movie)());
  const getSeriesById = mock.fn(async () => (input.currentSeries ?? series)());
  const getEpisodes = mock.fn(async () =>
    (input.currentEpisodes ?? (() => episodes))()
  );
  const getEpisodeFiles = mock.fn(async () =>
    (input.currentFiles ?? (() => files))()
  );
  const persistence = new LibraryTargetedPersistence(
    dataSource,
    new BackgroundDatabaseWriteCoordinator(),
    () => now
  );
  return {
    instance: new LibraryTargetedRefreshExecutor(
      {
        createRadarrClient: () => ({ getMovie }),
        createSonarrClient: () => ({
          getSeriesById,
          getEpisodes,
          getEpisodeFiles,
        }),
      },
      persistence
    ),
    calls: { getMovie, getSeriesById, getEpisodes, getEpisodeFiles },
  };
};

describe('LibraryTargetedRefresh persistence', () => {
  it('persists one confirmed Episode when its authoritative file is ready', async () => {
    const targeted = executor({});

    const result = await targeted.instance.refresh(seriesTarget([301]));

    assert.equal(result.state, 'updated');
    assert.equal(await getRepository(LibraryFileEpisode).count(), 2);
  });

  it('persists an exact Movie import, links Seerr media, and is a write-free repeat', async () => {
    const seerrMedia = await getRepository(Media).save(
      new Media({
        tmdbId: 100,
        mediaType: MediaType.MOVIE,
        serviceId: radarrServer.id,
      })
    );
    const targeted = executor({});
    const first = await targeted.instance.refresh(movieTarget());
    const generation = await generationService().capture();
    const sourceEpoch = await epochService().capture('radarr', 'service:1');
    const second = await targeted.instance.refresh(movieTarget());

    assert.deepEqual(first, {
      state: 'updated',
      providerCalls: 1,
      rowsChanged: 7,
    });
    assert.equal(second.state, 'unchanged');
    assert.equal(second.rowsChanged, 0);
    assert.equal(await generationService().capture(), generation);
    assert.equal(
      await epochService().capture('radarr', 'service:1'),
      sourceEpoch
    );
    assert.equal(targeted.calls.getMovie.mock.callCount(), 2);

    const canonical = await getRepository(CanonicalMedia).findOneByOrFail({
      mediaType: LibraryMediaType.MOVIE,
    });
    assert.equal(canonical.currentMediaId, seerrMedia.id);
    const presence = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
      sourceItemId: 'movie:10',
      isCurrent: true,
    });
    assert.equal(presence.servarrHasFile, true);
    assert.equal(presence.logicalSizeBytes, '1000');
    const storedFile = await getRepository(LibraryFile).findOneByOrFail({
      libraryPresenceId: presence.id,
      isCurrent: true,
    });
    assert.equal(
      await getRepository(LibraryFile).countBy({
        libraryPresenceId: presence.id,
      }),
      1
    );
    assert.equal(storedFile.sourceFileId, 'movie-file:20');
    assert.equal(
      storedFile.importedAt?.toISOString(),
      '2026-10-24T11:59:00.000Z'
    );
    assert.equal(await getRepository(SourceCheckpoint).count(), 0);

    const watchlistStatuses = await classifyMovieLibraryStatusByTmdbIds([100]);
    assert.equal(watchlistStatuses.get(100), 'active');
    const library = await new LibraryService({
      fetchPresentation: async () => {
        throw new Error('Presentation is outside this persistence test');
      },
    }).query({
      take: 10,
      skip: 0,
      scope: 'current',
      mediaType: 'all',
      watchlist: 'any',
      watched: 'any',
      sort: 'title',
      sortDirection: 'asc',
      scheduled: 'any',
    });
    assert.equal(library.pageInfo.results, 1);
    assert.equal(library.results[0].canonicalMediaId, canonical.id);

    const settings = getSettings();
    const priorRadarr = settings.radarr;
    settings.radarr = [radarrServer];
    try {
      const removable = await resolveCurrentRemovalTargetsForEligibility([
        {
          canonicalMediaId: canonical.id,
          targetType: RemovalTargetType.MOVIE,
          removalSource: LibraryRemovalSource.MANUAL,
        },
      ]);
      assert.equal(removable[0].status, 'fulfilled');
    } finally {
      settings.radarr = priorRadarr;
    }
  });

  it('closes only the superseded Movie file and preserves its interval on upgrade', async () => {
    let current = movie();
    const targeted = executor({ currentMovie: () => current });
    await targeted.instance.refresh(movieTarget());
    const unrelatedCanonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: null,
        year: null,
      })
    );
    const unrelatedPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: unrelatedCanonical.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        sourceItemId: 'movie:999',
        sourceGeneration: '1',
        firstObservedAt: now,
        lastSeenAt: now,
        isCurrent: true,
        servarrManaged: true,
        servarrHasFile: true,
      })
    );
    const unrelatedFile = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: unrelatedPresence.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        sourceFileId: 'movie-file:999',
        sourceGeneration: '1',
        sizeBytes: '500',
        firstObservedAt: now,
        lastSeenAt: now,
        isCurrent: true,
      })
    );
    current = movie({
      movieFile: {
        ...movie().movieFile!,
        id: 21,
        size: 1_500,
        dateAdded: '2026-10-24T12:01:00Z',
      },
    });
    const upgraded = await targeted.instance.refresh({
      ...movieTarget(),
      downloadIds: ['download-upgrade'],
    });

    assert.equal(upgraded.state, 'updated');
    const moviePresence = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
      sourceItemId: 'movie:10',
      isCurrent: true,
    });
    const stored = await getRepository(LibraryFile).find({
      where: { libraryPresenceId: moviePresence.id },
      order: { id: 'ASC' },
    });
    assert.equal(stored.length, 2);
    assert.equal(stored[0].isCurrent, false);
    assert.equal(stored[0].removalSource, 'external');
    assert.equal(stored[1].isCurrent, true);
    assert.equal(stored[1].sourceFileId, 'movie-file:21');
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: unrelatedPresence.id,
        })
      ).isCurrent,
      true
    );
    assert.equal(
      (
        await getRepository(LibraryFile).findOneByOrFail({
          id: unrelatedFile.id,
        })
      ).isCurrent,
      true
    );
  });

  it('persists a complete affected Series with partial Seasons and multi-Episode links', async () => {
    const seerrMedia = await getRepository(Media).save(
      new Media({
        tmdbId: 999,
        tvdbId: 300,
        mediaType: MediaType.TV,
      })
    );
    const targeted = executor({});
    const result = await targeted.instance.refresh(seriesTarget([301, 302]));
    const repeated = await targeted.instance.refresh(seriesTarget([301, 302]));

    assert.equal(result.state, 'updated');
    assert.equal(result.providerCalls, 3);
    assert.equal(repeated.state, 'unchanged');
    assert.equal(targeted.calls.getSeriesById.mock.callCount(), 2);
    assert.equal(targeted.calls.getEpisodes.mock.callCount(), 2);
    assert.equal(targeted.calls.getEpisodeFiles.mock.callCount(), 2);
    const canonical = await getRepository(CanonicalMedia).findOneByOrFail({
      mediaType: LibraryMediaType.SERIES,
    });
    assert.equal(canonical.currentMediaId, seerrMedia.id);
    assert.deepEqual(
      (
        await getRepository(CanonicalSeason).find({
          order: { seasonNumber: 'ASC' },
        })
      ).map(({ seasonNumber }) => seasonNumber),
      [1, 2]
    );
    assert.equal(await getRepository(CanonicalEpisode).count(), 3);
    assert.equal(await getRepository(LibraryFileEpisode).count(), 2);
    const presence = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'sonarr',
      sourceItemId: 'series:30',
      isCurrent: true,
    });
    assert.equal(presence.logicalSizeBytes, '2000');
    assert.equal(await getRepository(SourceCheckpoint).count(), 0);
    assert.deepEqual(await loadActiveNextSeasonSeries(10, 0), [
      {
        canonicalMediaId: canonical.id,
        tmdbId: 999,
        title: `Series ${canonical.id}`,
      },
    ]);

    const settings = getSettings();
    const priorSonarr = settings.sonarr;
    settings.sonarr = [sonarrServer];
    try {
      const removable = await resolveCurrentRemovalTargetsForEligibility([
        {
          canonicalMediaId: canonical.id,
          targetType: RemovalTargetType.SEASON,
          seasonNumber: 1,
          removalSource: LibraryRemovalSource.MANUAL,
        },
      ]);
      assert.equal(removable[0].status, 'fulfilled');
    } finally {
      settings.sonarr = priorSonarr;
    }
  });

  it('fails closed on an invalid provider identity without partial persistence', async () => {
    const targeted = executor({ currentMovie: () => movie({ id: 999 }) });
    await assert.rejects(
      targeted.instance.refresh(movieTarget()),
      LibraryTargetedIdentityConflictError
    );
    assert.equal(await getRepository(CanonicalMedia).count(), 0);
    assert.equal(await getRepository(LibraryPresence).count(), 0);
    assert.equal(await getRepository(LibraryFile).count(), 0);
  });

  it('retries a confirmed import until the exact physical file is readable', async () => {
    const targeted = executor({
      currentMovie: () => movie({ hasFile: false, movieFile: undefined }),
    });
    await assert.rejects(
      targeted.instance.refresh(movieTarget()),
      LibraryTargetedNotReadyError
    );
    assert.equal(await getRepository(CanonicalMedia).count(), 0);
    assert.equal(await getRepository(LibraryPresence).count(), 0);
  });

  it('preserves the last-good Foundation state when a later provider read fails', async () => {
    let providerAvailable = true;
    const targeted = executor({
      currentMovie: () => {
        if (!providerAvailable) throw new Error('provider unavailable');
        return movie();
      },
    });
    await targeted.instance.refresh(movieTarget());
    const presence = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
      sourceItemId: 'movie:10',
      isCurrent: true,
    });
    const storedFile = await getRepository(LibraryFile).findOneByOrFail({
      libraryPresenceId: presence.id,
      isCurrent: true,
    });

    providerAvailable = false;
    await assert.rejects(
      targeted.instance.refresh({
        ...movieTarget(),
        downloadIds: ['provider-failure'],
      }),
      /provider unavailable/
    );

    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: presence.id,
        })
      ).isCurrent,
      true
    );
    assert.equal(
      (await getRepository(LibraryFile).findOneByOrFail({ id: storedFile.id }))
        .isCurrent,
      true
    );
  });

  it('requires every confirmed Episode before persisting a multi-Episode import', async () => {
    let secondReady = false;
    const targeted = executor({
      currentEpisodes: () =>
        episodes.map((episode) =>
          episode.id === 302 && !secondReady
            ? { ...episode, hasFile: false, episodeFileId: 0 }
            : episode
        ),
    });

    await assert.rejects(
      targeted.instance.refresh(seriesTarget([301, 302])),
      LibraryTargetedNotReadyError
    );
    assert.equal(await getRepository(CanonicalMedia).count(), 0);
    assert.equal(await getRepository(LibraryPresence).count(), 0);

    secondReady = true;
    const result = await targeted.instance.refresh(seriesTarget([301, 302]));
    assert.equal(result.state, 'updated');
    assert.equal(await getRepository(LibraryFileEpisode).count(), 2);
  });

  it('treats a confirmed Episode whose EpisodeFile is missing as not ready', async () => {
    const targeted = executor({ currentFiles: () => [] });

    await assert.rejects(
      targeted.instance.refresh(seriesTarget([301])),
      LibraryTargetedNotReadyError
    );
    assert.equal(await getRepository(CanonicalMedia).count(), 0);
    assert.equal(await getRepository(LibraryFile).count(), 0);
  });

  it('rejects a provider snapshot superseded by a concurrent Full Library Sync', async () => {
    let release: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const getMovie = mock.fn(
      () =>
        new Promise<RadarrMovie>((resolve) => {
          signalStarted?.();
          release = () => resolve(movie());
        })
    );
    const persistence = new LibraryTargetedPersistence(
      dataSource,
      new BackgroundDatabaseWriteCoordinator(),
      () => now
    );
    const targeted = new LibraryTargetedRefreshExecutor(
      {
        createRadarrClient: () => ({ getMovie }),
        createSonarrClient: () => {
          throw new Error('not used');
        },
      },
      persistence
    );
    const refresh = targeted.refresh(movieTarget());
    await started;
    await new LibraryHydrationRunCoordinator(dataSource, () => now).begin(
      'radarr',
      'service:999',
      true
    );
    release?.();

    await assert.rejects(refresh, /changed after its provider snapshot/);
    assert.equal(await getRepository(LibraryPresence).count(), 0);
  });

  it('does not resurrect a target after Removal advances its source fence', async () => {
    let release: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const persistence = new LibraryTargetedPersistence(
      dataSource,
      new BackgroundDatabaseWriteCoordinator(),
      () => now
    );
    const targeted = new LibraryTargetedRefreshExecutor(
      {
        createRadarrClient: () => ({
          getMovie: () =>
            new Promise<RadarrMovie>((resolve) => {
              signalStarted?.();
              release = () => resolve(movie());
            }),
        }),
        createSonarrClient: () => {
          throw new Error('not used');
        },
      },
      persistence
    );
    const refresh = targeted.refresh(movieTarget());
    await started;
    await dataSource.transaction('SERIALIZABLE', async (manager) => {
      await generationService().advance(manager);
      await epochService().advance(manager, 'radarr', 'service:1');
    });
    release?.();

    await assert.rejects(refresh, /changed after its provider snapshot/);
    assert.equal(await getRepository(LibraryPresence).count(), 0);
  });
});

interface FakeTimer {
  id: NodeJS.Timeout;
  at: number;
  callback: () => void;
}

class FakeClock {
  public now = Date.parse('2026-10-24T12:00:00Z');
  public timers: FakeTimer[] = [];
  private nextId = 1;

  public setTimer = (callback: () => void, delay: number): NodeJS.Timeout => {
    const id = this.nextId++ as unknown as NodeJS.Timeout;
    this.timers.push({ id, at: this.now + delay, callback });
    this.timers.sort((left, right) => left.at - right.at);
    return id;
  };

  public clearTimer = (id: NodeJS.Timeout): void => {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  };

  public async runNext(): Promise<number> {
    const timer = this.timers.shift();
    assert.ok(timer);
    const delay = timer.at - this.now;
    this.now = timer.at;
    timer.callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    return delay;
  }
}

describe('LibraryTargetedRefresh lifecycle', () => {
  it('flows a real DownloadTracker Movie confirmation through fan-out into Foundation persistence', async () => {
    const clock = new FakeClock();
    const settings = getSettings();
    const priorRadarr = settings.radarr;
    const priorSonarr = settings.sonarr;
    settings.radarr = [radarrServer];
    settings.sonarr = [];
    let queue = [
      {
        id: 1,
        movieId: 10,
        size: 1_000,
        title: 'Targeted Movie',
        sizeleft: 100,
        timeleft: '00:00:10',
        estimatedCompletionTime: new Date(clock.now + 10_000).toISOString(),
        status: 'downloading' as const,
        trackedDownloadStatus: 'ok' as const,
        trackedDownloadState: 'downloading' as const,
        downloadId: 'monitor-import',
        protocol: 'torrent',
        downloadClient: 'test',
        indexer: 'test',
      },
    ];
    let history: Awaited<ReturnType<RadarrAPI['getRecentHistory']>> = [];
    const refreshDownloads = mock.method(
      RadarrAPI.prototype,
      'refreshMonitoredDownloads',
      async () => Promise.resolve()
    );
    const getQueue = mock.method(
      RadarrAPI.prototype,
      'getQueue',
      async () => queue
    );
    const getHistory = mock.method(
      RadarrAPI.prototype,
      'getRecentHistory',
      async () => history
    );
    const tracker = new DownloadTracker({ now: () => clock.now });
    const targeted = executor({});
    let signalPersisted: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => {
      signalPersisted = resolve;
    });
    let jellyfinImports: unknown;
    let signalJellyfin: (() => void) | undefined;
    const jellyfinReceived = new Promise<void>((resolve) => {
      signalJellyfin = resolve;
    });
    const refresh = new LibraryTargetedRefreshService({
      radarrServers: () => [radarrServer],
      sonarrServers: () => [],
      refreshTarget: async (target) => {
        const result = await targeted.instance.refresh(target);
        signalPersisted?.();
        return result;
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });
    const monitor = new AcquisitionMonitor(tracker, {
      now: () => clock.now,
      setTimer: () => 0 as unknown as NodeJS.Timeout,
      clearTimer: () => undefined,
      onConfirmedImports: (imports) =>
        fanOutConfirmedImports(imports, [
          {
            name: 'jellyfin-availability',
            request: (received) => {
              jellyfinImports = received;
              signalJellyfin?.();
            },
          },
          {
            name: 'library-foundation',
            request: (received) => refresh.request(received),
          },
        ]),
    });

    try {
      await monitor.refresh('background');
      clock.now += 1_000;
      queue = [];
      history = [
        {
          id: 1,
          eventType: 'downloadFolderImported',
          date: new Date(clock.now).toISOString(),
          downloadId: 'monitor-import',
          movieId: 10,
        },
      ];
      await monitor.refresh('background');
      await jellyfinReceived;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(jellyfinImports, [
        {
          mediaType: MediaType.MOVIE,
          externalId: 10,
          downloadId: 'monitor-import',
          serverAliases: [{ id: 1, is4k: false }],
          episodes: [],
        },
      ]);
      assert.equal(refresh.getStatus().pendingTargets, 1);
      await clock.runNext();
      await persisted;
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(refresh.getStatus().updatedTargets, 1);
      assert.equal(
        await getRepository(LibraryPresence).countBy({
          sourceSystem: 'radarr',
          sourceScope: 'service:1',
          sourceItemId: 'movie:10',
          isCurrent: true,
        }),
        1
      );
      assert.equal(await getRepository(SourceCheckpoint).count(), 0);
    } finally {
      settings.radarr = priorRadarr;
      settings.sonarr = priorSonarr;
      refreshDownloads.mock.restore();
      getQueue.mock.restore();
      getHistory.mock.restore();
    }
  });

  it('flows a real multi-Episode Sonarr confirmation into complete Series persistence', async () => {
    const clock = new FakeClock();
    const settings = getSettings();
    const priorRadarr = settings.radarr;
    const priorSonarr = settings.sonarr;
    settings.radarr = [];
    settings.sonarr = [sonarrServer];
    let queue = episodes.slice(0, 2).map((episode, index) => ({
      id: index + 1,
      seriesId: 30,
      episodeId: episode.id,
      size: 2_000,
      title: episode.title,
      sizeleft: 100,
      timeleft: '00:00:10',
      estimatedCompletionTime: new Date(clock.now + 10_000).toISOString(),
      status: 'downloading' as const,
      trackedDownloadStatus: 'ok' as const,
      trackedDownloadState: 'downloading' as const,
      downloadId: 'season-pack',
      protocol: 'torrent',
      downloadClient: 'test',
      indexer: 'test',
      episode,
    }));
    let history: Awaited<ReturnType<SonarrAPI['getRecentHistory']>> = [];
    const refreshDownloads = mock.method(
      SonarrAPI.prototype,
      'refreshMonitoredDownloads',
      async () => Promise.resolve()
    );
    const getQueue = mock.method(
      SonarrAPI.prototype,
      'getQueue',
      async () => queue
    );
    const getHistory = mock.method(
      SonarrAPI.prototype,
      'getRecentHistory',
      async () => history
    );
    const tracker = new DownloadTracker({ now: () => clock.now });
    const targeted = executor({});
    let signalPersisted: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => {
      signalPersisted = resolve;
    });
    const refresh = new LibraryTargetedRefreshService({
      radarrServers: () => [],
      sonarrServers: () => [sonarrServer],
      refreshTarget: async (target) => {
        const result = await targeted.instance.refresh(target);
        signalPersisted?.();
        return result;
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });
    const monitor = new AcquisitionMonitor(tracker, {
      now: () => clock.now,
      setTimer: () => 0 as unknown as NodeJS.Timeout,
      clearTimer: () => undefined,
      onConfirmedImports: (imports) =>
        fanOutConfirmedImports(imports, [
          {
            name: 'library-foundation',
            request: (received) => refresh.request(received),
          },
        ]),
    });

    try {
      await monitor.refresh('background');
      clock.now += 1_000;
      queue = [];
      history = [
        {
          id: 1,
          eventType: 'downloadFolderImported',
          date: new Date(clock.now).toISOString(),
          downloadId: 'season-pack',
          seriesId: 30,
        },
      ];
      await monitor.refresh('background');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(refresh.getStatus().pendingTargets, 1);
      await clock.runNext();
      await persisted;
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(refresh.getStatus().updatedTargets, 1);
      assert.equal(await getRepository(CanonicalEpisode).count(), 3);
      assert.equal(await getRepository(LibraryFileEpisode).count(), 2);
      assert.equal(await getRepository(SourceCheckpoint).count(), 0);
    } finally {
      settings.radarr = priorRadarr;
      settings.sonarr = priorSonarr;
      refreshDownloads.mock.restore();
      getQueue.mock.restore();
      getHistory.mock.restore();
    }
  });

  it('coalesces generations by physical target and preserves later upgrades', async () => {
    const clock = new FakeClock();
    const refreshed: LibraryTargetedRefreshTarget[] = [];
    const service = new LibraryTargetedRefreshService({
      radarrServers: () => [radarrServer],
      sonarrServers: () => [],
      refreshTarget: async (target) => {
        refreshed.push(target);
        return { state: 'unchanged', providerCalls: 1, rowsChanged: 0 };
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });
    const confirmed = (downloadId: string) => ({
      mediaType: MediaType.MOVIE,
      externalId: 10,
      downloadId,
      serverAliases: [{ id: 1, is4k: false }],
      episodes: [],
    });
    service.request([confirmed('first')]);
    service.request([confirmed('upgrade')]);

    assert.equal(await clock.runNext(), LIBRARY_TARGETED_REFRESH_DEBOUNCE_MS);
    assert.equal(refreshed.length, 1);
    assert.deepEqual(refreshed[0].downloadIds, ['first', 'upgrade']);
    service.request([confirmed('first')]);
    assert.equal(clock.timers.length, 0);
    service.request([confirmed('later')]);
    await clock.runNext();
    assert.equal(refreshed.length, 2);
    assert.deepEqual(refreshed[1].downloadIds, ['later']);
    assert.equal(service.getStatus().coalescedSignals, 1);
  });

  it('keeps a multi-Episode generation pending until every confirmed Episode is ready', async () => {
    const clock = new FakeClock();
    let secondReady = false;
    const attemptResolvers: (() => void)[] = [];
    const nextAttempt = () =>
      new Promise<void>((resolve) => attemptResolvers.push(resolve));
    const targeted = executor({
      currentEpisodes: () =>
        episodes.map((episode) =>
          episode.id === 302 && !secondReady
            ? { ...episode, hasFile: false, episodeFileId: 0 }
            : episode
        ),
    });
    const service = new LibraryTargetedRefreshService({
      radarrServers: () => [],
      sonarrServers: () => [sonarrServer],
      refreshTarget: async (target, onProviderRead) => {
        try {
          return await targeted.instance.refresh(target, onProviderRead);
        } finally {
          attemptResolvers.shift()?.();
        }
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });
    const confirmed = {
      mediaType: MediaType.TV,
      externalId: 30,
      downloadId: 'season-pack',
      serverAliases: [{ id: 2, is4k: false }],
      episodes: seriesTarget([301, 302]).episodes,
    };
    const firstAttempt = nextAttempt();
    service.request([confirmed]);

    await clock.runNext();
    await firstAttempt;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.getStatus().pendingTargets, 1);
    assert.equal(await getRepository(LibraryPresence).count(), 0);

    secondReady = true;
    const secondAttempt = nextAttempt();
    assert.equal(await clock.runNext(), LIBRARY_TARGETED_REFRESH_RETRY_MS);
    await secondAttempt;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(service.getStatus().pendingTargets, 0);
    assert.equal(await getRepository(LibraryFileEpisode).count(), 2);

    service.request([confirmed]);
    assert.equal(clock.timers.length, 0);
  });

  it('extends expiry only for a genuinely new outstanding generation', () => {
    const clock = new FakeClock();
    const service = new LibraryTargetedRefreshService({
      radarrServers: () => [radarrServer],
      sonarrServers: () => [],
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });
    const confirmed = (downloadId: string) => ({
      mediaType: MediaType.MOVIE,
      externalId: 10,
      downloadId,
      serverAliases: [{ id: 1, is4k: false }],
      episodes: [],
    });
    const expiresAt = () => {
      const pending = (
        service as unknown as {
          pending: Map<string, { expiresAt: number }>;
        }
      ).pending;
      return [...pending.values()][0]?.expiresAt;
    };

    service.request([confirmed('first')]);
    const initialExpiry = expiresAt();
    assert.equal(
      initialExpiry,
      clock.now + LIBRARY_TARGETED_REFRESH_ACTIVE_WINDOW_MS
    );

    clock.now += LIBRARY_TARGETED_REFRESH_ACTIVE_WINDOW_MS - 1;
    service.request([confirmed('first')]);
    assert.equal(expiresAt(), initialExpiry);

    service.request([confirmed('later')]);
    assert.equal(
      expiresAt(),
      clock.now + LIBRARY_TARGETED_REFRESH_ACTIVE_WINDOW_MS
    );
  });

  it('cleans up an expired generation after bounded provider failure', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const service = new LibraryTargetedRefreshService({
      radarrServers: () => [radarrServer],
      sonarrServers: () => [],
      refreshTarget: async () => {
        attempts += 1;
        throw new Error('provider unavailable');
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });
    service.request([
      {
        mediaType: MediaType.MOVIE,
        externalId: 10,
        downloadId: 'expires',
        serverAliases: [{ id: 1, is4k: false }],
        episodes: [],
      },
    ]);
    await clock.runNext();
    assert.equal(attempts, 1);

    clock.now += LIBRARY_TARGETED_REFRESH_ACTIVE_WINDOW_MS;
    (
      service as unknown as {
        expireTargets: () => void;
      }
    ).expireTargets();

    assert.equal(service.getStatus().pendingTargets, 0);
    assert.equal(service.getStatus().terminalFailures, 1);
    assert.equal(attempts, 1);
  });

  it('retries transient failure on a bounded cadence', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const service = new LibraryTargetedRefreshService({
      radarrServers: () => [radarrServer],
      sonarrServers: () => [],
      refreshTarget: async (_target, onProviderRead) => {
        attempts += 1;
        onProviderRead();
        if (attempts <= 2) throw new Error('temporary provider failure');
        return { state: 'updated', providerCalls: 1, rowsChanged: 3 };
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });
    service.request([
      {
        mediaType: MediaType.MOVIE,
        externalId: 10,
        downloadId: 'retry',
        serverAliases: [{ id: 1, is4k: false }],
        episodes: [],
      },
    ]);

    await clock.runNext();
    assert.equal(service.getStatus().pendingTargets, 1);
    assert.equal(await clock.runNext(), LIBRARY_TARGETED_REFRESH_RETRY_MS);
    assert.equal(
      await clock.runNext(),
      Math.min(
        LIBRARY_TARGETED_REFRESH_RETRY_MS * 2,
        LIBRARY_TARGETED_REFRESH_MAX_RETRY_MS
      )
    );
    assert.equal(attempts, 3);
    assert.equal(service.getStatus().pendingTargets, 0);
    assert.equal(service.getStatus().retries, 2);
    assert.equal(service.getStatus().providerReads, 3);
    assert.equal(service.getStatus().rowsChanged, 3);
  });
});
