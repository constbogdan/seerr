import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  calculateFreePercentage,
  classifyFreeSpace,
  FREE_SPACE_LEVEL_COLORS,
} from './freeSpaceLevel';

describe('Storage free-space levels', () => {
  it('calculates free percentage from raw physical capacity bytes', () => {
    assert.equal(calculateFreePercentage(1_000, 0), 0);
    assert.equal(calculateFreePercentage(1_000, 50), 5);
    assert.equal(calculateFreePercentage(1_000, 150), 15);
    assert.equal(calculateFreePercentage(1_000, 151), 15.1);
  });

  it('classifies raw percentages and treats the exact threshold as normal', () => {
    assert.equal(classifyFreeSpace(9.999999, 10), 'low');
    assert.equal(classifyFreeSpace(10, 10), 'normal');
    assert.equal(classifyFreeSpace(10.000001, 10), 'normal');
    assert.equal(classifyFreeSpace(0, 10), 'low');
  });

  it('keeps unknown and contradictory capacity neutral and unclassified', () => {
    for (const [total, free] of [
      [null, 10],
      [100, null],
      [0, 0],
      [100, -1],
      [100, 101],
    ] as const) {
      assert.equal(calculateFreePercentage(total, free), null);
    }
    assert.equal(classifyFreeSpace(null, 10), 'unknown');
    assert.equal(classifyFreeSpace(10, Number.NaN), 'unknown');
  });

  it('uses the approved soft status colors', () => {
    assert.deepEqual(FREE_SPACE_LEVEL_COLORS, {
      low: '#CD7F7F',
      normal: '#77AD8C',
      unknown: '#6B7280',
    });
  });
});
