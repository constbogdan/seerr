import { LibraryMediaType } from '@server/constants/libraryHistory';
import { getRepository } from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import {
  parseTmdbCollectionMembership,
  persistMovieQueryMetadata,
} from '@server/lib/libraryCollectionMembership';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('Library collection membership projection', () => {
  it('atomically keeps a newer observation when concurrent writes complete out of order', async () => {
    const repository = getRepository(CanonicalMedia);
    const movie = await repository.save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Before',
      })
    );
    const older = new Date('2026-10-01T00:00:00Z');
    const newer = new Date('2026-10-02T00:00:00Z');

    await Promise.all([
      persistMovieQueryMetadata(repository, {
        canonicalMediaId: movie.id,
        titleSnapshot: 'Older response',
        year: 2001,
        collectionMembership: {
          tmdbCollectionId: 100,
          observedAt: older,
        },
      }),
      persistMovieQueryMetadata(repository, {
        canonicalMediaId: movie.id,
        titleSnapshot: 'Newer response',
        year: 2002,
        collectionMembership: {
          tmdbCollectionId: 200,
          observedAt: newer,
        },
      }),
    ]);
    await persistMovieQueryMetadata(repository, {
      canonicalMediaId: movie.id,
      titleSnapshot: 'Late older response',
      year: 2000,
      collectionMembership: {
        tmdbCollectionId: 50,
        observedAt: older,
      },
    });

    const stored = await repository.findOneByOrFail({ id: movie.id });
    assert.equal(stored.tmdbCollectionId, 200);
    assert.equal(
      stored.collectionMembershipHydratedAt?.toISOString(),
      newer.toISOString()
    );
    assert.equal(stored.titleSnapshot, 'Newer response');
    assert.equal(stored.year, 2002);
  });

  it('distinguishes confirmed non-membership from invalid or missing data', () => {
    const observedAt = new Date('2026-10-01T00:00:00Z');
    assert.deepEqual(parseTmdbCollectionMembership(null, observedAt), {
      tmdbCollectionId: null,
      observedAt,
    });
    assert.equal(
      parseTmdbCollectionMembership(undefined, observedAt),
      undefined
    );
    assert.equal(
      parseTmdbCollectionMembership({ id: 0 }, observedAt),
      undefined
    );
    assert.equal(
      parseTmdbCollectionMembership({ id: Number.NaN }, observedAt),
      undefined
    );
  });
});
