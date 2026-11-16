import type { TmdbMovieResult } from '@server/api/themoviedb/interfaces';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { MovieCollectionObservation } from '@server/entity/MovieCollectionObservation';
import { MovieCollectionMembershipService } from '@server/lib/movieCollectionMembership';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const movie = (tmdbId: number) => [{ mediaType: 'movie' as const, tmdbId }];
const at = (day: number) =>
  new Date(`2026-11-${String(day).padStart(2, '0')}T00:00:00Z`);

describe('persistent movie collection membership', () => {
  it('distinguishes collection, standalone, unresolved and identity mismatch without creating canonical rows', async () => {
    const service = new MovieCollectionMembershipService();
    assert.equal(
      await service.observeMovie(
        1,
        { id: 1, belongs_to_collection: { id: 42 } },
        at(1)
      ),
      true
    );
    assert.equal(
      await service.observeMovie(
        2,
        { id: 2, belongs_to_collection: null },
        at(1)
      ),
      true
    );
    assert.equal(await service.observeMovie(3, { id: 3 }, at(1)), false);
    assert.equal(
      await service.observeMovie(
        4,
        { id: 5, belongs_to_collection: null },
        at(1)
      ),
      false
    );
    assert.equal(
      await service.observeMovie(
        5,
        { id: 5, belongs_to_collection: { id: 0 } },
        at(1)
      ),
      false
    );
    const resolved = await service.resolve([
      movie(1)[0],
      movie(2)[0],
      movie(3)[0],
    ]);
    assert.deepEqual(resolved.results.get(1)?.membership, {
      kind: 'collection',
      collectionId: 42,
    });
    assert.deepEqual(resolved.results.get(2)?.membership, {
      kind: 'standalone',
    });
    assert.deepEqual(resolved.results.get(3)?.membership, {
      kind: 'unresolved',
    });
    assert.equal(await getRepository(CanonicalMedia).count(), 0);
    assert.equal(await getRepository(MovieCollectionObservation).count(), 2);
  });

  it('prefers a newer observation and converges it onto an existing canonical identity', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        tmdbCollectionId: 10,
        collectionMembershipHydratedAt: at(1),
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '12',
      })
    );
    const service = new MovieCollectionMembershipService();
    await service.observeMovie(
      12,
      { id: 12, belongs_to_collection: { id: 20 } },
      at(2)
    );
    const result = await service.resolve(movie(12));
    assert.deepEqual(result.results.get(12)?.membership, {
      kind: 'collection',
      collectionId: 20,
    });
    assert.equal(
      (
        await getRepository(CanonicalMedia).findOneByOrFail({
          id: canonical.id,
        })
      ).tmdbCollectionId,
      20
    );
  });

  it('uses canonical on equal timestamps and rejects older concurrent writes', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        tmdbCollectionId: 30,
        collectionMembershipHydratedAt: at(3),
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '13',
      })
    );
    const service = new MovieCollectionMembershipService();
    await Promise.all([
      service.observeMovie(
        13,
        { id: 13, belongs_to_collection: { id: 10 } },
        at(1)
      ),
      service.observeMovie(
        13,
        { id: 13, belongs_to_collection: { id: 20 } },
        at(2)
      ),
    ]);
    const older = await getRepository(
      MovieCollectionObservation
    ).findOneByOrFail({ tmdbId: 13 });
    assert.equal(older.tmdbCollectionId, 20);
    await service.observeMovie(
      13,
      { id: 13, belongs_to_collection: { id: 40 } },
      at(3)
    );
    const result = await service.resolve(movie(13));
    assert.deepEqual(result.results.get(13)?.membership, {
      kind: 'collection',
      collectionId: 30,
    });
  });

  it('keeps stale confirmed membership when provider refresh fails', async () => {
    const service = new MovieCollectionMembershipService(
      undefined,
      () => ({
        getMovieForScan: async () => {
          throw new Error('provider unavailable');
        },
      }),
      () => new Date('2027-01-01T00:00:00Z')
    );
    await service.observeMovie(
      21,
      { id: 21, belongs_to_collection: null },
      at(1)
    );
    const result = await service.resolve(movie(21), {
      maxLookups: 1,
      deadlineMs: 1000,
    });
    assert.deepEqual(result.results.get(21)?.membership, {
      kind: 'standalone',
    });
    assert.equal(result.results.get(21)?.stale, true);
  });

  it('coalesces simultaneous provider lookups for one movie', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new MovieCollectionMembershipService(undefined, () => ({
      getMovieForScan: async () => {
        calls++;
        await gate;
        return { id: 31, belongs_to_collection: { id: 99 } } as TmdbMovieResult;
      },
    }));
    const first = service.resolve(movie(31), {
      maxLookups: 1,
      deadlineMs: 1000,
    });
    const second = service.resolve(movie(31), {
      maxLookups: 1,
      deadlineMs: 1000,
    });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(a.results.get(31)?.membership, {
      kind: 'collection',
      collectionId: 99,
    });
    assert.deepEqual(b.results.get(31)?.membership, {
      kind: 'collection',
      collectionId: 99,
    });
  });

  it('bounds a 20-result cold page to four lookups and retains unresolved results', async (context) => {
    const calls: number[] = [];
    const service = new MovieCollectionMembershipService(undefined, () => ({
      getMovieForScan: async ({ movieId }) => {
        calls.push(movieId);
        return { id: movieId, belongs_to_collection: null } as TmdbMovieResult;
      },
    }));
    const identities = Array.from(
      { length: 20 },
      (_, index) => movie(100 + index)[0]
    );
    const started = performance.now();
    const cold = await service.resolve(identities, {
      maxLookups: 4,
      concurrency: 2,
      deadlineMs: 1000,
    });
    const coldMs = performance.now() - started;
    assert.deepEqual(calls, [100, 101, 102, 103]);
    assert.equal(cold.stats.tmdbFallbackCalls, 4);
    assert.equal(cold.stats.unresolved, 16);
    assert.equal(cold.results.get(100)?.membership.kind, 'standalone');
    assert.equal(cold.results.get(119)?.membership.kind, 'unresolved');
    const warmStarted = performance.now();
    const warm = await service.resolve(identities);
    const warmMs = performance.now() - warmStarted;
    assert.equal(warm.stats.tmdbFallbackCalls, 0);
    assert.equal(warm.stats.observationHits, 4);
    assert.equal(warm.stats.unresolved, 16);
    assert.equal(calls.length, 4);
    assert.ok(coldMs >= 0 && warmMs >= 0);
    context.diagnostic(
      `controlled 20-result page: cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms canonical=${warm.stats.canonicalHits} observation=${warm.stats.observationHits} fallback=${cold.stats.tmdbFallbackCalls} unresolved=${cold.stats.unresolved}`
    );
  });

  it('resolves all 20 unique cold recommendations with at most four concurrent detail fallbacks', async () => {
    let active = 0;
    let peak = 0;
    let started = 0;
    let release!: () => void;
    let firstFourStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstFour = new Promise<void>((resolve) => {
      firstFourStarted = resolve;
    });
    const service = new MovieCollectionMembershipService(undefined, () => ({
      getMovieForScan: async ({ movieId }) => {
        active++;
        peak = Math.max(peak, active);
        started++;
        if (started === 4) firstFourStarted();
        await gate;
        active--;
        return { id: movieId, belongs_to_collection: null } as TmdbMovieResult;
      },
    }));
    const identities = Array.from(
      { length: 20 },
      (_, index) => movie(400 + index)[0]
    );
    const work = service.resolve([...identities, identities[0]], {
      maxLookups: 20,
      concurrency: 4,
      deadlineMs: 60_000,
    });
    await firstFour;
    assert.equal(started, 4);
    assert.equal(active, 4);
    release();
    const result = await work;
    assert.equal(started, 20);
    assert.equal(peak, 4);
    assert.equal(result.stats.tmdbFallbackCalls, 20);
    assert.equal(result.stats.unresolved, 0);
    assert.equal(result.results.size, 20);
    assert.equal(await getRepository(CanonicalMedia).count(), 0);
  });

  it('reuses 12 confirmed observations and fetches only eight unknown memberships', async () => {
    const calls: number[] = [];
    const service = new MovieCollectionMembershipService(undefined, () => ({
      getMovieForScan: async ({ movieId }) => {
        calls.push(movieId);
        return {
          id: movieId,
          belongs_to_collection: { id: 900 },
        } as TmdbMovieResult;
      },
    }));
    for (let id = 500; id < 512; id++)
      assert.equal(
        await service.observeMovie(id, {
          id,
          belongs_to_collection: null,
        } as TmdbMovieResult),
        true
      );
    const result = await service.resolve(
      Array.from({ length: 20 }, (_, index) => movie(500 + index)[0]),
      { maxLookups: 20, concurrency: 4, deadlineMs: 60_000 }
    );
    assert.deepEqual(
      calls,
      Array.from({ length: 8 }, (_, index) => 512 + index)
    );
    assert.equal(result.stats.observationHits, 20);
    assert.equal(result.stats.tmdbFallbackCalls, 8);
    assert.equal(result.stats.unresolved, 0);
    assert.equal(result.results.get(500)?.membership.kind, 'standalone');
    assert.deepEqual(result.results.get(519)?.membership, {
      kind: 'collection',
      collectionId: 900,
    });
  });

  it('backs off failed lookups without persisting an unresolved row', async () => {
    let calls = 0;
    const service = new MovieCollectionMembershipService(undefined, () => ({
      getMovieForScan: async () => {
        calls++;
        throw new Error('provider failure');
      },
    }));
    const first = await service.resolve(movie(222), {
      maxLookups: 1,
      deadlineMs: 1000,
    });
    const second = await service.resolve(movie(222), {
      maxLookups: 1,
      deadlineMs: 1000,
    });
    assert.equal(first.results.get(222)?.membership.kind, 'unresolved');
    assert.equal(second.results.get(222)?.membership.kind, 'unresolved');
    assert.equal(calls, 1);
    assert.equal(
      await getRepository(MovieCollectionObservation).countBy({ tmdbId: 222 }),
      0
    );
  });

  it('preserves identity mapping when concurrent provider responses finish out of order and one fails', async () => {
    const releases = new Map<number, (value: TmdbMovieResult) => void>();
    let started!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new MovieCollectionMembershipService(undefined, () => ({
      getMovieForScan: ({ movieId }) =>
        new Promise<TmdbMovieResult>((resolve, reject) => {
          if (movieId === 333) {
            reject(new Error('one provider failure'));
            return;
          }
          releases.set(movieId, resolve);
          if (releases.size === 2) started();
        }),
    }));
    const pending = service.resolve(
      [movie(331)[0], movie(332)[0], movie(333)[0]],
      {
        maxLookups: 3,
        concurrency: 3,
        deadlineMs: 1000,
      }
    );
    await bothStarted;
    releases.get(332)!({
      id: 332,
      belongs_to_collection: null,
    } as TmdbMovieResult);
    releases.get(331)!({
      id: 331,
      belongs_to_collection: { id: 88 },
    } as TmdbMovieResult);
    const result = await pending;
    assert.deepEqual([...result.results.keys()], [331, 332, 333]);
    assert.deepEqual(result.results.get(331)?.membership, {
      kind: 'collection',
      collectionId: 88,
    });
    assert.deepEqual(result.results.get(332)?.membership, {
      kind: 'standalone',
    });
    assert.deepEqual(result.results.get(333)?.membership, {
      kind: 'unresolved',
    });
  });

  it('reports confirmed observations while slower lookups remain pending', async () => {
    let release!: () => void;
    let firstPublished!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const published = new Promise<void>((resolve) => {
      firstPublished = resolve;
    });
    const events: number[] = [];
    const service = new MovieCollectionMembershipService(undefined, () => ({
      getMovieForScan: async ({ movieId }) => {
        if (movieId === 702) await slow;
        return {
          id: movieId,
          belongs_to_collection: movieId === 701 ? { id: 901 } : null,
        } as TmdbMovieResult;
      },
    }));
    const work = service.resolve([movie(701)[0], movie(702)[0]], {
      maxLookups: 2,
      concurrency: 2,
      deadlineMs: 60_000,
      onConfirmed: async (id) => {
        events.push(id);
        if (id === 701) firstPublished();
      },
    });
    await published;
    assert.deepEqual(events, [701]);
    release();
    const result = await work;
    assert.deepEqual(events.sort(), [701, 702]);
    assert.equal(result.results.get(702)?.membership.kind, 'standalone');
  });
});
