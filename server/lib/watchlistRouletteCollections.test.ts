import type {
  TmdbCollection,
  TmdbMovieResult,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import type { MovieLibraryStatus } from '@server/lib/watchlistLibraryStatus';
import {
  WATCHLIST_ROULETTE_MAX_COLLECTION_CANDIDATES,
  WATCHLIST_ROULETTE_MAX_METADATA_WARNINGS,
  WATCHLIST_ROULETTE_MAX_TMDB_RESOLUTIONS,
  WatchlistRouletteCollectionResolver,
  createWatchlistRouletteCollectionRunState,
  normalizeCollectionMovies,
  type MovieCollectionMembership,
  type WatchlistRouletteCollectionDependencies,
} from '@server/lib/watchlistRouletteCollections';
import logger from '@server/logger';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const movie = (
  id: number,
  releaseDate: string,
  membership: number | null | undefined = undefined
): TmdbMovieResult =>
  ({
    id,
    media_type: 'movie',
    title: `Movie ${id}`,
    original_title: `Movie ${id}`,
    release_date: releaseDate,
    adult: false,
    video: false,
    ...(membership !== undefined && {
      belongs_to_collection:
        membership === null
          ? null
          : { id: membership, name: `Collection ${membership}` },
    }),
  }) as TmdbMovieResult;

const collection = (id: number, parts: TmdbMovieResult[]): TmdbCollection => ({
  id,
  name: `Collection ${id}`,
  parts,
});

const dependencies = (
  overrides: Partial<WatchlistRouletteCollectionDependencies> = {}
): WatchlistRouletteCollectionDependencies => ({
  getLocalMembership: async () => ({ kind: 'standalone' }),
  getMovieForScan: async (tmdbId) => movie(tmdbId, '2020-01-01', null),
  getCollection: async (collectionId) =>
    collection(collectionId, [
      movie(1, '2001-01-01'),
      movie(2, '2002-01-01'),
      movie(3, '2003-01-01'),
      movie(4, '2004-01-01'),
    ]),
  classifyLibraryStatus: async (tmdbIds) =>
    new Map(tmdbIds.map((tmdbId) => [tmdbId, 'absent' as const])),
  nowMs: () => 0,
  ...overrides,
});

const resolve = (
  resolver: WatchlistRouletteCollectionResolver,
  tmdbId = 4,
  state = createWatchlistRouletteCollectionRunState()
) => resolver.resolve({ mediaType: MediaType.MOVIE, tmdbId }, state);

describe('Watchlist Roulette collection resolution', () => {
  const warningCalls = (warn: { mock: { calls: unknown[] } }) =>
    warn.mock.calls as {
      arguments: [string, Record<string, unknown>];
    }[];

  const assertSanitizedWarning = (
    warn: { mock: { calls: unknown[] } },
    expected: Record<string, unknown>
  ) => {
    const calls = warningCalls(warn);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].arguments[0],
      'Watchlist Roulette metadata resolution failed closed'
    );
    assert.deepEqual(calls[0].arguments[1], {
      label: 'Watchlist Roulette',
      ...expected,
    });
    assert.doesNotMatch(
      JSON.stringify(calls[0].arguments),
      /super-secret|private\.example|authorization/i
    );
  };

  it('keeps confirmed standalone Movies on the existing request path', async () => {
    let providerCalls = 0;
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({ kind: 'standalone' }),
        getMovieForScan: async (tmdbId) => {
          providerCalls += 1;
          return movie(tmdbId, '2020-01-01', null);
        },
      })
    );

    assert.deepEqual(await resolve(resolver, 77), {
      outcome: 'resolved',
      candidate: { mediaType: MediaType.MOVIE, tmdbId: 77 },
    });
    assert.equal(providerCalls, 0);
  });

  it('distinguishes provider-confirmed standalone Movies from failed or invalid membership', async () => {
    const unresolved = async (): Promise<MovieCollectionMembership> => ({
      kind: 'unresolved',
    });
    const standalone = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: unresolved,
        getMovieForScan: async (tmdbId) => movie(tmdbId, '2020-01-01', null),
      })
    );
    assert.equal((await resolve(standalone, 20)).outcome, 'resolved');

    let failedCalls = 0;
    const failed = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: unresolved,
        getMovieForScan: async () => {
          failedCalls += 1;
          throw new Error('TMDB unavailable');
        },
      })
    );
    assert.deepEqual(await resolve(failed, 20), { outcome: 'skip' });
    assert.equal(failedCalls, 1);

    const missing = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: unresolved,
        getMovieForScan: async (tmdbId) => movie(tmdbId, '2020-01-01'),
      })
    );
    assert.deepEqual(await resolve(missing, 20), { outcome: 'skip' });

    const mismatched = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: unresolved,
        getMovieForScan: async () => movie(21, '2020-01-01', null),
      })
    );
    assert.deepEqual(await resolve(mismatched, 20), { outcome: 'skip' });
  });

  it('warns safely and fails closed when local membership lookup fails', async (t) => {
    const warn = t.mock.method(logger, 'warn', () => logger);
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => {
          throw new Error(
            'authorization=super-secret https://private.example.test'
          );
        },
      })
    );

    assert.deepEqual(await resolve(resolver, 41), { outcome: 'skip' });
    assertSanitizedWarning(warn, {
      operation: 'local-membership',
      tmdbId: 41,
    });
  });

  it('warns safely and fails closed when TMDB Movie membership lookup fails', async (t) => {
    const warn = t.mock.method(logger, 'warn', () => logger);
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({ kind: 'unresolved' }),
        getMovieForScan: async () => {
          throw new Error('authorization=super-secret');
        },
      })
    );

    assert.deepEqual(await resolve(resolver, 42), { outcome: 'skip' });
    assertSanitizedWarning(warn, {
      operation: 'tmdb-movie-membership',
      tmdbId: 42,
    });
  });

  it('warns safely and fails closed when TMDB collection lookup fails', async (t) => {
    const warn = t.mock.method(logger, 'warn', () => logger);
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({
          kind: 'collection',
          collectionId: 701,
        }),
        getCollection: async () => {
          throw new Error('authorization=super-secret');
        },
      })
    );

    assert.deepEqual(await resolve(resolver, 43), { outcome: 'skip' });
    assertSanitizedWarning(warn, {
      operation: 'tmdb-collection',
      tmdbId: 43,
      collectionId: 701,
    });
  });

  it('warns safely and fails closed when Library classification fails', async (t) => {
    const warn = t.mock.method(logger, 'warn', () => logger);
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({
          kind: 'collection',
          collectionId: 702,
        }),
        getCollection: async () => collection(702, [movie(44, '2020-01-01')]),
        classifyLibraryStatus: async () => {
          throw new Error('authorization=super-secret');
        },
      })
    );

    assert.deepEqual(await resolve(resolver, 44), { outcome: 'skip' });
    assertSanitizedWarning(warn, {
      operation: 'library-classification',
      tmdbId: 44,
      collectionId: 702,
    });
  });

  it('bounds metadata failure warnings per run', async (t) => {
    const warn = t.mock.method(logger, 'warn', () => logger);
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => {
          throw new Error('provider unavailable');
        },
      })
    );
    const state = createWatchlistRouletteCollectionRunState();

    for (
      let index = 0;
      index < WATCHLIST_ROULETTE_MAX_METADATA_WARNINGS + 3;
      index += 1
    ) {
      assert.deepEqual(await resolve(resolver, index + 1, state), {
        outcome: 'skip',
      });
    }

    assert.equal(
      warningCalls(warn).length,
      WATCHLIST_ROULETTE_MAX_METADATA_WARNINGS
    );
    assert.equal(
      state.metadataWarnings,
      WATCHLIST_ROULETTE_MAX_METADATA_WARNINGS
    );
  });

  it('selects the earliest historically absent collection Movie', async () => {
    const cases: [Map<number, MovieLibraryStatus>, number][] = [
      [
        new Map([
          [1, 'absent'],
          [2, 'absent'],
          [3, 'absent'],
          [4, 'absent'],
        ]),
        1,
      ],
      [
        new Map([
          [1, 'active'],
          [2, 'absent'],
          [3, 'absent'],
          [4, 'absent'],
        ]),
        2,
      ],
      [
        new Map([
          [1, 'active'],
          [2, 'absent'],
          [3, 'archived'],
          [4, 'absent'],
        ]),
        2,
      ],
      [
        new Map([
          [1, 'archived'],
          [2, 'archived'],
          [3, 'archived'],
          [4, 'absent'],
        ]),
        4,
      ],
    ];

    for (const [statuses, expectedTmdbId] of cases) {
      const resolver = new WatchlistRouletteCollectionResolver(
        dependencies({
          getLocalMembership: async () => ({
            kind: 'collection',
            collectionId: 100,
          }),
          classifyLibraryStatus: async () => new Map(statuses),
        })
      );
      assert.deepEqual(await resolve(resolver), {
        outcome: 'resolved',
        candidate: { mediaType: MediaType.MOVIE, tmdbId: expectedTmdbId },
      });
    }
  });

  it('skips a collection when every Movie has physical history', async () => {
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({
          kind: 'collection',
          collectionId: 100,
        }),
        classifyLibraryStatus: async () =>
          new Map([
            [1, 'active'],
            [2, 'archived'],
            [3, 'archived'],
            [4, 'active'],
          ]),
      })
    );
    assert.deepEqual(await resolve(resolver), { outcome: 'skip' });
  });

  it('normalizes chronology independently of TMDB array order', () => {
    const normalized = normalizeCollectionMovies(
      collection(100, [
        movie(4, ''),
        movie(3, '2020-02-30'),
        movie(2, '2020-01-01'),
        movie(1, '2020-01-01'),
        movie(2, '2019-12-31'),
        movie(0, '2010-01-01'),
        movie(-1, '2010-01-01'),
      ]),
      100,
      4
    );
    assert.deepEqual(normalized, [
      { tmdbId: 2, releaseDate: '2019-12-31' },
      { tmdbId: 1, releaseDate: '2020-01-01' },
      { tmdbId: 3, releaseDate: null },
      { tmdbId: 4, releaseDate: null },
    ]);
  });

  it('allows a future release through chronology resolution', async () => {
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({
          kind: 'collection',
          collectionId: 100,
        }),
        getCollection: async () =>
          collection(100, [movie(4, '2026-01-01'), movie(5, '2030-01-01')]),
        classifyLibraryStatus: async () =>
          new Map([
            [4, 'active'],
            [5, 'absent'],
          ]),
      })
    );
    assert.deepEqual(await resolve(resolver), {
      outcome: 'resolved',
      candidate: { mediaType: MediaType.MOVIE, tmdbId: 5 },
    });
  });

  it('fails closed for collection lookup failures and identity conflicts', async () => {
    const localCollection = async (): Promise<MovieCollectionMembership> => ({
      kind: 'collection',
      collectionId: 100,
    });
    const failed = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: localCollection,
        getCollection: async () => {
          throw new Error('TMDB unavailable');
        },
      })
    );
    assert.deepEqual(await resolve(failed), { outcome: 'skip' });

    for (const invalid of [
      collection(101, [movie(4, '2020-01-01')]),
      collection(100, [movie(5, '2020-01-01')]),
      collection(100, [movie(4, '2020-01-01', 101)]),
    ]) {
      const resolver = new WatchlistRouletteCollectionResolver(
        dependencies({
          getLocalMembership: localCollection,
          getCollection: async () => invalid,
        })
      );
      assert.deepEqual(await resolve(resolver), { outcome: 'skip' });
    }
  });

  it('consumes one collection opportunity per run', async () => {
    let collectionCalls = 0;
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({
          kind: 'collection',
          collectionId: 100,
        }),
        getCollection: async (collectionId) => {
          collectionCalls += 1;
          return collection(collectionId, [
            movie(4, '2020-01-01'),
            movie(5, '2021-01-01'),
          ]);
        },
      })
    );
    const state = createWatchlistRouletteCollectionRunState();
    assert.equal((await resolve(resolver, 4, state)).outcome, 'resolved');
    assert.deepEqual(await resolve(resolver, 5, state), { outcome: 'skip' });
    assert.equal(collectionCalls, 1);
    assert.deepEqual([...state.examinedCollectionIds], [100]);
  });

  it('stops before a 26th Movie candidate enters metadata resolution', async () => {
    const resolver = new WatchlistRouletteCollectionResolver(dependencies());
    const state = createWatchlistRouletteCollectionRunState();
    for (
      let index = 0;
      index < WATCHLIST_ROULETTE_MAX_COLLECTION_CANDIDATES;
      index += 1
    ) {
      assert.equal(
        (await resolve(resolver, index + 1, state)).outcome,
        'resolved'
      );
    }
    assert.deepEqual(await resolve(resolver, 1000, state), {
      outcome: 'limit',
      limitReason: 'metadata-budget',
    });
    assert.equal(
      state.candidatesResolved,
      WATCHLIST_ROULETTE_MAX_COLLECTION_CANDIDATES
    );
  });

  it('stops before a TMDB invocation beyond the per-run limit', async () => {
    let collectionCalls = 0;
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({ kind: 'unresolved' }),
        getMovieForScan: async (tmdbId) => movie(tmdbId, '2020-01-01', 100),
        getCollection: async () => {
          collectionCalls += 1;
          return collection(100, [movie(4, '2020-01-01')]);
        },
      })
    );
    const state = createWatchlistRouletteCollectionRunState();
    state.tmdbResolutions = WATCHLIST_ROULETTE_MAX_TMDB_RESOLUTIONS - 1;
    assert.deepEqual(await resolve(resolver, 4, state), {
      outcome: 'limit',
      limitReason: 'metadata-budget',
    });
    assert.equal(
      state.tmdbResolutions,
      WATCHLIST_ROULETTE_MAX_TMDB_RESOLUTIONS
    );
    assert.equal(collectionCalls, 0);
  });

  it('checks the cumulative metadata deadline after awaited work', async () => {
    let now = 0;
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => {
          now = 60_000;
          return { kind: 'standalone' };
        },
        nowMs: () => now,
      })
    );
    assert.deepEqual(await resolve(resolver), {
      outcome: 'limit',
      limitReason: 'metadata-deadline',
    });
  });

  it('fails closed when historical classification is incomplete', async () => {
    const resolver = new WatchlistRouletteCollectionResolver(
      dependencies({
        getLocalMembership: async () => ({
          kind: 'collection',
          collectionId: 100,
        }),
        classifyLibraryStatus: async () => new Map([[1, 'absent']]),
      })
    );
    assert.deepEqual(await resolve(resolver), { outcome: 'skip' });
  });
});
