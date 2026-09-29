import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bulkCandidateVisibilityTargets,
  candidatePageSelectionState,
  candidateSelectionScopeKey,
  nearestCandidatePage,
  toggleCandidatePageSelection,
  toggleCandidateSelection,
  type CandidateSelectionScope,
} from './candidateSelection';

const rows = [
  { candidateId: 1, revision: 4, show: true },
  { candidateId: 2, revision: 7, show: true },
  { candidateId: 3, revision: 2, show: false },
];

describe('Fresh Candidate Diagnostics page selection', () => {
  it('tracks individual, indeterminate, and all-current-page selection', () => {
    const one = toggleCandidateSelection([], 1, true);
    assert.deepEqual(one, [1]);
    assert.equal(candidatePageSelectionState(rows, one), 'some');
    const all = toggleCandidatePageSelection(rows, true);
    assert.deepEqual(all, [1, 2, 3]);
    assert.equal(candidatePageSelectionState(rows, all), 'all');
    assert.equal(
      candidatePageSelectionState(
        rows,
        toggleCandidateSelection(all, 2, false)
      ),
      'some'
    );
    assert.deepEqual(toggleCandidatePageSelection(rows, false), []);
  });

  it('selects only rows on the loaded page and skips visibility no-ops', () => {
    const selected = toggleCandidatePageSelection(rows, true);
    assert.deepEqual(bulkCandidateVisibilityTargets(rows, selected, false), [
      { candidateId: 1, expectedRevision: 4 },
      { candidateId: 2, expectedRevision: 7 },
    ]);
    assert.deepEqual(bulkCandidateVisibilityTargets(rows, selected, true), [
      { candidateId: 3, expectedRevision: 2 },
    ]);
    assert.equal(selected.includes(99), false);
  });

  it('changes selection scope for page, search, every filter, and visibility', () => {
    const scope: CandidateSelectionScope = {
      page: 1,
      search: '',
      mediaType: 'all',
      status: 'all',
      sort: 'priority',
      reasonFamily: 'all',
      seasonEvidence: 'all',
      manualResolution: 'all',
      admissionOverride: 'all',
      visibility: 'visible',
    };
    const original = candidateSelectionScopeKey(scope);
    for (const [field, value] of [
      ['page', 2],
      ['search', 'matrix'],
      ['mediaType', 'movie'],
      ['status', 'resolved'],
      ['sort', 'title.asc'],
      ['reasonFamily', 'resolution'],
      ['seasonEvidence', 'known'],
      ['manualResolution', 'present'],
      ['admissionOverride', 'present'],
      ['visibility', 'hidden'],
    ] as const) {
      assert.notEqual(
        candidateSelectionScopeKey({ ...scope, [field]: value }),
        original,
        field
      );
    }
  });

  it('moves to the nearest valid page after a page is emptied', () => {
    assert.equal(nearestCandidatePage(3, 51, 1, 25), 2);
    assert.equal(nearestCandidatePage(1, 1, 1, 25), 1);
    assert.equal(nearestCandidatePage(2, 30, 2, 25), 2);
  });
});
