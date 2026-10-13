import { LibraryMediaType } from '@server/constants/libraryHistory';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import type { CacheStats, CacheStore } from '@server/lib/cache';
import { LibraryService } from '@server/lib/library';
import {
  LibraryPresentationCoordinator,
  type LibraryPresentation,
} from '@server/lib/libraryPresentation';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';

class MemoryCache implements CacheStore {
  private readonly values = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  public set<T>(key: string, value: T): boolean {
    this.values.set(key, structuredClone(value));
    return true;
  }

  public del(key: string): number {
    return this.values.delete(key) ? 1 : 0;
  }

  public getTtl(): number | undefined {
    return undefined;
  }

  public getStats(): CacheStats {
    return {
      hits: 0,
      misses: 0,
      keys: this.values.size,
      ksize: 0,
      vsize: 0,
    };
  }

  public flushAll(): void {
    this.values.clear();
  }
}

const query = {
  take: 25,
  skip: 0,
  scope: 'current' as const,
  watchlist: 'any' as const,
  watched: 'any' as const,
  sort: 'title' as const,
  sortDirection: 'asc' as const,
  locale: 'ro',
};

const waitForBatch = async (
  coordinator: LibraryPresentationCoordinator,
  batchId: string
) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = coordinator.status(batchId);
    if (status.state !== 'pending') return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Library presentation enrichment did not settle');
};

setupTestDb();

describe('asynchronous Library presentation', () => {
  it('returns canonical facts before cold enrichment and projects the cached result on revalidation', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Canonical title',
        year: 2024,
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '4242',
      })
    );
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        sourceItemId: 'movie:4242',
        sourceGeneration: 'r11-c',
        firstObservedAt: new Date('2026-10-01T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );

    let providerCalls = 0;
    let release!: (value: LibraryPresentation) => void;
    const provider = new Promise<LibraryPresentation>((resolve) => {
      release = resolve;
    });
    const coordinator = new LibraryPresentationCoordinator({
      cache: new MemoryCache(),
      fetchPresentation: async () => {
        providerCalls += 1;
        return provider;
      },
    });
    const service = new LibraryService({
      fetchPresentation: async () => {
        throw new Error('the synchronous fallback must not run');
      },
      presentationCoordinator: coordinator,
    });

    const cold = await service.query(query);
    assert.equal(cold.results.length, 1);
    assert.equal(cold.results[0].title, 'Canonical title');
    assert.equal(cold.results[0].posterPath, null);
    assert.equal(cold.results[0].collection, null);
    assert.equal(cold.presentation?.state, 'pending');
    assert.equal(providerCalls, 1);

    release({
      title: 'Titlu localizat',
      year: 2025,
      posterPath: '/localized-poster.jpg',
      backdropPath: '/localized-backdrop.jpg',
      collection: {
        id: 99,
        name: 'Colecție localizată',
        posterPath: '/collection.jpg',
        backdropPath: '/collection-backdrop.jpg',
      },
    });
    assert.equal(
      (await waitForBatch(coordinator, cold.presentation?.batchId as string))
        .state,
      'complete'
    );

    const warm = await service.query(query);
    assert.equal(warm.presentation?.state, 'complete');
    assert.equal(warm.results[0].title, 'Titlu localizat');
    assert.equal(warm.results[0].posterPath, '/localized-poster.jpg');
    assert.equal(warm.results[0].collection?.id, 99);
    assert.equal(providerCalls, 1);
    coordinator.shutdown();
  });

  it('keeps the mocked 25-item cold Library response below the accepted latency threshold', async () => {
    for (let index = 0; index < 25; index += 1) {
      const canonical = await getRepository(CanonicalMedia).save(
        new CanonicalMedia({
          mediaType: LibraryMediaType.MOVIE,
          titleSnapshot: `Cold presentation ${String(index).padStart(2, '0')}`,
          year: 2026,
        })
      );
      await getRepository(CanonicalMediaIdentity).save(
        new CanonicalMediaIdentity({
          canonicalMediaId: canonical.id,
          mediaType: LibraryMediaType.MOVIE,
          provider: 'tmdb',
          sourceScope: '',
          value: String(50_000 + index),
        })
      );
      await getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId: canonical.id,
          sourceSystem: 'radarr',
          sourceScope: 'service:1',
          sourceItemId: `movie:${50_000 + index}`,
          sourceGeneration: 'r11-c',
          firstObservedAt: new Date('2026-10-01T00:00:00.000Z'),
          servarrHasFile: true,
          isCurrent: true,
        })
      );
    }

    let release!: (value: LibraryPresentation) => void;
    const provider = new Promise<LibraryPresentation>((resolve) => {
      release = resolve;
    });
    const coordinator = new LibraryPresentationCoordinator({
      cache: new MemoryCache(),
      fetchPresentation: async () => provider,
    });
    const service = new LibraryService({
      fetchPresentation: async () => {
        throw new Error('the synchronous fallback must not run');
      },
      presentationCoordinator: coordinator,
    });
    const samples: number[] = [];
    let batchId = '';
    for (let repetition = 0; repetition < 7; repetition += 1) {
      const startedAt = performance.now();
      const result = await service.query(query);
      samples.push(performance.now() - startedAt);
      assert.equal(result.results.length, 25);
      assert.equal(result.presentation?.state, 'pending');
      batchId = result.presentation?.batchId as string;
    }
    const p95 = [...samples].sort((left, right) => left - right)[
      Math.ceil(samples.length * 0.95) - 1
    ];
    assert.ok(p95 < 250, `mocked 25-item Library p95 was ${p95.toFixed(3)}ms`);

    release({
      title: 'Enriched',
      year: 2026,
      posterPath: null,
      backdropPath: null,
    });
    assert.equal((await waitForBatch(coordinator, batchId)).state, 'complete');
    coordinator.shutdown();
  });
});
