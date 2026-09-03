import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { DownloadTracker } from '@server/lib/downloadtracker';

describe('DownloadTracker updateDownloads', () => {
  it('shares one active refresh between concurrent callers', async () => {
    const tracker = new DownloadTracker();
    let resolveRefresh: (() => void) | undefined;
    const refresh = mock.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    (
      tracker as unknown as {
        performUpdateDownloads: () => Promise<void>;
      }
    ).performUpdateDownloads = refresh;

    const first = tracker.updateDownloads();
    const second = tracker.updateDownloads();

    assert.strictEqual(first, second);
    assert.strictEqual(refresh.mock.callCount(), 1);

    resolveRefresh?.();
    await first;

    const third = tracker.updateDownloads();
    assert.notStrictEqual(third, first);
    assert.strictEqual(refresh.mock.callCount(), 2);
    resolveRefresh?.();
    await third;
  });
});
