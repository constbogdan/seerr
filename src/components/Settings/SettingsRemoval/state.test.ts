import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_REMOVAL_SETTINGS } from '@server/constants/removal';
import {
  currentRemovalPreview,
  isCurrentRemovalPreviewRequest,
  reconcileRemovalDraft,
  removalSettingsFingerprint,
} from './state';

const settings = () => structuredClone(DEFAULT_REMOVAL_SETTINGS);

describe('Removal Settings draft and preview identity', () => {
  it('adopts remote state only while the local draft is pristine', () => {
    const saved = settings();
    const remote = settings();
    remote.removalDelayDays = 30;

    assert.deepEqual(reconcileRemovalDraft(remote, saved, saved), {
      type: 'adopt-remote',
      settings: remote,
    });
  });

  it('preserves a dirty draft and reports a remote conflict', () => {
    const saved = settings();
    const draft = settings();
    const remote = settings();
    draft.movie.itemsPerRun = 7;
    remote.series.itemsPerRun = 9;

    assert.deepEqual(reconcileRemovalDraft(remote, saved, draft), {
      type: 'remote-conflict',
      settings: remote,
    });
    assert.equal(draft.movie.itemsPerRun, 7);
  });

  it('exposes a preview only for its exact settings fingerprint', () => {
    const draft = settings();
    const preview = {
      fingerprint: removalSettingsFingerprint(draft),
      value: { actionableScheduleCount: 3 },
    };
    assert.deepEqual(currentRemovalPreview(preview, draft), {
      actionableScheduleCount: 3,
    });

    const changed = settings();
    changed.movie.minimumAgeMonths += 1;
    assert.equal(currentRemovalPreview(preview, changed), null);
  });

  it('rejects out-of-order responses even when an older input reappears', () => {
    const current = settings();
    const fingerprint = removalSettingsFingerprint(current);
    assert.equal(
      isCurrentRemovalPreviewRequest(4, 5, fingerprint, current),
      false
    );
    assert.equal(
      isCurrentRemovalPreviewRequest(5, 5, fingerprint, current),
      true
    );

    const changed = settings();
    changed.series.itemsPerRun = 12;
    assert.equal(
      isCurrentRemovalPreviewRequest(5, 5, fingerprint, changed),
      false
    );
  });
});
