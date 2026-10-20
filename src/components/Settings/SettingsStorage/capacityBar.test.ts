import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitRootCapacity } from './capacityBar';

describe('Storage capacity-bar presentation', () => {
  it('separates Leaving Soon without changing the root allocation', () => {
    const split = splitRootCapacity({
      indexedUsageBytes: '400',
      pendingRemovalBytes: '100',
      percentage: 40,
      totalSpace: 1000,
    });

    assert.deepEqual(split, {
      retainedBytes: '300',
      retainedPercentage: 30,
      leavingSoonPercentage: 10,
    });
    assert.equal(split.retainedPercentage + split.leavingSoonPercentage, 40);
  });

  it('caps contradictory Leaving Soon bytes at the indexed root usage', () => {
    assert.deepEqual(
      splitRootCapacity({
        indexedUsageBytes: '50',
        pendingRemovalBytes: '75',
        percentage: 5,
        totalSpace: 1000,
      }),
      {
        retainedBytes: '0',
        retainedPercentage: 0,
        leavingSoonPercentage: 5,
      }
    );
  });

  it('fails closed for zero-byte, unavailable, and malformed facts', () => {
    for (const input of [
      {
        indexedUsageBytes: '0',
        pendingRemovalBytes: '0',
        percentage: 0,
        totalSpace: 1000,
      },
      {
        indexedUsageBytes: '100',
        pendingRemovalBytes: null,
        percentage: null,
        totalSpace: null,
      },
      {
        indexedUsageBytes: 'invalid',
        pendingRemovalBytes: '50',
        percentage: 5,
        totalSpace: 1000,
      },
    ]) {
      const split = splitRootCapacity(input);
      assert.equal(split.leavingSoonPercentage, 0);
      assert.ok(split.retainedPercentage >= 0);
    }
  });
});
