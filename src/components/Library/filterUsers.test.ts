import type { LibraryFilterUser } from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLibraryFilterUsersForPresentation,
  type LibraryFilterUserSnapshot,
} from './filterUsers';

const users: LibraryFilterUser[] = [
  { id: 1, displayName: 'Available', avatar: null, available: true },
  { id: 2, displayName: 'Unavailable', avatar: null, available: false },
];

describe('Library filter user availability presentation', () => {
  it('keeps Any to Watchlist Yes gray until the active query resolves', () => {
    const anySnapshot: LibraryFilterUserSnapshot = {
      users,
      associationFilterActive: false,
    };

    assert.deepEqual(
      getLibraryFilterUsersForPresentation(anySnapshot, true).map(
        (user) => user.available
      ),
      [false, false]
    );

    const resolvedWatchlistSnapshot: LibraryFilterUserSnapshot = {
      users,
      associationFilterActive: true,
    };
    assert.deepEqual(
      getLibraryFilterUsersForPresentation(resolvedWatchlistSnapshot, true).map(
        (user) => user.available
      ),
      [true, false]
    );
  });

  it('retains confirmed availability during subsequent active-filter loading', () => {
    const confirmedSnapshot: LibraryFilterUserSnapshot = {
      users,
      associationFilterActive: true,
    };
    assert.deepEqual(
      getLibraryFilterUsersForPresentation(confirmedSnapshot, true),
      users
    );
  });
});
