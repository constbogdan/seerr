import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { DEFAULT_OVERFLOW_SETTINGS } from '@server/constants/overflow';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import {
  shouldEvaluateAutomaticSeriesPlacement,
  shouldEvaluateMovieOverflow,
  wakeAcquisitionMonitorForDispatch,
} from '@server/subscriber/MediaRequestSubscriber';

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

describe('MediaRequestSubscriber Storage feature activation', () => {
  it('gates Movie Overflow and Automatic Series Placement independently', () => {
    for (const enabled of [false, true]) {
      for (const automaticSeriesPlacement of [false, true]) {
        const overflow = {
          ...DEFAULT_OVERFLOW_SETTINGS,
          enabled,
          automaticSeriesPlacement,
          routes: [
            {
              enabled: true,
              sourceVolumeId: 'source',
              destinationVolumeId: 'target',
              thresholdGb: 1,
            },
          ],
        };
        assert.equal(
          shouldEvaluateMovieOverflow(overflow, false),
          enabled,
          `Movie gate for enabled=${enabled}, placement=${automaticSeriesPlacement}`
        );
        assert.equal(
          shouldEvaluateAutomaticSeriesPlacement(overflow, false),
          automaticSeriesPlacement,
          `Series gate for enabled=${enabled}, placement=${automaticSeriesPlacement}`
        );
      }
    }
  });

  it('keeps explicit root overrides authoritative and requires an enabled Movie route', () => {
    const overflow = {
      ...DEFAULT_OVERFLOW_SETTINGS,
      enabled: true,
      automaticSeriesPlacement: true,
      routes: [],
    };
    assert.equal(shouldEvaluateMovieOverflow(overflow, false), false);
    assert.equal(shouldEvaluateMovieOverflow(overflow, true), false);
    assert.equal(shouldEvaluateAutomaticSeriesPlacement(overflow, true), false);
  });
});
