import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { overflowThresholdPosition } from './overflowThreshold';

describe('Storage Overflow threshold marker', () => {
  it('positions the marker from the free-space edge using raw bytes', () => {
    assert.equal(overflowThresholdPosition(100 * 1024 ** 3, 5), 5);
    assert.equal(overflowThresholdPosition(100 * 1024 ** 3, 50), 50);
    assert.equal(overflowThresholdPosition(100 * 1024 ** 3, 100), 100);
  });

  it('clamps oversized thresholds and hides unknown or invalid values', () => {
    assert.equal(overflowThresholdPosition(10 * 1024 ** 3, 20), 100);
    assert.equal(overflowThresholdPosition(null, 5), null);
    assert.equal(overflowThresholdPosition(0, 5), null);
    assert.equal(overflowThresholdPosition(100, null), null);
    assert.equal(overflowThresholdPosition(100, 1.5), null);
  });
});
