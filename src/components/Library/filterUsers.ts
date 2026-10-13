import type { LibraryFilterUser } from '@server/interfaces/api/libraryInterfaces';

export interface LibraryFilterUserSnapshot {
  users: LibraryFilterUser[];
  associationFilterActive: boolean;
}

export const emptyLibraryFilterUserSnapshot: LibraryFilterUserSnapshot = {
  users: [],
  associationFilterActive: false,
};

export const getLibraryFilterUsersForPresentation = (
  snapshot: LibraryFilterUserSnapshot,
  userSelectionEnabled: boolean
): LibraryFilterUser[] =>
  userSelectionEnabled && !snapshot.associationFilterActive
    ? snapshot.users.map((user) => ({ ...user, available: false }))
    : snapshot.users;
