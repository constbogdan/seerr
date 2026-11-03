import type {
  LibraryBulkActionTarget,
  LibrarySelectionSizeResponse,
} from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLibrarySelectionSizePresentation } from './selectionSize';

const targets: LibraryBulkActionTarget[] = [
  { canonicalMediaId: 1, targetType: 'movie' },
  { canonicalMediaId: 2, targetType: 'season', seasonNumber: 3 },
];

const response: LibrarySelectionSizeResponse = {
  targets,
  sizeBytes: '2048',
  fileCount: 2,
  unknownFileCount: 0,
};

describe('Library selected-size presentation', () => {
  it('accepts only a response for the exact ordered selection', () => {
    const current = getLibrarySelectionSizePresentation(targets, response);
    assert.equal(current.matchesSelection, true);
    assert.equal(current.retained, false);
    assert.equal(current.sizeBytes, '2048');

    const reordered = getLibrarySelectionSizePresentation(
      [targets[1], targets[0]],
      response
    );
    assert.equal(reordered.matchesSelection, false);
    assert.equal(reordered.retained, true);
    assert.equal(reordered.sizeBytes, '2048');
  });

  it('does not treat a Season response as another Season selection', () => {
    const changed = getLibrarySelectionSizePresentation(
      [{ canonicalMediaId: 2, targetType: 'season', seasonNumber: 4 }],
      response
    );
    assert.equal(changed.matchesSelection, false);
    assert.equal(changed.retained, true);
  });

  it('has no retained result before the first response', () => {
    assert.deepEqual(getLibrarySelectionSizePresentation(targets), {
      matchesSelection: false,
      retained: false,
      sizeBytes: null,
      fileCount: 0,
      unknownFileCount: 0,
    });
  });
});
