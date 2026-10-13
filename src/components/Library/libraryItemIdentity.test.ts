import type { LibraryItem } from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stabilizeLibraryItems } from './libraryItemIdentity';

const item = (overrides: Partial<LibraryItem> = {}) =>
  ({
    canonicalMediaId: 1,
    mediaType: 'movie',
    title: 'Movie',
    ...overrides,
  }) as LibraryItem;

describe('stabilizeLibraryItems', () => {
  it('retains the array and objects when all API facts are unchanged', () => {
    const previous = [item()];
    const stabilized = stabilizeLibraryItems(previous, [item()]);

    assert.equal(stabilized, previous);
    assert.equal(stabilized[0], previous[0]);
  });

  it('retains unchanged objects while preserving incoming order', () => {
    const first = item();
    const second = item({ canonicalMediaId: 2, title: 'Second' });
    const stabilized = stabilizeLibraryItems(
      [first, second],
      [item({ canonicalMediaId: 2, title: 'Second' }), item()]
    );

    assert.deepEqual(stabilized, [second, first]);
    assert.equal(stabilized[0], second);
    assert.equal(stabilized[1], first);
  });

  it('replaces an object when any nested fact changes', () => {
    const previous = item({
      collection: {
        id: 7,
        name: 'Collection',
        posterPath: null,
        backdropPath: null,
      },
    });
    const incoming = item({
      collection: {
        id: 7,
        name: 'Updated',
        posterPath: null,
        backdropPath: null,
      },
    });
    const stabilized = stabilizeLibraryItems([previous], [incoming]);

    assert.notEqual(stabilized[0], previous);
    assert.equal(stabilized[0], incoming);
  });
});
