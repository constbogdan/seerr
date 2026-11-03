import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_REMOVAL_SETTINGS } from '@server/constants/removal';
import {
  isCurrentRemovalPreviewRequest,
  reconcileRemovalDraft,
  removalPreviewFingerprint,
  removalPreviewPresentation,
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

  it('keeps a preview across edits that do not affect eligibility', () => {
    const draft = settings();
    const preview = {
      fingerprint: removalPreviewFingerprint(draft),
      value: { actionableScheduleCount: 3 },
    };
    assert.deepEqual(removalPreviewPresentation(preview, draft, null, null), {
      value: { actionableScheduleCount: 3 },
      current: true,
      refreshing: false,
      failed: false,
    });

    const changed = settings();
    changed.removalProcessingEnabled = !changed.removalProcessingEnabled;
    changed.removalScanEnabled = !changed.removalScanEnabled;
    changed.removalDelayDays = 30;
    changed.movie.enabled = !changed.movie.enabled;
    changed.series.enabled = !changed.series.enabled;
    assert.deepEqual(removalPreviewPresentation(preview, changed, null, null), {
      value: { actionableScheduleCount: 3 },
      current: true,
      refreshing: false,
      failed: false,
    });
  });

  it('keeps the previous result visible while an eligibility refresh is pending', () => {
    const draft = settings();
    const preview = {
      fingerprint: removalPreviewFingerprint(draft),
      value: { actionableScheduleCount: 3 },
    };
    const changed = settings();
    changed.movie.itemsPerRun += 1;
    const changedFingerprint = removalPreviewFingerprint(changed);

    assert.deepEqual(
      removalPreviewPresentation(preview, changed, changedFingerprint, null),
      {
        value: { actionableScheduleCount: 3 },
        current: false,
        refreshing: true,
        failed: false,
      }
    );
  });

  it('keeps the previous result visible after a failed eligibility refresh', () => {
    const draft = settings();
    const preview = {
      fingerprint: removalPreviewFingerprint(draft),
      value: { actionableScheduleCount: 3 },
    };
    const changed = settings();
    changed.series.minimumAgeMonths += 1;
    const changedFingerprint = removalPreviewFingerprint(changed);

    assert.deepEqual(
      removalPreviewPresentation(preview, changed, null, changedFingerprint),
      {
        value: { actionableScheduleCount: 3 },
        current: false,
        refreshing: false,
        failed: true,
      }
    );
  });

  it('preserves a successful authoritative zero result', () => {
    const draft = settings();
    const preview = {
      fingerprint: removalPreviewFingerprint(draft),
      value: { actionableScheduleCount: 0, eligibleUnscheduled: 0 },
    };

    assert.deepEqual(removalPreviewPresentation(preview, draft, null, null), {
      value: { actionableScheduleCount: 0, eligibleUnscheduled: 0 },
      current: true,
      refreshing: false,
      failed: false,
    });
  });

  it('marks a changed eligibility input stale during the debounce window', () => {
    const draft = settings();
    const preview = {
      fingerprint: removalPreviewFingerprint(draft),
      value: { actionableScheduleCount: 3 },
    };
    const changes = [
      (changed: ReturnType<typeof settings>) =>
        (changed.movie.minimumAgeMonths += 1),
      (changed: ReturnType<typeof settings>) =>
        (changed.movie.inactivityMonths += 1),
      (changed: ReturnType<typeof settings>) =>
        (changed.movie.itemsPerRun += 1),
      (changed: ReturnType<typeof settings>) =>
        (changed.series.minimumAgeMonths += 1),
      (changed: ReturnType<typeof settings>) =>
        (changed.series.inactivityMonths += 1),
      (changed: ReturnType<typeof settings>) =>
        (changed.series.itemsPerRun += 1),
    ];

    for (const change of changes) {
      const changed = settings();
      change(changed);
      assert.deepEqual(
        removalPreviewPresentation(preview, changed, null, null),
        {
          value: { actionableScheduleCount: 3 },
          current: false,
          refreshing: true,
          failed: false,
        }
      );
    }
  });

  it('rejects out-of-order responses even when an older input reappears', () => {
    const current = settings();
    const fingerprint = removalPreviewFingerprint(current);
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

  it('accepts an in-flight preview after an unrelated form edit', () => {
    const submitted = settings();
    const fingerprint = removalPreviewFingerprint(submitted);
    const current = settings();
    current.removalDelayDays = 90;
    current.movie.enabled = true;

    assert.equal(
      isCurrentRemovalPreviewRequest(5, 5, fingerprint, current),
      true
    );
  });
});
