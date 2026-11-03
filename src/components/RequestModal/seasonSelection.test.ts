import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterVisibleSeasons,
  getInitialSeasonSelection,
  getValidatedSeasonSelection,
} from './seasonSelection';

describe('TV request Season preselection', () => {
  it('selects only the requested known and available Season', () => {
    assert.deepEqual(
      getInitialSeasonSelection({
        initialSeasonNumber: 2,
        partialRequestsEnabled: true,
        knownSeasonNumbers: [0, 1, 2, 3],
        unavailableSeasonNumbers: [1, 3],
      }),
      [2]
    );
  });

  it('does not select available, requested, unknown, or unsupported Seasons', () => {
    const base = {
      partialRequestsEnabled: true,
      knownSeasonNumbers: [0, 1, 2],
      unavailableSeasonNumbers: [1],
    };
    assert.deepEqual(
      getInitialSeasonSelection({ ...base, initialSeasonNumber: 1 }),
      []
    );
    assert.deepEqual(
      getInitialSeasonSelection({ ...base, initialSeasonNumber: 4 }),
      []
    );
    assert.deepEqual(
      getInitialSeasonSelection({
        ...base,
        initialSeasonNumber: 2,
        partialRequestsEnabled: false,
      }),
      []
    );
  });

  it('supports Specials when Seerr exposes them as a requestable Season', () => {
    assert.deepEqual(
      getInitialSeasonSelection({
        initialSeasonNumber: 0,
        partialRequestsEnabled: true,
        knownSeasonNumbers: [0, 1],
        unavailableSeasonNumbers: [],
      }),
      [0]
    );
  });

  it('filters only the presented Season without changing the source list', () => {
    const seasons = [
      { seasonNumber: 1, name: 'One' },
      { seasonNumber: 2, name: 'Two' },
      { seasonNumber: 3, name: 'Three' },
    ];
    assert.deepEqual(filterVisibleSeasons(seasons, [2]), [seasons[1]]);
    assert.deepEqual(filterVisibleSeasons(seasons), seasons);
  });

  it('never submits hidden, unknown, unavailable, or duplicate Seasons', () => {
    assert.deepEqual(
      getValidatedSeasonSelection({
        selectedSeasonNumbers: [1, 2, 2, 3, 4],
        knownSeasonNumbers: [1, 2, 3],
        unavailableSeasonNumbers: [3],
        visibleSeasonNumbers: [2],
      }),
      [2]
    );
  });
});
