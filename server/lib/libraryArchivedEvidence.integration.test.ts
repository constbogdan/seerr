// Real scheduler, fenced executor, removal service and Library membership queries.
// All provider operations are mocked and SQLite must be in-memory.
import type { RadarrMovie } from '@server/api/servarr/radarr';
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
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import {
  DEFAULT_REMOVAL_SETTINGS,
  RemovalExecutionState,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import dataSource, { getRepository } from '@server/datasource';
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
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RemovalExecution } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { Watchlist } from '@server/entity/Watchlist';
import { runRemovalProcessing } from '@server/job/removalJobs';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import downloadTracker from '@server/lib/downloadtracker';
import { LibraryService } from '@server/lib/library';
import {
  LibraryHistoryHydrationService,
  type LibraryHydrationDependencies,
} from '@server/lib/libraryHistoryHydration';
import libraryHydrationEpoch from '@server/lib/libraryHydrationEpoch';
import { MediaRemovalService } from '@server/lib/mediaRemoval';
import defaultScheduler, {
  RemovalScheduler,
} from '@server/lib/removalScheduler';
import { ScheduledRemovalExecutor } from '@server/lib/scheduledRemovalExecutor';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { EntitySubscriberInterface } from 'typeorm';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(dataSource.options.type, 'sqlite');
assert.equal(dataSource.options.database, ':memory:');
setupTestDb();
let now = new Date('2026-08-01T00:00:00Z');
beforeEach(() => {
  now = new Date('2026-08-01T00:00:00Z');
  getSettings().removal = structuredClone(DEFAULT_REMOVAL_SETTINGS);
  getSettings().radarr = [
    {
      id: 0,
      hostname: 'fixture.invalid',
      port: 7878,
      apiKey: 'fixture',
      is4k: false,
      isDefault: true,
    } as RadarrSettings,
  ];
  getSettings().sonarr = [
    {
      id: 0,
      hostname: 'fixture.invalid',
      port: 8989,
      apiKey: 'fixture',
      is4k: false,
      isDefault: true,
    } as SonarrSettings,
  ];
  mock.method(
    acquisitionMonitor,
    'refresh',
    async () =>
      ({ authoritative: true }) as Awaited<
        ReturnType<typeof acquisitionMonitor.refresh>
      >
  );
  mock.method(downloadTracker, 'getMovieProgress', () => []);
  mock.method(downloadTracker, 'getSeriesProgress', () => []);
  mock.method(MediaRequest, 'sendNotification', async () => undefined);
});
afterEach(() => mock.reset());

const library = new LibraryService({
  fetchPresentation: async () => {
    throw Error('No provider metadata in this fixture');
  },
});
const query = async (
  scope: 'current' | 'archive',
  scheduled: 'any' | 'yes' = 'any'
) =>
  (
    await library.query({
      take: 100,
      skip: 0,
      scope,
      mediaType: 'all',
      watchlist: 'any',
      watched: 'any',
      scheduled,
      sort: 'title',
      sortDirection: 'asc',
    })
  ).results;

async function fixture(
  kind: LibraryMediaType,
  files: boolean,
  jellyfin = true
) {
  const mediaType =
    kind === LibraryMediaType.MOVIE ? MediaType.MOVIE : MediaType.TV;
  const sourceSystem = kind === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr';
  const media = await getRepository(Media).save(
    new Media({
      mediaType,
      tmdbId: 9001,
      ...(kind === LibraryMediaType.SERIES ? { tvdbId: 9002 } : {}),
      status: MediaStatus.AVAILABLE,
      serviceId: 0,
      externalServiceId: 42,
    })
  );
  const canonical = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: kind,
      titleSnapshot: `Scheduled fixture ${kind}`,
      currentMediaId: media.id,
    })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: canonical.id,
      mediaType: kind,
      provider: 'tmdb',
      sourceScope: '',
      value: '9001',
    })
  );
  if (kind === LibraryMediaType.SERIES)
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: kind,
        provider: 'tvdb',
        sourceScope: '',
        value: '9002',
      })
    );
  const presence = await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: canonical.id,
      sourceSystem,
      sourceScope: 'service:0',
      sourceItemId: kind === LibraryMediaType.MOVIE ? 'movie:42' : 'series:42',
      sourceGeneration: '1',
      addedAt: new Date('2025-01-01T00:00:00Z'),
      firstObservedAt: new Date('2025-01-01T00:00:00Z'),
      servarrHasFile: true,
      servarrManaged: true,
      isCurrent: true,
    })
  );
  if (jellyfin)
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'jellyfin',
        sourceScope: 'fixture-jf',
        sourceItemId: 'item-fixture',
        sourceGeneration: '1',
        firstObservedAt: new Date(),
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
  await getRepository(LibrarySourceObservation).save(
    new LibrarySourceObservation({
      libraryPresenceId: presence.id,
      source: sourceSystem,
      sourceScope: 'service:0',
      sourceGeneration: '1',
      sourceObservationId: `current:${presence.sourceItemId}`,
      observedAt: new Date('2026-01-01T00:00:00Z'),
      servarrManaged: true,
      servarrHasFile: true,
    })
  );
  const viewer = await getRepository(Viewer).save(
    new Viewer({
      source: 'jellyfin',
      sourceScope: 'fixture-jf',
      sourceUserId: 'viewer-fixture',
    })
  );
  const evidence = await getRepository(ViewingEvidence).save(
    new ViewingEvidence({
      source: 'jellyfin',
      sourceScope: 'fixture-jf',
      sourceClass: 'history',
      sourceActivityId: 'history-fixture',
      canonicalMediaId: canonical.id,
      viewerId: viewer.id,
      observedAt: new Date('2026-01-01T00:00:00Z'),
      completionClassification: ViewingCompletionClassification.CONFIRMED,
    })
  );
  const user = await getRepository(User).findOneByOrFail({ id: 1 });
  const watchlist = await getRepository(Watchlist).save(
    new Watchlist({ mediaType, tmdbId: 9001, requestedBy: user, media })
  );
  // Plain insert avoids request submission/notification hooks: this is history.
  await getRepository(MediaRequest)
    .createQueryBuilder()
    .insert()
    .values({
      type: mediaType,
      media,
      requestedBy: user,
      status: MediaRequestStatus.APPROVED,
      is4k: false,
    })
    .callListeners(false)
    .execute();
  const request = (await getRepository(MediaRequest).find())[0];
  if (kind === LibraryMediaType.SERIES) {
    for (const seasonNumber of [1, 2]) {
      await getRepository(SeasonRequest)
        .createQueryBuilder()
        .insert()
        .values({ seasonNumber, status: MediaRequestStatus.APPROVED, request })
        .callListeners(false)
        .execute();
      await getRepository(Season).save(
        new Season({
          seasonNumber,
          status: MediaStatus.AVAILABLE,
          media: Promise.resolve(media),
        })
      );
      const season = await getRepository(CanonicalSeason).save(
        new CanonicalSeason({ seriesId: canonical.id, seasonNumber })
      );
      const episode = await getRepository(CanonicalEpisode).save(
        new CanonicalEpisode({ seasonId: season.id, episodeNumber: 1 })
      );
      if (files) {
        const file = await getRepository(LibraryFile).save(
          new LibraryFile({
            libraryPresenceId: presence.id,
            sourceSystem,
            sourceScope: 'service:0',
            sourceFileId: `episode-file:${seasonNumber + 10}`,
            sourceGeneration: '1',
            firstObservedAt: new Date(),
            isCurrent: true,
          })
        );
        await getRepository(LibraryFileEpisode).save(
          new LibraryFileEpisode({
            libraryFileId: file.id,
            canonicalEpisodeId: episode.id,
          })
        );
      }
    }
  } else if (files)
    await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem,
        sourceScope: 'service:0',
        sourceFileId: 'movie-file:7',
        sourceGeneration: '1',
        firstObservedAt: new Date(),
        isCurrent: true,
      })
    );
  return { kind, media, canonical, presence, evidence, watchlist };
}

function pipeline(mode: 'success' | 'failure' | 'partial-season' = 'success') {
  const calls: string[] = [];
  const mutate = async (name: string) => {
    calls.push(name);
    if (
      mode === 'failure' ||
      (mode === 'partial-season' && name === 'delete:13')
    )
      throw Error('Mock interrupted provider mutation');
  };
  const service = new MediaRemovalService({
    createRadarr: () => ({
      removeMovie: async (_id, fence) => {
        await fence?.();
        await mutate('movie');
        return 'removed' as const;
      },
    }),
    createSonarr: () => ({
      getLibrarySeriesByTvdbId: async () => [
        {
          id: 42,
          tvdbId: 9002,
          seasons: [
            { seasonNumber: 1, monitored: true },
            { seasonNumber: 2, monitored: true },
          ],
        } as SonarrSeries,
      ],
      getEpisodes: async () =>
        [
          { id: 1, seasonNumber: 1, episodeFileId: 11 },
          { id: 2, seasonNumber: 2, episodeFileId: 12 },
          ...(mode === 'partial-season'
            ? [{ id: 3, seasonNumber: 1, episodeFileId: 13 }]
            : []),
        ] as SonarrEpisode[],
      getEpisodeFiles: async () =>
        [
          { id: 11 },
          { id: 12 },
          ...(mode === 'partial-season' ? [{ id: 13 }] : []),
        ] as SonarrEpisodeFile[],
      setSeasonMonitored: async (series) => {
        await mutate('unmonitor-season');
        return series;
      },
      setEpisodesMonitored: async () => {
        await mutate('unmonitor-episodes');
      },
      deleteEpisodeFiles: async (ids) => {
        for (const id of ids) await mutate(`delete:${id}`);
      },
      removeSeries: async (_id, fence) => {
        await fence?.();
        await mutate('series');
        return 'removed' as const;
      },
    }),
  });
  const executor = new ScheduledRemovalExecutor(
    dataSource,
    service,
    undefined,
    () => now
  );
  const scheduler = new RemovalScheduler(service, () => now, executor);
  return { scheduler, calls, service };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function schedule(
  p: ReturnType<typeof pipeline>,
  f: Fixture,
  season = false
) {
  const row = await p.scheduler.createManual({
    canonicalMediaId: f.canonical.id,
    targetType: season
      ? RemovalTargetType.SEASON
      : f.kind === LibraryMediaType.MOVIE
        ? RemovalTargetType.MOVIE
        : RemovalTargetType.SERIES,
    sourceScope: 'service:0',
    ...(season ? { seasonNumber: 1 } : {}),
  });
  assert.equal((await query('current', 'yes')).length, 1);
  now = new Date('2026-10-26T00:00:00Z');
  return row;
}
async function retained(
  f: Fixture,
  requestStatus = MediaRequestStatus.COMPLETED
) {
  assert.equal(
    await getRepository(CanonicalMedia).countBy({ id: f.canonical.id }),
    1
  );
  assert.ok(
    await getRepository(CanonicalMediaIdentity).countBy({
      canonicalMediaId: f.canonical.id,
    })
  );
  assert.equal(
    await getRepository(ViewingEvidence).countBy({ id: f.evidence.id }),
    1
  );
  assert.equal(
    await getRepository(Watchlist).countBy({ id: f.watchlist.id }),
    1
  );
  assert.equal(await getRepository(MediaRequest).count(), 1);
  assert.equal(
    (await getRepository(MediaRequest).find())[0].status,
    requestStatus
  );
}

function hydration(
  kind: LibraryMediaType,
  state: 'empty' | 'physical' | 'failure',
  beforeRead?: () => Promise<void>
) {
  const dependencies: LibraryHydrationDependencies = {
    radarrServers: () =>
      kind === LibraryMediaType.MOVIE ? getSettings().radarr : [],
    sonarrServers: () =>
      kind === LibraryMediaType.SERIES ? getSettings().sonarr : [],
    jellyfinSettings: () => ({
      ...getSettings().jellyfin,
      apiKey: '',
      libraries: [],
    }),
    createJellyfinContext: async () => undefined,
    createRadarrClient: () => ({
      getRootFolders: async () => [],
      getMovies: async () => {
        await beforeRead?.();
        if (state === 'failure') throw Error('Mock enumeration failure');
        return [
          {
            id: 42,
            tmdbId: 9001,
            title: 'Fixture',
            path: '/fixture/movie',
            hasFile: state === 'physical',
            ...(state === 'physical'
              ? {
                  movieFile: {
                    id: 77,
                    size: 100,
                    relativePath: 'movie.mkv',
                    dateAdded: '2026-07-01T00:00:00Z',
                  },
                }
              : {}),
          } as RadarrMovie,
        ];
      },
    }),
    createSonarrClient: () => ({
      getRootFolders: async () => [],
      getSeries: async () => {
        await beforeRead?.();
        if (state === 'failure') throw Error('Mock enumeration failure');
        return [
          {
            id: 42,
            tvdbId: 9002,
            title: 'Fixture',
            path: '/fixture/series',
            seasons: [{ seasonNumber: 1, monitored: true }],
          } as SonarrSeries,
        ];
      },
      getEpisodes: async () =>
        state === 'physical'
          ? [
              {
                id: 1,
                seasonNumber: 1,
                episodeNumber: 1,
                episodeFileId: 11,
                title: 'Fixture',
              } as SonarrEpisode,
            ]
          : [],
      getEpisodeFiles: async () =>
        state === 'physical'
          ? [
              {
                id: 11,
                size: 100,
                relativePath: 'episode.mkv',
                dateAdded: '2026-07-01T00:00:00Z',
              } as SonarrEpisodeFile,
            ]
          : [],
    }),
    createQueryMetadataClient: () => ({
      getMovieForScan: async ({ movieId }) => ({
        id: movieId,
        title: 'Fixture',
        belongs_to_collection: null,
      }),
      getTvShowForScan: async ({ tvId }) => ({ id: tvId, name: 'Fixture' }),
      getShowByTvdbIdForScan: async () => ({ id: 9001, name: 'Fixture' }),
      resolveImdbIdForScan: async () => {
        throw Error('Unexpected identity lookup');
      },
    }),
    now: () => new Date(),
  };
  return new LibraryHistoryHydrationService(dependencies);
}

describe('Library historical physical evidence preservation', () => {
  for (const kind of [LibraryMediaType.MOVIE, LibraryMediaType.SERIES]) {
    it(`manual presence-only ${kind} archives and preserves identity, viewing and audit`, async () => {
      const f = await fixture(kind, false),
        p = pipeline();
      await p.service.remove({
        canonicalMediaId: f.canonical.id,
        targetType:
          kind === LibraryMediaType.MOVIE
            ? RemovalTargetType.MOVIE
            : RemovalTargetType.SERIES,
        sourceScope: 'service:0',
        removalSource: LibraryRemovalSource.MANUAL,
      });
      assert.equal((await query('current')).length, 0);
      assert.equal(
        (await query('archive'))[0]?.canonicalMediaId,
        f.canonical.id
      );
      assert.equal(
        await getRepository(RemovalExecution).countBy({
          state: RemovalExecutionState.COMPLETED,
        }),
        1
      );
      const closed = await getRepository(LibraryPresence).findBy({
        canonicalMediaId: f.canonical.id,
      });
      assert.ok(closed.every((presence) => !presence.isCurrent));
      assert.equal(
        closed.find((presence) => presence.sourceSystem === 'jellyfin')
          ?.jellyfinVisible,
        true
      );
      await retained(f);
      assert.equal((await hydration(kind, 'physical').run()).complete, true);
      assert.equal(
        (await query('current'))[0]?.canonicalMediaId,
        f.canonical.id
      );
      assert.equal((await query('archive')).length, 0);
      const replacement = await getRepository(LibraryPresence).findOneByOrFail({
        canonicalMediaId: f.canonical.id,
        isCurrent: true,
        sourceSystem: kind === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr',
      });
      assert.equal(replacement.sourceGeneration, '2');
      assert.notEqual(replacement.id, f.presence.id);
      assert.equal(await getRepository(CanonicalMedia).count(), 1);
      assert.equal(
        await getRepository(RemovalExecution).countBy({
          state: RemovalExecutionState.COMPLETED,
        }),
        1
      );
      await retained(f);
    });

    it(`managed-to-empty ${kind} retains physical history through repeated hydration and reimport`, async () => {
      const f = await fixture(kind, false, false);
      const oldObservation = (
        await getRepository(LibrarySourceObservation).find()
      )[0];
      const result = await hydration(kind, 'empty').run();
      assert.equal(result.complete, true);
      const old = await getRepository(LibraryPresence).findOneByOrFail({
        id: f.presence.id,
      });
      assert.equal(old.isCurrent, false);
      assert.equal(old.servarrHasFile, true);
      assert.equal(old.removalSource, LibraryRemovalSource.EXTERNAL);
      assert.ok(old.removedAt);
      assert.equal(
        (
          await getRepository(LibrarySourceObservation).findOneByOrFail({
            id: oldObservation.id,
          })
        ).servarrHasFile,
        true
      );
      const current = await getRepository(LibraryPresence).findOneByOrFail({
        canonicalMediaId: f.canonical.id,
        isCurrent: true,
      });
      assert.equal(current.sourceGeneration, '2');
      assert.equal(current.servarrManaged, true);
      assert.equal(current.servarrHasFile, false);
      assert.equal((await query('current')).length, 0);
      assert.equal(
        (await query('archive'))[0]?.canonicalMediaId,
        f.canonical.id
      );
      assert.equal(await getRepository(LibraryFile).count(), 0);
      assert.equal(
        result.sources.find(
          (source) =>
            source.source ===
            (kind === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr')
        )?.presencesClosed,
        1
      );
      const frozen = { ...old };
      assert.equal((await hydration(kind, 'empty').run()).complete, true);
      assert.equal(
        await getRepository(LibraryPresence).countBy({
          canonicalMediaId: f.canonical.id,
        }),
        2
      );
      assert.equal(
        await getRepository(LibraryPresence).countBy({
          canonicalMediaId: f.canonical.id,
          isCurrent: true,
        }),
        1
      );
      assert.equal(await getRepository(LibrarySourceObservation).count(), 2);
      assert.deepEqual(
        {
          ...(await getRepository(LibraryPresence).findOneByOrFail({
            id: old.id,
          })),
        },
        frozen
      );
      assert.equal((await hydration(kind, 'physical').run()).complete, true);
      assert.equal(
        (await query('current'))[0]?.canonicalMediaId,
        f.canonical.id
      );
      assert.equal((await query('archive')).length, 0);
      assert.equal(
        (await getRepository(LibraryPresence).findOneByOrFail({ id: old.id }))
          .servarrHasFile,
        true
      );
      assert.equal(await getRepository(CanonicalMedia).count(), 1);
      // A second physical-to-empty transition gets one new generation, not
      // one historical interval per repeated hydration run.
      assert.equal((await hydration(kind, 'empty').run()).complete, true);
      assert.equal((await hydration(kind, 'empty').run()).complete, true);
      assert.equal(await getRepository(LibraryPresence).count(), 3);
      assert.equal(
        await getRepository(LibraryPresence).countBy({ isCurrent: true }),
        1
      );
      assert.equal(
        await getRepository(LibraryPresence).countBy({
          isCurrent: false,
          servarrHasFile: true,
        }),
        2
      );
      assert.equal(
        (await query('archive'))[0]?.canonicalMediaId,
        f.canonical.id
      );
      await retained(f, MediaRequestStatus.APPROVED);
    });

    it(`file-backed ${kind} history stays linked to its ended generation after empty hydration and reimport`, async () => {
      const f = await fixture(kind, true, false);
      const originalFiles = await getRepository(LibraryFile).findBy({
        libraryPresenceId: f.presence.id,
      });
      assert.equal((await hydration(kind, 'empty').run()).complete, true);
      assert.equal(
        await getRepository(LibraryFile).countBy({ isCurrent: true }),
        0
      );
      assert.equal(
        (await query('archive'))[0]?.canonicalMediaId,
        f.canonical.id
      );
      assert.equal((await hydration(kind, 'physical').run()).complete, true);
      assert.equal(
        (await query('current'))[0]?.canonicalMediaId,
        f.canonical.id
      );
      assert.equal((await query('archive')).length, 0);
      for (const file of originalFiles) {
        const retainedFile = await getRepository(LibraryFile).findOneByOrFail({
          id: file.id,
        });
        assert.equal(retainedFile.libraryPresenceId, f.presence.id);
        assert.equal(retainedFile.isCurrent, false);
        assert.ok(retainedFile.removedAt);
      }
      assert.equal(await getRepository(LibraryPresence).count(), 2);
      await retained(f, MediaRequestStatus.APPROVED);
    });

    it(`never-physical ${kind} remains outside Archived during repeated empty hydration`, async () => {
      const f = await fixture(kind, false, false);
      await getRepository(LibraryPresence).update(f.presence.id, {
        servarrHasFile: false,
      });
      await getRepository(LibrarySourceObservation).update(
        { libraryPresenceId: f.presence.id },
        { servarrHasFile: false }
      );
      for (let run = 0; run < 2; run++)
        assert.equal((await hydration(kind, 'empty').run()).complete, true);
      assert.equal(await getRepository(LibraryPresence).count(), 1);
      assert.equal((await query('current')).length, 0);
      assert.equal((await query('archive')).length, 0);
    });

    it(`failed ${kind} enumeration cannot close the last confirmed physical interval`, async () => {
      const f = await fixture(kind, false, false);
      assert.equal((await hydration(kind, 'failure').run()).complete, false);
      assert.equal(await getRepository(LibraryPresence).count(), 1);
      assert.equal(
        (
          await getRepository(LibraryPresence).findOneByOrFail({
            id: f.presence.id,
          })
        ).isCurrent,
        true
      );
      assert.equal((await query('current')).length, 1);
      assert.equal((await query('archive')).length, 0);
    });

    it(`stale empty ${kind} snapshot cannot split a newer physical interval`, async () => {
      const f = await fixture(kind, false, false);
      const result = await hydration(kind, 'empty', async () => {
        await dataSource.transaction('SERIALIZABLE', (manager) =>
          libraryHydrationEpoch.advance(
            manager,
            kind === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr',
            'service:0'
          )
        );
      }).run();
      assert.equal(result.complete, false);
      assert.equal(await getRepository(LibraryPresence).count(), 1);
      assert.equal(
        (
          await getRepository(LibraryPresence).findOneByOrFail({
            id: f.presence.id,
          })
        ).isCurrent,
        true
      );
      assert.equal((await query('current')).length, 1);
    });

    it(`failed ${kind} replacement insertion rolls back the physical interval closure`, async () => {
      const f = await fixture(kind, false, false);
      const failure: EntitySubscriberInterface<LibraryPresence> = {
        listenTo: () => LibraryPresence,
        beforeInsert: () => {
          throw Error('Injected replacement insert failure');
        },
      };
      dataSource.subscribers.push(failure);
      try {
        assert.equal((await hydration(kind, 'empty').run()).complete, false);
      } finally {
        dataSource.subscribers.splice(
          dataSource.subscribers.indexOf(failure),
          1
        );
      }
      const original = await getRepository(LibraryPresence).findOneByOrFail({
        id: f.presence.id,
      });
      assert.equal(original.isCurrent, true);
      assert.equal(original.servarrHasFile, true);
      assert.equal(original.removedAt, null);
      assert.equal(await getRepository(LibraryPresence).count(), 1);
      assert.equal((await query('current')).length, 1);
      assert.equal((await query('archive')).length, 0);
    });
  }
  for (const kind of [LibraryMediaType.MOVIE, LibraryMediaType.SERIES]) {
    for (const files of [false, true]) {
      it(`scheduled ${kind}, ${files ? 'file-backed archives' : 'presence-only archives'}`, async () => {
        const f = await fixture(kind, files),
          p = pipeline();
        const row = await schedule(p, f);
        const result = await p.scheduler.runScheduledRemovalProcessing();
        assert.equal(result.completed, 1);
        assert.equal(
          (await p.scheduler.runScheduledRemovalProcessing()).completed,
          0
        );
        assert.equal(p.calls.length, 1);
        const ended = await getRepository(LibraryPresence).findOneByOrFail({
          id: f.presence.id,
        });
        assert.equal(ended.isCurrent, false);
        assert.equal(ended.servarrHasFile, true);
        assert.equal(ended.removalSource, LibraryRemovalSource.SCHEDULED);
        assert.equal((await query('current')).length, 0);
        assert.equal((await query('archive')).length, 1);
        assert.equal((await query('current', 'yes')).length, 0);
        assert.equal(
          (await getRepository(RemovalSchedule).findOneByOrFail({ id: row.id }))
            .status,
          RemovalScheduleStatus.COMPLETED
        );
        assert.equal(
          await getRepository(RemovalExecution).countBy({
            canonicalMediaId: f.canonical.id,
            state: RemovalExecutionState.COMPLETED,
          }),
          1
        );
        assert.equal(
          (await getRepository(Media).findOneByOrFail({ id: f.media.id }))
            .status,
          MediaStatus.DELETED
        );
        if (files)
          assert.equal(
            await getRepository(LibraryFile).countBy({ isCurrent: false }),
            kind === LibraryMediaType.MOVIE ? 1 : 2
          );
        await retained(f);
      });
    }
  }
  it('scheduled Season removal leaves another Season Current and retains requests/watchlist', async () => {
    const f = await fixture(LibraryMediaType.SERIES, true),
      p = pipeline();
    await schedule(p, f, true);
    assert.equal(
      (await p.scheduler.runScheduledRemovalProcessing()).completed,
      1
    );
    assert.deepEqual(p.calls, [
      'unmonitor-season',
      'unmonitor-episodes',
      'delete:11',
    ]);
    assert.equal((await query('current')).length, 1);
    assert.equal((await query('archive')).length, 0);
    assert.equal(
      await getRepository(LibraryFile).countBy({ isCurrent: true }),
      1
    );
    assert.equal(
      await getRepository(LibraryFile).countBy({ isCurrent: false }),
      1
    );
    const media = await getRepository(Media).findOneByOrFail({
      id: f.media.id,
    });
    assert.equal(media.status, MediaStatus.PARTIALLY_AVAILABLE);
    assert.equal(
      media.seasons.find((s) => s.seasonNumber === 1)?.status,
      MediaStatus.DELETED
    );
    assert.equal(
      media.seasons.find((s) => s.seasonNumber === 2)?.status,
      MediaStatus.AVAILABLE
    );
    await retained(f, MediaRequestStatus.APPROVED);
  });
  it('scheduled whole-title removal leaves another physical source Current despite DELETED status', async () => {
    const f = await fixture(LibraryMediaType.MOVIE, false),
      p = pipeline();
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: f.canonical.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        sourceItemId: 'movie:99',
        sourceGeneration: '1',
        firstObservedAt: new Date(),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    await schedule(p, f);
    assert.equal(
      (await p.scheduler.runScheduledRemovalProcessing()).completed,
      1
    );
    assert.equal((await query('current')).length, 1);
    assert.equal((await query('archive')).length, 0);
    assert.equal(
      (await getRepository(Media).findOneByOrFail({ id: f.media.id })).status,
      MediaStatus.DELETED
    );
    await retained(f);
  });
  it('provider failure is quarantined without falsely closing Foundation or completing schedule', async () => {
    const f = await fixture(LibraryMediaType.MOVIE, true),
      p = pipeline('failure');
    const row = await schedule(p, f);
    assert.equal(
      (await p.scheduler.runScheduledRemovalProcessing()).completed,
      0
    );
    assert.equal(
      (await getRepository(RemovalSchedule).findOneByOrFail({ id: row.id }))
        .status,
      RemovalScheduleStatus.ACTIVE
    );
    assert.equal(
      await getRepository(RemovalExecution).countBy({
        state: RemovalExecutionState.UNCERTAIN,
      }),
      1
    );
    assert.equal((await query('current')).length, 1);
    assert.equal((await query('archive')).length, 0);
    await retained(f, MediaRequestStatus.APPROVED);
  });
  it('incomplete Season mutation remains uncertain, not falsely archived', async () => {
    const f = await fixture(LibraryMediaType.SERIES, true),
      p = pipeline('partial-season');
    const season = await getRepository(CanonicalSeason).findOneByOrFail({
      seriesId: f.canonical.id,
      seasonNumber: 1,
    });
    const episode = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: season.id, episodeNumber: 2 })
    );
    const file = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: f.presence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceFileId: 'episode-file:13',
        sourceGeneration: '1',
        firstObservedAt: new Date(),
        isCurrent: true,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: episode.id,
      })
    );
    await schedule(p, f, true);
    assert.equal(
      (await p.scheduler.runScheduledRemovalProcessing()).completed,
      0
    );
    assert.deepEqual(p.calls, [
      'unmonitor-season',
      'unmonitor-episodes',
      'delete:11',
      'delete:13',
    ]);
    assert.equal(
      await getRepository(LibraryFile).countBy({ isCurrent: true }),
      3
    );
    assert.equal(
      await getRepository(RemovalExecution).countBy({
        state: RemovalExecutionState.UNCERTAIN,
      }),
      1
    );
    assert.equal((await query('current')).length, 1);
  });
  it('Leaving Soon still displays a due manual schedule while processing is disabled', async () => {
    const f = await fixture(LibraryMediaType.MOVIE, true),
      p = pipeline();
    await schedule(p, f);
    assert.equal(getSettings().removal.removalProcessingEnabled, false);
    assert.equal(await runRemovalProcessing(), null);
    assert.equal((await query('current', 'yes')).length, 1);
    assert.equal((await p.scheduler.leavingSoon()).length, 1);
    assert.equal(p.calls.length, 0);
  });
  it('job gate permits existing schedules independently of Scan and automatic Movie/Series participation', async () => {
    const run = mock.method(
      defaultScheduler,
      'runScheduledRemovalProcessing',
      async () => ({
        completed: 0,
        cancelledForActivity: 0,
        deferred: 0,
        failed: 0,
      })
    );
    getSettings().removal.removalProcessingEnabled = true;
    await runRemovalProcessing();
    assert.equal(run.mock.callCount(), 1);
    assert.equal(getSettings().removal.removalScanEnabled, false);
    assert.equal(getSettings().removal.movie.enabled, false);
    assert.equal(getSettings().removal.series.enabled, false);
  });
});
