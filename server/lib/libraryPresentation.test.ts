import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LibraryMediaType } from '@server/constants/libraryHistory';
import { BoundedRequestCoordinator } from '@server/lib/boundedRequestCoordinator';
import type { CacheStats, CacheStore } from '@server/lib/cache';
import {
  LibraryPresentationCoordinator,
  type LibraryPresentation,
} from '@server/lib/libraryPresentation';

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

const waitForSettled = async (
  coordinator: LibraryPresentationCoordinator,
  batchId: string
) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = coordinator.status(batchId);
    if (status.state !== 'pending') return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Presentation batch did not settle');
};

describe('LibraryPresentationCoordinator', () => {
  it('coalesces cold identities and serves localized Collection presentation from cache', async () => {
    let calls = 0;
    let release!: (presentation: LibraryPresentation) => void;
    const provider = new Promise<LibraryPresentation>((resolve) => {
      release = resolve;
    });
    const coordinator = new LibraryPresentationCoordinator({
      cache: new MemoryCache(),
      fetchPresentation: async (mediaType, tmdbId, locale) => {
        calls += 1;
        assert.equal(mediaType, LibraryMediaType.MOVIE);
        assert.equal(tmdbId, 101);
        assert.equal(locale, 'ro');
        return provider;
      },
    });
    const identities = [
      { mediaType: LibraryMediaType.MOVIE, tmdbId: 101 },
      { mediaType: LibraryMediaType.MOVIE, tmdbId: 101 },
    ];

    const first = coordinator.prepare(identities, 'ro');
    const duplicate = coordinator.prepare(identities, 'ro');
    assert.equal(first.presentations.size, 0);
    assert.equal(first.status.state, 'pending');
    assert.equal(duplicate.status.state, 'pending');
    assert.equal(calls, 1);

    release({
      title: 'Titlu localizat',
      year: 2026,
      posterPath: '/poster-ro.jpg',
      backdropPath: '/backdrop-ro.jpg',
      collection: {
        id: 501,
        name: 'Colecția localizată',
        posterPath: '/collection-ro.jpg',
        backdropPath: '/collection-backdrop-ro.jpg',
      },
    });
    const settled = await waitForSettled(
      coordinator,
      first.status.batchId as string
    );
    assert.equal(settled.state, 'complete');

    const warm = coordinator.prepare(identities, 'ro');
    assert.equal(warm.status.state, 'complete');
    assert.equal(warm.presentations.get('movie:101')?.title, 'Titlu localizat');
    assert.equal(warm.presentations.get('movie:101')?.collection?.id, 501);
    assert.equal(calls, 1);
    coordinator.shutdown();
  });

  it('keeps provider failures in a cooldown and reports partial completion', async () => {
    let calls = 0;
    const coordinator = new LibraryPresentationCoordinator({
      cache: new MemoryCache(),
      failureRetryMs: 60_000,
      fetchPresentation: async () => {
        calls += 1;
        throw new Error('provider unavailable');
      },
    });
    const identities = [{ mediaType: LibraryMediaType.SERIES, tmdbId: 202 }];

    const first = coordinator.prepare(identities, 'en');
    assert.equal(
      (await waitForSettled(coordinator, first.status.batchId as string)).state,
      'partial'
    );
    const retry = coordinator.prepare(identities, 'en');
    assert.equal(retry.status.state, 'partial');
    assert.equal(calls, 1);
    coordinator.shutdown();
  });

  it('bounds enrichment concurrency and rejects queued work on shutdown', async () => {
    const queue = new BoundedRequestCoordinator({
      maxConcurrency: 1,
      maxPending: 1,
    });
    let active = 0;
    let maximumActive = 0;
    const coordinator = new LibraryPresentationCoordinator({
      cache: new MemoryCache(),
      queue,
      fetchPresentation: async (_mediaType, tmdbId) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          title: String(tmdbId),
          year: null,
          posterPath: null,
          backdropPath: null,
        };
      },
    });
    const first = coordinator.prepare(
      [1, 2, 3].map((tmdbId) => ({
        mediaType: LibraryMediaType.MOVIE,
        tmdbId,
      })),
      'en'
    );
    assert.equal(first.status.state, 'pending');
    assert.equal(coordinator.stats().maxConcurrency, 1);
    coordinator.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(maximumActive, 1);
    assert.equal(coordinator.stats().stopped, true);
  });
});
