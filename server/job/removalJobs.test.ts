import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { removalJobEnabled } from '@server/job/removalJobs';
import { getSettings } from '@server/lib/settings';

describe('Removal job execution gates', () => {
  it('keeps scan and processing enablement independent of native cadence', () => {
    getSettings().removal.removalScanEnabled = false;
    getSettings().removal.removalProcessingEnabled = true;
    assert.equal(removalJobEnabled('scan'), false);
    assert.equal(removalJobEnabled('processing'), true);

    getSettings().removal.removalScanEnabled = true;
    getSettings().removal.removalProcessingEnabled = false;
    assert.equal(removalJobEnabled('scan'), true);
    assert.equal(removalJobEnabled('processing'), false);
  });
});
