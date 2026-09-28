import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import { wakeAcquisitionMonitorForDispatch } from '@server/subscriber/MediaRequestSubscriber';

describe('MediaRequestSubscriber acquisition-monitor wake', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('wakes the one monitor for an approved provider dispatch', () => {
    const wake = mock.method(acquisitionMonitor, 'wake', () => undefined);

    wakeAcquisitionMonitorForDispatch();

    assert.strictEqual(wake.mock.callCount(), 1);
    assert.strictEqual(wake.mock.calls[0].arguments[0], 'seerr-request');
  });
});
