import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LIBRARY_PROGRESSIVE_BATCH_SIZE,
  LIBRARY_RETAINED_QUERY_LIMIT,
  getInitialLibraryMountCount,
  getNextLibraryMountCount,
  retainLibraryMountCount,
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

  it('restores only the rows already mounted for the same Library query', () => {
    assert.equal(getInitialLibraryMountCount(100, 5, 40), 40);
    assert.equal(getInitialLibraryMountCount(25, 5, 40), 25);
    assert.equal(getInitialLibraryMountCount(100, 5, 0), 5);
  });

  it('bounds retained query state without sharing counts between filters', () => {
    const retained = new Map<string, number>();
    retainLibraryMountCount(retained, 'movies:title', 35, 2);
    retainLibraryMountCount(retained, 'series:title', 20, 2);
    retainLibraryMountCount(retained, 'movies:size', 15, 2);

    assert.equal(retained.has('movies:title'), false);
    assert.equal(retained.get('series:title'), 20);
    assert.equal(retained.get('movies:size'), 15);
    assert.equal(LIBRARY_RETAINED_QUERY_LIMIT, 10);
  });
});
