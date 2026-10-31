import TheMovieDb from '@server/api/themoviedb';
import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { Watchlist } from '@server/entity/Watchlist';
import backgroundDatabaseWriteCoordinator from '@server/lib/backgroundDatabaseWriteCoordinator';
import { persistMovieCollectionMembership } from '@server/lib/libraryCollectionMembership';
import {
  COLLECTION_RECOVERY_BATCH_SIZE,
  LibraryCollectionsService,
  type LibraryCollectionsDependencies,
  type LibraryCollectionsQuery,
} from '@server/lib/libraryCollections';
import { LibraryHistoryHydrationService } from '@server/lib/libraryHistoryHydration';
import type { JellyfinSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EntityManager, type EntityTarget } from 'typeorm';

setupTestDb();

const before = new Date('2026-10-29T00:00:00Z');
const observed = new Date('2026-10-30T00:00:00Z');
const query: LibraryCollectionsQuery = {
  take: 20,
  skip: 0,
  completeness: 'all',
  sort: 'name',
  sortDirection: 'asc',
  locale: 'en',
};
const notFound = () =>
  new Error('TMDB collection unavailable', {
    cause: { response: { status: 404 } },
  });
const movieDetails = (id: number, membership: unknown): TmdbMovieDetails =>
  ({
    id,
    belongs_to_collection: membership,
    status: 'Released',
  }) as TmdbMovieDetails;
const fixture = async (tmdbId = 100, collectionId = 10) => {
  const canonical = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: 'Preserved title',
      year: 2016,
      tmdbCollectionId: collectionId,
      collectionMembershipHydratedAt: before,
    })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: canonical.id,
      mediaType: LibraryMediaType.MOVIE,
      provider: 'tmdb',
      sourceScope: '',
      value: String(tmdbId),
    })
  );
  await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: canonical.id,
      sourceSystem: 'jellyfin',
      sourceScope: 'fixture',
      sourceItemId: `movie:${tmdbId}`,
      isCurrent: true,
      jellyfinVisible: true,
    })
  );
  return canonical;
};
const service = (overrides: Partial<LibraryCollectionsDependencies> = {}) =>
  new LibraryCollectionsService({
    fetchCollection: async () => {
      throw notFound();
    },
    fetchMovie: async (id) => movieDetails(id, null),
    fetchMovieMembership: async (id) => movieDetails(id, null),
    fetchAvailability: async () => new Map(),
    fetchPhysicalMovieIds: async () => new Set(),
    now: () => observed,
    ...overrides,
  });
const settle = async (instance: LibraryCollectionsService, input = query) => {
  let result = await instance.query(input);
  // Serialized SQLite writes may need more event-loop turns than parallel
  // writes. Bound actual elapsed time instead of incidental scheduling turns.
  const deadline = Date.now() + 5000;
  while (result.status === 'pending' && Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    result = await instance.query(input);
  }
  assert.notEqual(result.status, 'pending');
  return result;
};
const reload = (canonical: CanonicalMedia) =>
  getRepository(CanonicalMedia).findOneByOrFail({ id: canonical.id });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const within = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Fixture event timed out')),
          5000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe('Library collection 404 recovery', () => {
  for (const [label, membership, expected] of [
    ['authoritative null', null, null],
    ['replacement ID', { id: 20 }, 20],
  ] as const) {
    it(`preserves newer ${label} across the actual Foundation read/save window`, async (context) => {
      const canonical = await fixture();
      const media = await getRepository(Media).save(
        new Media({ tmdbId: 100, mediaType: MediaType.MOVIE }),
        { listeners: false }
      );
      const user = await getRepository(User).findOneByOrFail({ id: 1 });
      await getRepository(Watchlist).save(
        new Watchlist({
          media,
          requestedBy: user,
          tmdbId: 100,
          mediaType: MediaType.MOVIE,
          title: 'Fixture',
        })
      );
      await getRepository(ViewingEvidence).save(
        new ViewingEvidence({
          source: 'fixture',
          sourceScope: 'fixture',
          sourceClass: 'historical',
          sourceActivityId: 'overlap',
          canonicalMediaId: canonical.id,
          observedAt: before,
        })
      );
      const unrelated = async () =>
        Promise.all([
          getRepository(ViewingEvidence).find(),
          getRepository(Watchlist).find(),
          getRepository(Media).find(),
          getRepository(CanonicalMediaIdentity).find(),
          getRepository(LibraryPresence).find(),
        ]);
      const preserved = await unrelated();
      const loaded = deferred();
      const release = deferred();
      const queued = deferred();
      let paused = false;
      let persistenceQueued = false;
      let collectionNow = observed;
      let movieCalls = 0;
      const get = EntityManager.prototype.getRepository;
      context.mock.method(
        EntityManager.prototype,
        'getRepository',
        function (this: EntityManager, target: EntityTarget<object>) {
          const repository = get.call(this, target);
          const queryRunner = this.queryRunner;
          if (target !== CanonicalMedia) return repository;
          return new Proxy(repository, {
            get(instance, key, receiver) {
              if (key === 'findOneByOrFail')
                return async (...args: unknown[]) => {
                  const snapshot = await Reflect.apply(
                    instance.findOneByOrFail,
                    instance,
                    args
                  );
                  if (!paused && queryRunner?.isTransactionActive) {
                    paused = true;
                    assert.equal(
                      (snapshot as CanonicalMedia).tmdbCollectionId,
                      10
                    );
                    loaded.resolve();
                    await release.promise;
                  }
                  return snapshot;
                };
              return Reflect.get(instance, key, receiver);
            },
          });
        }
      );
      const exclusive = backgroundDatabaseWriteCoordinator.runExclusive.bind(
        backgroundDatabaseWriteCoordinator
      );
      context.mock.method(
        backgroundDatabaseWriteCoordinator,
        'runExclusive',
        <T>(work: () => Promise<T>) => {
          const pending = exclusive(work);
          if (paused) {
            persistenceQueued = true;
            queued.resolve();
          }
          return pending;
        }
      );
      const unexpected = () => {
        throw new Error('Unexpected provider call');
      };
      const foundation = new LibraryHistoryHydrationService({
        radarrServers: () => [],
        sonarrServers: () => [],
        jellyfinSettings: () =>
          ({
            serverId: 'fixture',
            apiKey: '',
            libraries: [],
          }) as unknown as JellyfinSettings,
        createJellyfinContext: async () => undefined,
        createRadarrClient: unexpected,
        createSonarrClient: unexpected,
        createQueryMetadataClient: () => ({
          // No collection observation here: preserve the original metadata path.
          getMovieForScan: async ({ movieId }) => ({
            id: movieId,
            title: 'Preserved title',
            release_date: '2016-01-01',
          }),
          getTvShowForScan: unexpected,
          getShowByTvdbIdForScan: unexpected,
          resolveImdbIdForScan: unexpected,
        }),
        now: () => observed,
      });
      const instance = service({
        now: () => collectionNow,
        fetchMovieMembership: async (id) => {
          movieCalls++;
          assert.equal(backgroundDatabaseWriteCoordinator.isRunning(), true);
          return movieDetails(id, membership);
        },
      });
      const hydration = foundation.run();
      let recovery: Promise<unknown> | undefined;
      let waiting: CanonicalMedia | undefined;
      let wasQueued = false;
      try {
        await within(loaded.promise);
        recovery = settle(instance);
        // With the old code recovery completes inside Foundation's paused
        // transaction. With the correction only its write queues behind it.
        await within(Promise.race([queued.promise, recovery]));
        waiting = await reload(canonical);
        wasQueued =
          persistenceQueued &&
          movieCalls === 1 &&
          backgroundDatabaseWriteCoordinator.isRunning();
        collectionNow = new Date(observed.getTime() + 1000);
      } finally {
        release.resolve();
        await hydration;
        await recovery;
      }
      const stored = await reload(canonical);
      assert.equal(stored.tmdbCollectionId, expected);
      assert.equal(
        stored.collectionMembershipHydratedAt?.toISOString(),
        observed.toISOString()
      );
      assert.equal(waiting?.tmdbCollectionId, 10);
      assert.equal(
        waiting?.collectionMembershipHydratedAt?.toISOString(),
        before.toISOString()
      );
      assert.equal(wasQueued, true);
      assert.equal((await hydration).complete, true);
      assert.equal(stored.currentMediaId, media.id);
      assert.equal(stored.titleSnapshot, canonical.titleSnapshot);
      assert.equal(stored.year, canonical.year);
      assert.equal(
        stored.createdAt.toISOString(),
        canonical.createdAt.toISOString()
      );
      assert.deepEqual(await unrelated(), preserved);
      assert.equal(backgroundDatabaseWriteCoordinator.isRunning(), false);
    });
  }

  it('does not hold or wait for the database coordinator during TMDB reads', async () => {
    const canonical = await fixture();
    const entered = deferred();
    const release = deferred();
    const instance = service({
      fetchMovieMembership: async (id) => {
        entered.resolve();
        await release.promise;
        return movieDetails(id, null);
      },
    });
    const recovery = settle(instance);
    try {
      await within(entered.promise);
      assert.equal(backgroundDatabaseWriteCoordinator.isRunning(), false);
      assert.equal(
        await within(
          backgroundDatabaseWriteCoordinator.runExclusive(
            async () => 'other writer'
          )
        ),
        'other writer'
      );
      assert.equal((await reload(canonical)).tmdbCollectionId, 10);
    } finally {
      release.resolve();
      await recovery;
    }
    assert.equal((await reload(canonical)).tmdbCollectionId, null);
    assert.equal(backgroundDatabaseWriteCoordinator.isRunning(), false);
  });

  it('releases coordinator ownership after a failed recovery write and permits later retry', async () => {
    const canonical = await fixture();
    let now = observed;
    const instance = service({ now: () => now });
    await dataSource.query(
      'CREATE TRIGGER fail_recovery BEFORE UPDATE OF "tmdbCollectionId" ON "canonical_media" BEGIN SELECT RAISE(ABORT, \'fixture recovery failure\'); END'
    );
    try {
      await settle(instance);
      assert.equal((await reload(canonical)).tmdbCollectionId, 10);
      assert.equal(
        (await reload(canonical)).collectionMembershipHydratedAt?.toISOString(),
        before.toISOString()
      );
      assert.equal(backgroundDatabaseWriteCoordinator.isRunning(), false);
      assert.equal(
        await within(
          backgroundDatabaseWriteCoordinator.runExclusive(
            async () => 'next writer'
          )
        ),
        'next writer'
      );
    } finally {
      await dataSource.query('DROP TRIGGER fail_recovery');
    }
    now = new Date(observed.getTime() + 60_000);
    await settle(instance);
    assert.equal((await reload(canonical)).tmdbCollectionId, null);
    assert.equal(backgroundDatabaseWriteCoordinator.isRunning(), false);
  });

  it('bypasses cached null metadata without changing the display cache', async (context) => {
    const canonical = await fixture(987654321);
    const tmdb = new TheMovieDb();
    const transport = (
      tmdb as unknown as {
        axios: { get: (path: string, options: unknown) => Promise<unknown> };
      }
    ).axios;
    const calls: { path: string; options: unknown }[] = [];
    context.mock.method(
      transport,
      'get',
      async (path: string, options: unknown) => {
        calls.push({ path, options });
        return {
          data: movieDetails(987654321, calls.length === 1 ? null : { id: 10 }),
        };
      }
    );
    const cached = await tmdb.getMovie({ movieId: 987654321, language: 'en' });
    assert.equal(cached.belongs_to_collection, null);
    // A newer persisted observation must not be cleared by that older cache hit.
    const newer = new Date(before.getTime() + 1000);
    await getRepository(CanonicalMedia).update(canonical.id, {
      collectionMembershipHydratedAt: newer,
    });
    await settle(
      service({
        fetchMovieMembership: (id) => tmdb.getMovieCollectionMembership(id),
      })
    );
    assert.equal((await reload(canonical)).tmdbCollectionId, 10);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], {
      path: '/movie/987654321',
      options: { params: { language: 'en' } },
    });
    assert.equal(
      (await tmdb.getMovie({ movieId: 987654321, language: 'en' }))
        .belongs_to_collection,
      null
    );
    assert.equal(calls.length, 2);
  });

  it('bounds each attempt and eventually visits over 2,000 Movies, then retries failed targets', async () => {
    const count = 2051;
    // Real SQLite rows, inserted in chunks to stay below SQLite parameter limits.
    for (let offset = 0; offset < count; offset += 50) {
      const entries = Array.from(
        { length: Math.min(50, count - offset) },
        (_, index) => offset + index
      );
      await getRepository(CanonicalMedia).insert(
        entries.map((index) => ({
          id: 10000 + index,
          mediaType: LibraryMediaType.MOVIE,
          tmdbCollectionId: 10,
          collectionMembershipHydratedAt: before,
        }))
      );
      await getRepository(CanonicalMediaIdentity).insert(
        entries.map((index) => ({
          canonicalMediaId: 10000 + index,
          mediaType: LibraryMediaType.MOVIE,
          provider: 'tmdb',
          sourceScope: '',
          value: String(20000 + index),
        }))
      );
    }
    let now = observed;
    let calls = 0;
    let active = 0;
    let peak = 0;
    let firstAttempts = 0;
    const seen = new Set<number>();
    const instance = service({
      discoverCollectionIds: async () => [10],
      now: () => now,
      fetchMovieMembership: async (id) => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        seen.add(id);
        if (id === 20000 && ++firstAttempts === 1)
          throw new Error('Transient failure');
        return movieDetails(id, null);
      },
    });
    const attempts = Math.ceil(count / COLLECTION_RECOVERY_BATCH_SIZE);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const previous = calls;
      await settle(instance);
      assert.ok(
        calls - previous > 0 &&
          calls - previous <= COLLECTION_RECOVERY_BATCH_SIZE
      );
      now = new Date(now.getTime() + 60_000);
    }
    assert.equal(seen.size, count);
    assert.equal(calls, count);
    assert.ok(peak > 1 && peak <= 4);
    assert.equal(active, 0);
    assert.equal(
      await getRepository(CanonicalMedia).countBy({ tmdbCollectionId: 10 }),
      1
    );
    await settle(instance);
    assert.equal(firstAttempts, 2);
    assert.equal(calls, count + 1);
    assert.equal(
      await getRepository(CanonicalMedia).countBy({ tmdbCollectionId: 10 }),
      0
    );
  });

  it('shares recovery across concurrent locales and releases failed single-flight attempts', async () => {
    const canonical = await fixture();
    let now = observed;
    let calls = 0;
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const instance = service({
      now: () => now,
      fetchMovieMembership: async (id) => {
        calls++;
        started();
        await blocked;
        if (calls === 1) throw new Error('Transient failure');
        return movieDetails(id, null);
      },
    });
    await Promise.all([
      instance.query(query),
      instance.query({ ...query, locale: 'fr' }),
    ]);
    await entered;
    // Let the second locale reach the same blocked collection-ID recovery.
    for (let turn = 0; turn < 20; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([
      settle(instance),
      settle(instance, { ...query, locale: 'fr' }),
    ]);
    assert.equal(calls, 1);
    assert.equal(
      (await reload(canonical)).collectionMembershipHydratedAt?.toISOString(),
      before.toISOString()
    );
    now = new Date(now.getTime() + 60_000);
    await Promise.all([
      settle(instance),
      settle(instance, { ...query, locale: 'fr' }),
    ]);
    assert.equal(calls, 2);
    assert.equal((await reload(canonical)).tmdbCollectionId, null);
  });

  it('fences a delayed fresh response after a newer membership observation', async () => {
    const canonical = await fixture();
    const instance = service({
      fetchMovieMembership: async (id) => {
        await persistMovieCollectionMembership(getRepository(CanonicalMedia), {
          canonicalMediaId: canonical.id,
          expectedCollectionId: 10,
          collectionMembership: {
            tmdbCollectionId: 20,
            observedAt: new Date(observed.getTime() + 1000),
          },
        });
        return movieDetails(id, null);
      },
    });
    await settle(instance);
    const stored = await reload(canonical);
    assert.equal(stored.tmdbCollectionId, 20);
    assert.equal(
      stored.collectionMembershipHydratedAt?.toISOString(),
      new Date(observed.getTime() + 1000).toISOString()
    );
  });

  for (const [label, membership, expected] of [
    ['unchanged valid membership', { id: 10 }, 10],
    ['replacement membership', { id: 20 }, 20],
    ['authoritative non-membership', null, null],
  ] as const) {
    it(`reconciles ${label} from Movie details, not the collection 404`, async () => {
      const canonical = await fixture();
      await settle(
        service({
          fetchMovieMembership: async (id) => movieDetails(id, membership),
        })
      );
      const stored = await reload(canonical);
      assert.equal(stored.tmdbCollectionId, expected);
      assert.equal(
        stored.collectionMembershipHydratedAt?.toISOString(),
        observed.toISOString()
      );
      assert.equal(stored.titleSnapshot, canonical.titleSnapshot);
      assert.equal(stored.year, canonical.year);
    });
  }

  for (const [label, response] of [
    ['missing field', { id: 100 }],
    ['undefined field', { id: 100, belongs_to_collection: undefined }],
    ['malformed membership', { id: 100, belongs_to_collection: { id: '20' } }],
    ['invalid membership', { id: 100, belongs_to_collection: { id: 0 } }],
    ['wrong Movie identity', { id: 101, belongs_to_collection: null }],
    ['malformed Movie response', null],
  ] as const) {
    it(`preserves membership and observation time for ${label}`, async () => {
      const canonical = await fixture();
      await settle(
        service({
          fetchMovieMembership: async () =>
            response as unknown as TmdbMovieDetails,
        })
      );
      const stored = await reload(canonical);
      assert.equal(stored.tmdbCollectionId, 10);
      assert.equal(
        stored.collectionMembershipHydratedAt?.toISOString(),
        before.toISOString()
      );
    });
  }

  it('retries failed Movie recovery independently of the six-hour 404 cache, with a cooldown', async () => {
    const canonical = await fixture();
    let now = observed;
    let collections = 0;
    let movies = 0;
    const instance = service({
      fetchCollection: async () => {
        collections++;
        throw notFound();
      },
      fetchMovieMembership: async (id) => {
        movies++;
        if (movies === 1) throw new Error('Movie lookup timed out');
        return movieDetails(id, null);
      },
      now: () => now,
    });
    await settle(instance);
    now = new Date(now.getTime() + 59_999);
    await settle(instance, { ...query, locale: 'fr' });
    assert.equal(collections, 1);
    assert.equal(movies, 1);
    assert.equal((await reload(canonical)).tmdbCollectionId, 10);
    assert.equal(
      (await reload(canonical)).collectionMembershipHydratedAt?.toISOString(),
      before.toISOString()
    );
    now = new Date(now.getTime() + 1);
    await settle(instance);
    assert.equal(collections, 1);
    assert.equal(movies, 2);
    assert.equal((await reload(canonical)).tmdbCollectionId, null);
    assert.equal(
      (await reload(canonical)).collectionMembershipHydratedAt?.toISOString(),
      now.toISOString()
    );
  });

  it('permits a restored collection after backoff and preserves valid navigation/display', async () => {
    await fixture();
    let now = observed;
    let calls = 0;
    const instance = service({
      fetchCollection: async (id) => {
        calls++;
        if (calls === 1) throw notFound();
        return {
          id,
          name: 'Restored collection',
          parts: [{ id: 100 }],
          poster_path: '/fixture.jpg',
        } as never;
      },
      fetchMovie: async (id) => movieDetails(id, { id: 10 }),
      fetchMovieMembership: async (id) => movieDetails(id, { id: 10 }),
      fetchAvailability: async () => new Map([[100, true]]),
      now: () => now,
    });
    assert.equal((await settle(instance)).status, 'unavailable');
    now = new Date(observed.getTime() + 6 * 60 * 60 * 1000);
    const restored = await settle(instance);
    assert.equal(calls, 2);
    assert.equal(restored.status, 'complete');
    assert.equal(restored.results[0].id, 10);
    assert.equal(restored.results[0].name, 'Restored collection');
    assert.equal(restored.results[0].posterPath, '/fixture.jpg');
    assert.equal(restored.results[0].totalMovies, 1);
    assert.equal(restored.results[0].availableMovies, 1);
  });

  it('does not negative-cache non-404 failures or reconcile membership from them', async () => {
    const canonical = await fixture();
    let now = observed;
    let calls = 0;
    let movieCalls = 0;
    const instance = service({
      fetchCollection: async () => {
        calls++;
        throw new Error('TMDB unavailable', {
          cause: { response: { status: 503 } },
        });
      },
      fetchMovieMembership: async (id) => {
        movieCalls++;
        return movieDetails(id, null);
      },
      now: () => now,
    });
    await settle(instance);
    now = new Date(now.getTime() + 30_000);
    await settle(instance);
    assert.equal(calls, 2);
    assert.equal(movieCalls, 0);
    assert.equal((await reload(canonical)).tmdbCollectionId, 10);
  });

  it('handles shared collections independently and preserves all other tables', async () => {
    const first = await fixture(100);
    const second = await fixture(200);
    const unrelated = await fixture(300, 30);
    const unchangedUnrelated = await reload(unrelated);
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 100, mediaType: MediaType.MOVIE }),
      { listeners: false }
    );
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
      }),
      { listeners: false }
    );
    await getRepository(Watchlist).save(
      new Watchlist({
        media,
        requestedBy: user,
        tmdbId: 100,
        mediaType: MediaType.MOVIE,
        title: 'Fixture',
      })
    );
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'fixture',
        sourceScope: 'fixture',
        sourceClass: 'historical',
        sourceActivityId: 'fixture',
        canonicalMediaId: first.id,
        observedAt: before,
      })
    );
    const tables = (await dataSource.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('canonical_media','sqlite_sequence') ORDER BY name"
    )) as { name: string }[];
    const fingerprint = async () => {
      const values: unknown[] = [];
      for (const { name } of tables)
        values.push([
          name,
          await dataSource.query(
            `SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`
          ),
        ]);
      return JSON.stringify(values);
    };
    const unchanged = await fingerprint();
    await settle(
      service({
        fetchCollection: async (id) => {
          if (id === 10) throw notFound();
          return {
            id,
            name: 'Unaffected collection',
            parts: [{ id: 300 }],
          } as never;
        },
        fetchMovieMembership: async (id) =>
          movieDetails(id, id === 100 ? null : { id: 10 }),
      })
    );
    assert.equal((await reload(first)).tmdbCollectionId, null);
    assert.equal((await reload(second)).tmdbCollectionId, 10);
    assert.deepEqual(await reload(unrelated), unchangedUnrelated);
    assert.equal(await fingerprint(), unchanged);
    assert.equal(
      (await dataSource.query('PRAGMA quick_check'))[0].quick_check,
      'ok'
    );
    assert.deepEqual(await dataSource.query('PRAGMA foreign_key_check'), []);
  });

  it('keeps recovery Movie requests bounded across multiple missing collections', async () => {
    for (const id of [100, 101, 102, 103, 104, 200, 201, 202, 203, 204])
      await fixture(id, id < 200 ? 10 : 20);
    let active = 0;
    let peak = 0;
    let calls = 0;
    await settle(
      service({
        fetchMovieMembership: async (id) => {
          calls++;
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setImmediate(resolve));
          active--;
          return movieDetails(id, { id: id < 200 ? 10 : 20 });
        },
      })
    );
    assert.equal(calls, 10);
    assert.ok(peak > 1 && peak <= 4);
    assert.equal(active, 0);
  });

  it('backs off 404s with an existing last-good snapshot as well as cold failures', async () => {
    await fixture();
    let now = observed;
    let calls = 0;
    const instance = service({
      fetchCollection: async (id) => {
        calls++;
        if (calls > 1) throw notFound();
        return { id, name: 'Last good', parts: [{ id: 100 }] } as never;
      },
      fetchMovie: async (id) => movieDetails(id, { id: 10 }),
      fetchMovieMembership: async (id) => movieDetails(id, { id: 10 }),
      now: () => now,
      snapshotTtlMs: 1000,
    });
    assert.equal((await settle(instance)).status, 'complete');
    for (let attempt = 0; attempt < 4; attempt++) {
      now = new Date(now.getTime() + 2000);
      const result = await settle(instance);
      assert.equal(result.status, 'partial');
      assert.equal(result.results[0].name, 'Last good');
    }
    assert.equal(calls, 2);
  });

  it('retries Movie failure from a warm snapshot without another collection fetch', async () => {
    const canonical = await fixture();
    let now = observed;
    let collections = 0;
    let movies = 0;
    const instance = service({
      now: () => now,
      fetchCollection: async (id) => {
        if (++collections > 1) throw notFound();
        return { id, name: 'Last good', parts: [{ id: 100 }] } as never;
      },
      fetchMovieMembership: async (id) => {
        if (++movies === 1) throw new Error('Transient failure');
        return movieDetails(id, null);
      },
    });
    assert.equal((await settle(instance)).status, 'complete');
    assert.equal(movies, 0); // Valid collection behavior does not invoke recovery.
    now = new Date(now.getTime() + 15 * 60_000);
    assert.equal((await settle(instance)).status, 'partial');
    assert.equal(collections, 2);
    assert.equal(movies, 1);
    now = new Date(now.getTime() + 60_000);
    await settle(instance);
    assert.equal(collections, 2);
    assert.equal(movies, 2);
    assert.equal((await reload(canonical)).tmdbCollectionId, null);
  });

  it('permits recovery after service restart without persisted negative-cache state', async () => {
    const canonical = await fixture();
    await settle(
      service({
        fetchMovieMembership: async () => {
          throw new Error('Transient failure');
        },
      })
    );
    assert.equal(
      (await reload(canonical)).collectionMembershipHydratedAt?.toISOString(),
      before.toISOString()
    );
    // A new service models restart; no persistent retry marker blocks recovery.
    await settle(service());
    assert.equal((await reload(canonical)).tmdbCollectionId, null);
  });

  it('rejects ambiguous canonical Movie identities without provider lookups', async () => {
    const canonical = await fixture();
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '200',
      })
    );
    let calls = 0;
    await settle(
      service({
        fetchMovieMembership: async (id) => {
          calls++;
          return movieDetails(id, null);
        },
      })
    );
    assert.equal(calls, 0);
    assert.equal((await reload(canonical)).tmdbCollectionId, 10);
  });

  it('fences older observations and changes to the expected collection association', async () => {
    const canonical = await fixture();
    const repository = getRepository(CanonicalMedia);
    assert.equal(
      await persistMovieCollectionMembership(repository, {
        canonicalMediaId: canonical.id,
        expectedCollectionId: 10,
        collectionMembership: {
          tmdbCollectionId: null,
          observedAt: new Date(before.getTime() - 1000),
        },
      }),
      false
    );
    assert.equal(
      await persistMovieCollectionMembership(repository, {
        canonicalMediaId: canonical.id,
        expectedCollectionId: 10,
        collectionMembership: { tmdbCollectionId: 20, observedAt: observed },
      }),
      true
    );
    assert.equal(
      await persistMovieCollectionMembership(repository, {
        canonicalMediaId: canonical.id,
        expectedCollectionId: 10,
        collectionMembership: {
          tmdbCollectionId: null,
          observedAt: new Date(observed.getTime() + 1000),
        },
      }),
      false
    );
    assert.equal((await reload(canonical)).tmdbCollectionId, 20);
  });
});
