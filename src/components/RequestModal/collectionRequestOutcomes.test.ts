import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { Collection } from '@server/models/Collection';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyCollectionRequestOutcomes,
  reconcileCollectionRequestRetryability,
} from './collectionRequestOutcomes';

const part = (id: number, title: string): Collection['parts'][number] =>
  ({ id, title, mediaType: 'movie' }) as Collection['parts'][number];

describe('Collection request outcomes', () => {
  it('retains every per-title result from a partially successful batch', () => {
    const results = classifyCollectionRequestOutcomes(
      [part(1, 'Requested'), part(2, 'Existing'), part(3, 'Failed')],
      [
        { status: 'fulfilled', value: {} },
        { status: 'rejected', reason: { response: { status: 409 } } },
        { status: 'rejected', reason: { response: { status: 503 } } },
      ]
    );
    assert.deepEqual(
      results.map(({ partId, kind }) => ({ partId, kind })),
      [
        { partId: 1, kind: 'requested' },
        { partId: 2, kind: 'already-requested' },
        { partId: 3, kind: 'failed' },
      ]
    );
  });

  it('offers retry only for failed titles still authoritatively requestable', () => {
    const outcomes = classifyCollectionRequestOutcomes(
      [part(1, 'Retry'), part(2, 'Now requested'), part(3, 'Available')],
      [
        { status: 'rejected', reason: {} },
        { status: 'rejected', reason: {} },
        { status: 'rejected', reason: {} },
      ]
    );
    const refreshed = [
      part(1, 'Retry'),
      {
        ...part(2, 'Now requested'),
        mediaInfo: {
          requests: [{ is4k: false, status: MediaRequestStatus.PENDING }],
        },
      },
      {
        ...part(3, 'Available'),
        mediaInfo: { status: MediaStatus.AVAILABLE, requests: [] },
      },
    ] as Collection['parts'];

    assert.deepEqual(
      reconcileCollectionRequestRetryability(outcomes, refreshed, false).map(
        ({ partId, retryable }) => ({ partId, retryable })
      ),
      [
        { partId: 1, retryable: true },
        { partId: 2, retryable: false },
        { partId: 3, retryable: false },
      ]
    );
    assert.equal(
      reconcileCollectionRequestRetryability(outcomes, undefined, false).some(
        ({ retryable }) => retryable
      ),
      false
    );
  });
});
