import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LIBRARY_PROGRESSIVE_BATCH_SIZE,
  getInitialLibraryMountCount,
  getNextLibraryMountCount,
} from './progressiveRendering';

describe('Library progressive rendering', () => {
  it('mounts at most one initial batch', () => {
    assert.equal(LIBRARY_PROGRESSIVE_BATCH_SIZE, 5);
    assert.equal(getInitialLibraryMountCount(3), 3);
    assert.equal(getInitialLibraryMountCount(100), 5);
  });

  it('advances by a bounded batch and clamps to the total', () => {
    assert.equal(getNextLibraryMountCount(5, 100), 10);
    assert.equal(getNextLibraryMountCount(98, 100), 100);
  });
});
