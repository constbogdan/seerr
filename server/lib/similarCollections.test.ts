import type {
  TmdbCollection,
  TmdbSearchMovieResponse,
} from '@server/api/themoviedb/interfaces';
import dataSource from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import { SimilarCollectionRelation } from '@server/entity/SimilarCollectionRelation';
import { SimilarCollectionSeedProgress } from '@server/entity/SimilarCollectionSeedProgress';
import type { MovieCollectionBatch } from '@server/lib/movieCollectionMembership';
import {
  SimilarCollectionsService,
  type SimilarCollectionsDependencies,
} from '@server/lib/similarCollections';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const visit = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const collection = (ids: number[], released = true): TmdbCollection =>
  ({
    id: 100,
    name: 'Origin',
    parts: ids.map((id) => ({
      id,
      release_date: released ? '2020-01-01' : '2099-01-01',
    })),
  }) as TmdbCollection;
const page = (
  ids: number[],
  totalPages: number,
  number = 1
): TmdbSearchMovieResponse =>
  ({
    page: number,
    total_pages: totalPages,
    total_results: ids.length,
    results: ids.map((id) => ({ id })),
  }) as TmdbSearchMovieResponse;
const memberships = (
  ids: number[],
  values: Record<number, number | 'unresolved' | null>
): MovieCollectionBatch =>
  ({
    results: new Map(
      ids.map((id) => [
        id,
        {
          membership:
            values[id] === 'unresolved'
              ? { kind: 'unresolved' }
              : values[id] == null
                ? { kind: 'standalone' }
                : { kind: 'collection', collectionId: values[id] },
          observedAt: null,
          stale: false,
          source: 'unresolved',
        },
      ])
    ),
    stats: {
      canonicalHits: 0,
      observationHits: 0,
      tmdbFallbackCalls: 0,
      unresolved: 0,
    },
  }) as MovieCollectionBatch;

const fixture = (
  options: {
    seeds?: number[];
    pages?: (seed: number, number: number) => TmdbSearchMovieResponse;
    resolve?: SimilarCollectionsDependencies['resolve'];
    now?: () => Date;
  } = {}
) => {
  const work: (() => Promise<void>)[] = [];
  const calls: [number, number][] = [];
  const service = new SimilarCollectionsService(dataSource, {
    collection: async () => collection(options.seeds ?? [1]),
    recommendations: async (seed, number) => {
      calls.push([seed, number]);
      return (
        options.pages?.(seed, number) ?? page([seed + number + 100], 1, number)
      );
    },
    resolve:
      options.resolve ??
      (async (movies) =>
        memberships(
          movies.map((movie) => movie.tmdbId),
          Object.fromEntries(
            movies.map((movie) => [movie.tmdbId, movie.tmdbId + 1000])
          )
        )),
    now: options.now ?? (() => new Date('2026-11-16T00:00:00Z')),
    randomIndex: () => 0,
    dispatch: (task) => {
      work.push(task);
    },
  });
  const runVisit = async (number: number) => {
    const started = await service.trigger(100, visit(number));
    if (started.started) await work.shift()?.();
    return started;
  };
  return { service, work, calls, runVisit };
};

describe('persistent Similar Collections discovery', () => {
  it('processes one seed per visit and eventually covers two and twenty released seeds', async () => {
    for (const count of [2, 20]) {
      const test = fixture({
        seeds: Array.from({ length: count }, (_, i) => i + 1),
      });
      for (let n = 1; n <= count; n++)
        assert.deepEqual(await test.runVisit(n), { started: true });
      assert.equal(test.calls.length, count);
      assert.deepEqual(
        test.calls.map(([seed]) => seed),
        Array.from({ length: count }, (_, i) => i + 1)
      );
      assert.equal((await test.service.read(100)).completedSeedCount, count);
      await test.runVisit(count + 1);
      assert.equal(test.calls.length, count);
      await dataSource.getRepository(SimilarCollectionRelation).clear();
      await dataSource.getRepository(SimilarCollectionSeedProgress).clear();
    }
    assert.equal(await dataSource.getRepository(CanonicalMedia).count(), 0);
  });

  it('retains the reported page count while never fetching page four', async () => {
    const test = fixture({ pages: (_seed, n) => page([n + 200], 27, n) });
    await test.runVisit(1);
    assert.deepEqual(test.calls, [
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    const progress = await dataSource
      .getRepository(SimilarCollectionSeedProgress)
      .findOneByOrFail({ originCollectionId: 100, seedMovieId: 1 });
    assert.equal(progress.nextPage, 4);
    assert.equal(progress.reportedTotalPages, 27);
    assert.ok(progress.completedAt);
    await test.runVisit(2);
    assert.equal(test.calls.length, 3);
  });

  it('does not advance the checkpoint when TMDB returns a different page', async () => {
    const test = fixture({ pages: () => page([201], 3, 2) });
    await test.runVisit(1);
    assert.deepEqual(test.calls, [[1, 1]]);
    const progress = await dataSource
      .getRepository(SimilarCollectionSeedProgress)
      .findOneByOrFail({ originCollectionId: 100, seedMovieId: 1 });
    assert.equal(progress.nextPage, 1);
    assert.equal(progress.failureCount, 1);
    assert.ok(progress.retryAfter);
    assert.equal(
      await dataSource.getRepository(SimilarCollectionRelation).count(),
      0
    );
  });

  it('keeps confirmed links on unresolved page and resumes only that page after backoff', async () => {
    let now = new Date('2026-11-16T00:00:00Z');
    let resolveCount = 0;
    const test = fixture({
      now: () => now,
      pages: (_seed, n) => page(n === 1 ? [201] : [202, 203], 2, n),
      resolve: async (movies) => {
        resolveCount++;
        const ids = movies.map((movie) => movie.tmdbId);
        return memberships(
          ids,
          resolveCount === 2
            ? { 202: 302, 203: 'unresolved' }
            : { 201: 301, 202: 302, 203: 303 }
        );
      },
    });
    await test.runVisit(1);
    assert.deepEqual(test.calls, [
      [1, 1],
      [1, 2],
    ]);
    assert.deepEqual(
      (await test.service.read(100)).relatedCollectionIds.sort(),
      [301, 302]
    );
    let progress = await dataSource
      .getRepository(SimilarCollectionSeedProgress)
      .findOneByOrFail({ originCollectionId: 100, seedMovieId: 1 });
    assert.equal(progress.nextPage, 2);
    assert.ok(progress.retryAfter);
    await test.runVisit(2);
    assert.equal(test.calls.length, 2);
    now = new Date('2026-11-16T00:01:01Z');
    await test.runVisit(3);
    assert.deepEqual(test.calls, [
      [1, 1],
      [1, 2],
      [1, 2],
    ]);
    progress = await dataSource
      .getRepository(SimilarCollectionSeedProgress)
      .findOneByOrFail({ originCollectionId: 100, seedMovieId: 1 });
    assert.ok(progress.completedAt);
    assert.deepEqual(
      (await test.service.read(100)).relatedCollectionIds.sort(),
      [301, 302, 303]
    );
  });

  it('deduplicates overlapping related IDs but preserves seed provenance and no result cap', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => i + 200);
    const test = fixture({
      seeds: [1, 2],
      pages: () => page(ids, 1),
      resolve: async (movies) =>
        memberships(
          movies.map((movie) => movie.tmdbId),
          Object.fromEntries(
            movies.map((movie) => [
              movie.tmdbId,
              movie.tmdbId === 200 ? 100 : movie.tmdbId + 1000,
            ])
          )
        ),
    });
    await test.runVisit(1);
    await test.runVisit(2);
    const read = await test.service.read(100);
    assert.equal(read.relatedCollectionIds.length, 20);
    assert.equal(
      await dataSource.getRepository(SimilarCollectionRelation).count(),
      40
    );
    assert.equal(await dataSource.getRepository(CanonicalMedia).count(), 0);
  });

  it('rejects duplicate/concurrent visits, expires claims, and prevents stale worker commits', async () => {
    let now = new Date('2026-11-16T00:00:00Z');
    const test = fixture({ now: () => now });
    assert.deepEqual(await test.service.trigger(100, visit(1)), {
      started: true,
    });
    assert.deepEqual(await test.service.trigger(100, visit(1)), {
      started: false,
    });
    assert.deepEqual(await test.service.trigger(100, visit(2)), {
      started: false,
    });
    now = new Date('2026-11-16T00:05:01Z');
    assert.deepEqual(await test.service.trigger(100, visit(2)), {
      started: true,
    });
    await test.work[0]();
    assert.equal(
      await dataSource.getRepository(SimilarCollectionRelation).count(),
      0
    );
    assert.equal(
      await dataSource.getRepository(SimilarCollectionSeedProgress).count(),
      1
    );
    await test.work[1]();
    assert.equal(
      await dataSource.getRepository(SimilarCollectionRelation).count(),
      1
    );
    assert.deepEqual(await test.service.trigger(100, visit(2)), {
      started: false,
    });
  });

  it('grants exactly one claim across concurrent trigger calls', async () => {
    const first = fixture();
    const second = fixture();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 === 0 ? first : second).service.trigger(100, visit(i + 1))
      )
    );
    assert.equal(results.filter((result) => result.started).length, 1);
    assert.equal(first.work.length + second.work.length, 1);
    await (first.work[0] ?? second.work[0])();
    assert.equal(first.calls.length + second.calls.length, 1);
  });

  it('fences a worker paused after resolution when another visit takes its expired claim', async () => {
    let now = new Date('2026-11-16T00:00:00Z');
    let allowOldResolution!: () => void;
    let oldResolverStarted!: () => void;
    const oldResolverBlocked = new Promise<void>((resolve) => {
      allowOldResolution = resolve;
    });
    const oldResolverEntered = new Promise<void>((resolve) => {
      oldResolverStarted = resolve;
    });
    const old = fixture({
      now: () => now,
      pages: () => page([201], 1),
      resolve: async () => {
        oldResolverStarted();
        await oldResolverBlocked;
        return memberships([201], { 201: 301 });
      },
    });
    await old.service.trigger(100, visit(1));
    const staleWork = old.work[0]();
    await oldResolverEntered;
    now = new Date('2026-11-16T00:05:01Z');
    const newer = fixture({
      now: () => now,
      pages: () => page([201], 1),
      resolve: async () => memberships([201], { 201: 302 }),
    });
    await newer.runVisit(2);
    allowOldResolution();
    await staleWork;
    assert.deepEqual(
      (await newer.service.read(100)).relatedCollectionIds,
      [302]
    );
    assert.equal((await newer.service.read(100)).completedSeedCount, 1);
  });

  it('resumes a committed checkpoint with a new service after a failed page', async () => {
    let now = new Date('2026-11-16T00:00:00Z');
    const first = fixture({
      now: () => now,
      pages: (_seed, n) => page([n + 200], 3, n),
      resolve: async (movies) =>
        memberships(
          movies.map((movie) => movie.tmdbId),
          { 201: 301, 202: 'unresolved' }
        ),
    });
    await first.runVisit(1);
    assert.deepEqual(first.calls, [
      [1, 1],
      [1, 2],
    ]);
    now = new Date('2026-11-16T00:01:01Z');
    const restarted = fixture({
      now: () => now,
      pages: (_seed, n) => page([n + 200], 3, n),
    });
    await restarted.runVisit(2);
    assert.deepEqual(restarted.calls, [
      [1, 2],
      [1, 3],
    ]);
    assert.equal((await restarted.service.read(100)).completedSeedCount, 1);
  });

  it('picks newly released seeds on later visits and ignores future-dated parts', async () => {
    const work: (() => Promise<void>)[] = [];
    let now = new Date('2026-11-16T00:00:00Z');
    const test = new SimilarCollectionsService(dataSource, {
      collection: async () => ({
        ...collection([1]),
        parts: [
          ...collection([1]).parts,
          ...collection([2]).parts.map((part) => ({
            ...part,
            release_date: '2026-11-17',
          })),
          ...collection([3]).parts.map((part) => ({
            ...part,
            release_date: '2020-02-31',
          })),
        ],
      }),
      recommendations: async () => page([], 1),
      resolve: async () => memberships([], {}),
      now: () => now,
      randomIndex: () => 0,
      dispatch: (task) => {
        work.push(task);
      },
    });
    await test.trigger(100, visit(1));
    await work.shift()?.();
    assert.equal((await test.read(100)).completedSeedCount, 1);
    now = new Date('2026-11-17T00:00:00Z');
    await test.trigger(100, visit(2));
    await work.shift()?.();
    assert.equal((await test.read(100)).completedSeedCount, 2);
  });
});
