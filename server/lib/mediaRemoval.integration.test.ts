import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import {
  LibraryMediaType,
  LibraryRemovalSource,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { RemovalTargetType } from '@server/constants/removal';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import { LibrarySourceObservation } from '@server/entity/LibraryHydration';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import downloadTracker from '@server/lib/downloadtracker';
import { LibraryService } from '@server/lib/library';
import { currentLibraryGeneration } from '@server/lib/libraryHydrationEpoch';
import {
  MediaRemovalError,
  MediaRemovalService,
  type ResolvedRemovalTarget,
} from '@server/lib/mediaRemoval';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

beforeEach(() => {
  getSettings().radarr = [
    {
      id: 0,
      name: 'Radarr zero',
      hostname: 'radarr',
      port: 7878,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as RadarrSettings,
  ];
  getSettings().sonarr = [
    {
      id: 0,
      name: 'Sonarr zero',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as SonarrSettings,
  ];
  mock.method(acquisitionMonitor, 'refresh', async () =>
    Promise.resolve({
      authoritative: true,
    } as Awaited<ReturnType<typeof acquisitionMonitor.refresh>>)
  );
  mock.method(downloadTracker, 'getMovieProgress', () => []);
  mock.method(downloadTracker, 'getSeriesProgress', () => []);
});

afterEach(() => mock.reset());

describe('MediaRemovalService canonical Library targets', () => {
  const libraryQuery = (scope: 'current' | 'archive' | 'all') =>
    new LibraryService({
      fetchPresentation: async () => {
        throw new Error('Presentation lookup is intentionally unavailable');
      },
    }).query({
      take: 25,
      skip: 0,
      scope,
      mediaType: 'all',
      watchlist: 'any',
      watched: 'any',
      sort: 'title',
      sortDirection: 'asc',
      scheduled: 'any',
    });

  it('stops a multi-step scheduled Season removal when fenced ownership is lost', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Fenced Season fixture',
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.SERIES,
        provider: 'tvdb',
        sourceScope: '',
        value: '9001',
      })
    );
    const setSeasonMonitored = mock.fn(async (series) => series);
    const setEpisodesMonitored = mock.fn(async () => undefined);
    const deleteEpisodeFiles = mock.fn(async () => undefined);
    const service = new MediaRemovalService({
      createRadarr: () => {
        throw new Error('Unexpected Radarr client');
      },
      createSonarr: () => ({
        getLibrarySeriesByTvdbId: async () => [
          {
            id: 77,
            tvdbId: 9001,
            seasons: [{ seasonNumber: 1, monitored: true }],
          } as SonarrSeries,
        ],
        getEpisodes: async () =>
          [
            { id: 1, seasonNumber: 1, episodeFileId: 11 },
            { id: 2, seasonNumber: 1, episodeFileId: 12 },
          ] as SonarrEpisode[],
        getEpisodeFiles: async () =>
          [{ id: 11 }, { id: 12 }] as SonarrEpisodeFile[],
        setSeasonMonitored,
        setEpisodesMonitored,
        deleteEpisodeFiles,
        removeSeries: async () => 'removed' as const,
      }),
    });
    let ownershipChecks = 0;
    const assertOwnership = async () => {
      ownershipChecks += 1;
      if (ownershipChecks === 3) throw new Error('ownership lost');
    };
    const resolved = {
      canonicalMedia: canonical,
      canonicalMediaId: canonical.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 1,
      sourceSystem: 'sonarr',
      sourceScope: 'service:0',
      service: getSettings().sonarr[0],
      is4k: false,
      externalServiceId: 77,
      libraryPresenceId: 1,
      sourceItemId: 'series:77',
      sourceGeneration: 'generation',
      removalSource: LibraryRemovalSource.SCHEDULED,
    } satisfies ResolvedRemovalTarget;

    await assert.rejects(
      () => service.executeScheduledProviderRemoval(resolved, assertOwnership),
      (error) =>
        error instanceof MediaRemovalError &&
        error.code === 'TRANSIENT_PROVIDER'
    );
    assert.equal(setSeasonMonitored.mock.callCount(), 1);
    assert.equal(setEpisodesMonitored.mock.callCount(), 1);
    assert.equal(deleteEpisodeFiles.mock.callCount(), 0);
    assert.equal(ownershipChecks, 3);
  });

  it('moves a successfully removed Movie from Current to Archive without deleting historical facts', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Canonical-only fixture',
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '12345',
      })
    );
    const radarrPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:0',
        sourceItemId: 'movie:42',
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const jellyfinPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'jellyfin',
        sourceScope: 'jf',
        sourceItemId: 'movie:jf-movie',
        firstObservedAt: new Date('2026-01-02T00:00:00.000Z'),
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    const file = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: radarrPresence.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:0',
        sourceFileId: 'movie-file:7',
        sourceGeneration: '1',
        sizeBytes: '1234',
        importedAt: new Date('2026-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        isCurrent: true,
      })
    );
    const observation = await getRepository(LibrarySourceObservation).save(
      new LibrarySourceObservation({
        libraryPresenceId: radarrPresence.id,
        source: 'radarr',
        sourceScope: 'service:0',
        sourceGeneration: '1',
        sourceObservationId: 'current:movie:42',
        observedAt: new Date('2026-01-03T00:00:00.000Z'),
      })
    );
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceUserId: 'viewer',
      })
    );
    const evidence = await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'history',
        sourceActivityId: 'historical-completion',
        viewerId: viewer.id,
        canonicalMediaId: canonical.id,
        observedAt: new Date('2026-01-04T00:00:00.000Z'),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      })
    );
    let removalCalls = 0;
    const removeMovie = mock.fn(async (tmdbId: number) => {
      assert.equal(tmdbId, 12345);
      removalCalls += 1;
      return removalCalls === 1 ? ('removed' as const) : ('absent' as const);
    });
    const service = new MediaRemovalService({
      createRadarr: () => ({ removeMovie }),
      createSonarr: () => {
        throw new Error('Unexpected Sonarr client');
      },
    });

    assert.deepEqual(
      (await libraryQuery('current')).results.map(({ canonicalMediaId }) =>
        Number(canonicalMediaId)
      ),
      [canonical.id]
    );
    const generationBeforeRemoval = await currentLibraryGeneration.capture();

    const result = await service.remove({
      canonicalMediaId: canonical.id,
      targetType: RemovalTargetType.MOVIE,
      sourceScope: 'service:0',
      removalSource: LibraryRemovalSource.MANUAL,
    });

    assert.deepEqual(result, {
      targetType: RemovalTargetType.MOVIE,
      providerResult: 'removed',
    });
    assert.equal(removeMovie.mock.callCount(), 1);
    assert.equal(
      await currentLibraryGeneration.capture(),
      generationBeforeRemoval + 1
    );
    assert.equal(removeMovie.mock.calls[0].arguments[0], 12345);
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: radarrPresence.id,
        })
      ).isCurrent,
      false
    );
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: radarrPresence.id,
        })
      ).removalSource,
      LibraryRemovalSource.MANUAL
    );
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: jellyfinPresence.id,
        })
      ).isCurrent,
      false
    );
    assert.equal(
      (await getRepository(LibraryFile).findOneByOrFail({ id: file.id }))
        .isCurrent,
      false
    );
    assert.equal(
      (await getRepository(LibraryFile).findOneByOrFail({ id: file.id }))
        .removalSource,
      LibraryRemovalSource.MANUAL
    );
    assert.equal((await libraryQuery('current')).results.length, 0);
    assert.deepEqual(
      (await libraryQuery('archive')).results.map(({ canonicalMediaId }) =>
        Number(canonicalMediaId)
      ),
      [canonical.id]
    );
    assert.deepEqual(
      (await libraryQuery('all')).results.map(({ canonicalMediaId }) =>
        Number(canonicalMediaId)
      ),
      [canonical.id]
    );
    assert.ok(
      await getRepository(LibrarySourceObservation).findOneBy({
        id: observation.id,
      })
    );
    assert.ok(
      await getRepository(ViewingEvidence).findOneBy({ id: evidence.id })
    );

    await assert.rejects(
      service.remove({
        canonicalMediaId: canonical.id,
        targetType: RemovalTargetType.MOVIE,
        sourceScope: 'service:0',
        removalSource: LibraryRemovalSource.MANUAL,
      }),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'NOT_CURRENT'
    );
    assert.equal(removeMovie.mock.callCount(), 1);
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        canonicalMediaId: canonical.id,
      }),
      2
    );
    assert.equal(
      await getRepository(LibraryFile).countBy({
        libraryPresenceId: radarrPresence.id,
      }),
      1
    );
  });

  it('persists Scheduled on the ended Movie generation and its derived Archive fact', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Scheduled Movie fixture',
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '54321',
      })
    );
    const presence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:0',
        sourceItemId: 'movie:84',
        sourceGeneration: '1',
        addedAt: new Date('2025-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const file = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:0',
        sourceFileId: 'movie-file:84',
        sourceGeneration: '1',
        importedAt: new Date('2025-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
        isCurrent: true,
      })
    );
    const jellyfinPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'jellyfin',
        sourceScope: 'jf',
        sourceItemId: 'movie:scheduled-fixture',
        sourceGeneration: '1',
        firstObservedAt: new Date('2025-01-02T00:00:00.000Z'),
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    const service = new MediaRemovalService({
      createRadarr: () => ({ removeMovie: async () => 'removed' as const }),
      createSonarr: () => {
        throw new Error('Unexpected Sonarr client');
      },
    });

    await service.remove({
      canonicalMediaId: canonical.id,
      targetType: RemovalTargetType.MOVIE,
      sourceScope: 'service:0',
      removalSource: LibraryRemovalSource.SCHEDULED,
    });

    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: presence.id,
        })
      ).removalSource,
      LibraryRemovalSource.SCHEDULED
    );
    assert.equal(
      (await getRepository(LibraryFile).findOneByOrFail({ id: file.id }))
        .removalSource,
      LibraryRemovalSource.SCHEDULED
    );
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: jellyfinPresence.id,
        })
      ).removalSource,
      LibraryRemovalSource.SCHEDULED
    );
    const archive = await libraryQuery('archive');
    const item = archive.results.find(
      (candidate) => candidate.canonicalMediaId === canonical.id
    );
    assert.ok(item?.removedAt);
    assert.equal(item?.removalSource, LibraryRemovalSource.SCHEDULED);
  });

  it('closes Series presences after successful whole-Series removal', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Series fixture',
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.SERIES,
        provider: 'tvdb',
        sourceScope: '',
        value: '777',
      })
    );
    const sonarrPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceItemId: 'series:42',
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const jellyfinPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'jellyfin',
        sourceScope: 'jf',
        sourceItemId: 'series:jf-series',
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: sonarrPresence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceFileId: 'episode-file:1',
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        isCurrent: true,
      })
    );
    const removeSeries = mock.fn(async () => 'removed' as const);
    const service = new MediaRemovalService({
      createRadarr: () => {
        throw new Error('Unexpected Radarr client');
      },
      createSonarr: () => ({
        getLibrarySeriesByTvdbId: async () => [],
        getEpisodes: async () => [],
        getEpisodeFiles: async () => [],
        setSeasonMonitored: async (series) => series,
        setEpisodesMonitored: async () => undefined,
        deleteEpisodeFiles: async () => undefined,
        removeSeries,
      }),
    });

    await service.remove({
      canonicalMediaId: canonical.id,
      targetType: RemovalTargetType.SERIES,
      sourceScope: 'service:0',
      removalSource: LibraryRemovalSource.MANUAL,
    });

    assert.equal(removeSeries.mock.callCount(), 1);
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: sonarrPresence.id,
        })
      ).isCurrent,
      false
    );
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          id: jellyfinPresence.id,
        })
      ).isCurrent,
      false
    );
  });

  it('closes only the removed Season files and keeps the Series current', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Season fixture',
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.SERIES,
        provider: 'tvdb',
        sourceScope: '',
        value: '888',
      })
    );
    const seasonOne = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: canonical.id, seasonNumber: 1 })
    );
    const seasonTwo = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: canonical.id, seasonNumber: 2 })
    );
    const episodeOne = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: seasonOne.id, episodeNumber: 1 })
    );
    const episodeTwo = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: seasonTwo.id, episodeNumber: 1 })
    );
    const presence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceItemId: 'series:52',
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const files = await getRepository(LibraryFile).save([
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceFileId: 'episode-file:11',
        sizeBytes: '100',
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        isCurrent: true,
      }),
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceFileId: 'episode-file:12',
        sizeBytes: '200',
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        isCurrent: true,
      }),
    ]);
    await getRepository(LibraryFileEpisode).save([
      new LibraryFileEpisode({
        libraryFileId: files[0].id,
        canonicalEpisodeId: episodeOne.id,
      }),
      new LibraryFileEpisode({
        libraryFileId: files[1].id,
        canonicalEpisodeId: episodeTwo.id,
      }),
    ]);
    const service = new MediaRemovalService({
      createRadarr: () => {
        throw new Error('Unexpected Radarr client');
      },
      createSonarr: () => ({
        getLibrarySeriesByTvdbId: async () => [
          { id: 52, tvdbId: 888 } as SonarrSeries,
        ],
        getEpisodes: async () => [
          {
            id: 1,
            seasonNumber: 1,
            episodeFileId: 11,
          } as SonarrEpisode,
          {
            id: 2,
            seasonNumber: 2,
            episodeFileId: 12,
          } as SonarrEpisode,
        ],
        getEpisodeFiles: async () => [
          { id: 11 } as SonarrEpisodeFile,
          { id: 12 } as SonarrEpisodeFile,
        ],
        setSeasonMonitored: async (series) => series,
        setEpisodesMonitored: async () => undefined,
        deleteEpisodeFiles: async () => undefined,
        removeSeries: async () => 'removed' as const,
      }),
    });

    await service.remove({
      canonicalMediaId: canonical.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 1,
      sourceScope: 'service:0',
      removalSource: LibraryRemovalSource.MANUAL,
    });

    assert.equal(
      (await getRepository(LibraryFile).findOneByOrFail({ id: files[0].id }))
        .isCurrent,
      false
    );
    assert.equal(
      (await getRepository(LibraryFile).findOneByOrFail({ id: files[0].id }))
        .removalSource,
      LibraryRemovalSource.MANUAL
    );
    assert.equal(
      (await getRepository(LibraryFile).findOneByOrFail({ id: files[1].id }))
        .isCurrent,
      true
    );
    const refreshedPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({ id: presence.id });
    assert.equal(refreshedPresence.isCurrent, true);
    assert.equal(refreshedPresence.servarrHasFile, true);
    assert.equal(refreshedPresence.logicalSizeBytes, '200');
  });
});
