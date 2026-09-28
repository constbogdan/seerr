import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { resetDownloadSync, runDownloadSync } from '@server/job/schedule';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import type { DownloadTrackerUpdateOutcome } from '@server/lib/downloadtracker';

const outcome: DownloadTrackerUpdateOutcome = {
  providersAttempted: 0,
  providersSucceeded: 0,
  providersFailed: 0,
  queueCount: 0,
  changed: false,
  authoritative: true,
};

describe('Download Sync native jobs', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('routes scheduled and manual job invocations through the shared monitor', async () => {
    const refreshPromise = Promise.resolve(outcome);
    const refresh = mock.method(
      acquisitionMonitor,
      'refresh',
      () => refreshPromise
    );

    const scheduled = runDownloadSync();
    const manual = runDownloadSync();

    assert.strictEqual(scheduled, refreshPromise);
    assert.strictEqual(manual, refreshPromise);
    assert.strictEqual(refresh.mock.callCount(), 2);
    assert.deepStrictEqual(refresh.mock.calls[0].arguments, ['background']);
    assert.deepStrictEqual(refresh.mock.calls[1].arguments, ['background']);
    await Promise.all([scheduled, manual]);
  });

  it('resets through immediate monitor reconciliation', async () => {
    const reconciliation = Promise.resolve(outcome);
    const reset = mock.method(
      acquisitionMonitor,
      'resetAndReconcile',
      () => reconciliation
    );

    const result = resetDownloadSync();

    assert.strictEqual(result, reconciliation);
    assert.strictEqual(reset.mock.callCount(), 1);
    await result;
  });
});
