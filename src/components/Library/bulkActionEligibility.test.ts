import type {
  LibraryBulkActionEligibilityResponse,
  LibraryBulkActionTarget,
} from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLibraryBulkActionEligibilityDisplayPresentation,
  getLibraryBulkActionEligibilityPresentation,
} from './bulkActionEligibility';

const targets: LibraryBulkActionTarget[] = [
  { canonicalMediaId: 1, targetType: 'movie' },
  { canonicalMediaId: 2, targetType: 'series' },
  { canonicalMediaId: 3, targetType: 'season', seasonNumber: 0 },
];

const response = (
  eligibility: LibraryBulkActionEligibilityResponse['results'][number]['eligibility'][]
): LibraryBulkActionEligibilityResponse => ({
  results: targets.map((target, index) => ({
    target,
    eligibility: eligibility[index],
    reason:
      eligibility[index] === 'schedule'
        ? 'unscheduled'
        : eligibility[index] === 'cancel_schedule'
          ? 'scheduled'
          : 'unavailable',
  })),
});

describe('Library bulk-action eligibility presentation', () => {
  it('separates fully scheduled and fully unscheduled selections', () => {
    const unscheduled = getLibraryBulkActionEligibilityPresentation(
      targets,
      response(['schedule', 'schedule', 'schedule'])
    );
    assert.equal(unscheduled.matchesSelection, true);
    assert.deepEqual(unscheduled.scheduleTargets, targets);
    assert.deepEqual(unscheduled.cancelTargets, []);

    const scheduled = getLibraryBulkActionEligibilityPresentation(
      targets,
      response(['cancel_schedule', 'cancel_schedule', 'cancel_schedule'])
    );
    assert.deepEqual(scheduled.scheduleTargets, []);
    assert.deepEqual(scheduled.cancelTargets, targets);
  });

  it('partitions mixed targets while retaining exact Season identity', () => {
    const presentation = getLibraryBulkActionEligibilityPresentation(
      targets,
      response(['schedule', 'cancel_schedule', 'conflict'])
    );
    assert.deepEqual(presentation.scheduleTargets, [targets[0]]);
    assert.deepEqual(presentation.cancelTargets, [targets[1]]);
    assert.equal(presentation.unresolvedCount, 1);
    assert.deepEqual(presentation.unresolvedReasons, ['unavailable']);
  });

  it('marks retained results stale after selection changes or reordering', () => {
    const retained = response(['schedule', 'cancel_schedule', 'conflict']);
    for (const selectedTargets of [
      targets.slice(0, 2),
      [targets[1], targets[0], targets[2]],
    ]) {
      const presentation = getLibraryBulkActionEligibilityPresentation(
        selectedTargets,
        retained
      );
      assert.equal(presentation.matchesSelection, false);
      assert.deepEqual(presentation.scheduleTargets, []);
      assert.deepEqual(presentation.cancelTargets, []);
      assert.deepEqual(presentation.unresolvedReasons, []);
    }
  });

  it('retains confirmed controls for display while a changed selection loads', () => {
    const retained = response(['schedule', 'cancel_schedule', 'conflict']);
    const current = getLibraryBulkActionEligibilityPresentation(
      targets.slice(0, 2),
      retained
    );
    const display = getLibraryBulkActionEligibilityDisplayPresentation(
      targets.slice(0, 2),
      retained
    );

    assert.equal(current.matchesSelection, false);
    assert.deepEqual(current.scheduleTargets, []);
    assert.deepEqual(current.cancelTargets, []);
    assert.equal(display.retained, true);
    assert.deepEqual(display.scheduleTargets, [targets[0]]);
    assert.deepEqual(display.cancelTargets, [targets[1]]);
    assert.equal(display.unresolvedCount, 1);
  });

  it('uses current controls atomically once the latest selection is confirmed', () => {
    const latest = response(['schedule', 'schedule', 'cancel_schedule']);
    const display = getLibraryBulkActionEligibilityDisplayPresentation(
      targets,
      latest
    );

    assert.equal(display.retained, false);
    assert.deepEqual(display.scheduleTargets, [targets[0], targets[1]]);
    assert.deepEqual(display.cancelTargets, [targets[2]]);
  });

  it('retains distinct reasons for a confirmed selection with no actions', () => {
    const unavailable: LibraryBulkActionEligibilityResponse = {
      results: [
        {
          target: targets[0],
          eligibility: 'conflict',
          reason: 'active_acquisition',
        },
        {
          target: targets[1],
          eligibility: 'unavailable',
          reason: 'not_current',
        },
        {
          target: targets[2],
          eligibility: 'conflict',
          reason: 'active_acquisition',
        },
      ],
    };
    const presentation = getLibraryBulkActionEligibilityPresentation(
      targets,
      unavailable
    );
    assert.equal(presentation.matchesSelection, true);
    assert.equal(presentation.unresolvedCount, 3);
    assert.deepEqual(presentation.unresolvedReasons, [
      'active_acquisition',
      'not_current',
    ]);
  });
});
