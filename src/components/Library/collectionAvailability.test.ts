import { MediaStatus } from '@server/constants/media';
import type { Collection } from '@server/models/Collection';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatCollectionAvailability,
  getCollectionAvailability,
} from './collectionAvailability';

const collection = (
  parts: {
    id: number;
    status?: MediaStatus;
  }[]
): Pick<Collection, 'parts'> => ({
  parts: parts.map(
    ({ id, status }) =>
      ({
        id,
        mediaInfo: status === undefined ? undefined : { status },
      }) as Collection['parts'][number]
  ),
});

describe('Library collection availability', () => {
  it('reports available Movies over complete TMDB membership', () => {
    assert.deepEqual(
      getCollectionAvailability(
        collection([
          { id: 1, status: MediaStatus.AVAILABLE },
          { id: 2, status: MediaStatus.AVAILABLE },
          { id: 3, status: MediaStatus.UNKNOWN },
        ])
      ),
      { available: 2, total: 3 }
    );
  });

  it('reports complete and zero-available collections accurately', () => {
    assert.deepEqual(
      getCollectionAvailability(
        collection([
          { id: 1, status: MediaStatus.AVAILABLE },
          { id: 2, status: MediaStatus.AVAILABLE },
          { id: 3, status: MediaStatus.AVAILABLE },
        ])
      ),
      { available: 3, total: 3 }
    );
    assert.deepEqual(
      getCollectionAvailability(
        collection([
          { id: 1, status: MediaStatus.PENDING },
          { id: 2, status: MediaStatus.PROCESSING },
          { id: 3 },
        ])
      ),
      { available: 0, total: 3 }
    );
  });

  it('excludes non-available states from the numerator', () => {
    assert.deepEqual(
      getCollectionAvailability(
        collection([
          { id: 1, status: MediaStatus.AVAILABLE },
          { id: 2, status: MediaStatus.PARTIALLY_AVAILABLE },
          { id: 3, status: MediaStatus.BLOCKLISTED },
          { id: 4, status: MediaStatus.DELETED },
          { id: 5, status: MediaStatus.PENDING },
          { id: 6, status: MediaStatus.PROCESSING },
          { id: 7, status: MediaStatus.UNKNOWN },
          { id: 8 },
        ])
      ),
      { available: 1, total: 8 }
    );
  });

  it('deduplicates TMDB IDs without losing an available identity', () => {
    assert.deepEqual(
      getCollectionAvailability(
        collection([
          { id: 1, status: MediaStatus.UNKNOWN },
          { id: 1, status: MediaStatus.AVAILABLE },
          { id: 2, status: MediaStatus.AVAILABLE },
          { id: 2, status: MediaStatus.AVAILABLE },
        ])
      ),
      { available: 2, total: 2 }
    );
  });

  it('does not produce a misleading zero-total result', () => {
    assert.equal(getCollectionAvailability(collection([])), undefined);
    assert.equal(formatCollectionAvailability(undefined), undefined);
  });

  it('formats reliable zero and positive counts compactly', () => {
    assert.equal(
      formatCollectionAvailability({ available: 2, total: 3 }),
      '2/3'
    );
    assert.equal(
      formatCollectionAvailability({ available: 0, total: 3 }),
      '0/3'
    );
  });
});
