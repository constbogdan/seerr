import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  clearLibraryDrawerFilters,
  countActiveLibraryFilters,
  defaultLibraryPreferences,
  getInitialLibraryPreferenceState,
  hasLibraryUserAssociationFilter,
  isLibraryScopeSelected,
  libraryPreferencesToQuery,
  normalizeLibraryDate,
  normalizeLibraryPreferences,
  readLibraryPreferences,
  resolveLibraryPreferences,
  toggleLibraryScopeSelection,
  toggleLibraryUserSelection,
} from './preferences';

describe('Library browsing preferences', () => {
  it('keeps Liked selection, Users, persistence and reset on the existing preference path', () => {
    const selected = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      liked: 'no',
      userIds: [1, 2],
    });
    assert.equal(hasLibraryUserAssociationFilter(selected), true);
    assert.deepEqual(selected.userIds, [1, 2]);
    assert.equal(countActiveLibraryFilters(selected), 2);
    const query = libraryPreferencesToQuery(selected);
    assert.equal(query.liked, 'no');
    assert.deepEqual(
      resolveLibraryPreferences({ query, stored: defaultLibraryPreferences }),
      selected
    );
    assert.deepEqual(
      resolveLibraryPreferences({ query: {}, stored: selected }),
      selected
    );
    const combined = normalizeLibraryPreferences({
      ...selected,
      watchlist: 'yes',
      liked: 'any',
    });
    assert.deepEqual(combined.userIds, [1, 2]);
    assert.deepEqual(
      normalizeLibraryPreferences({ ...selected, liked: 'any' }).userIds,
      []
    );
    const reset = clearLibraryDrawerFilters(selected);
    assert.equal(reset.liked, 'any');
    assert.deepEqual(reset.userIds, []);
    assert.equal(
      normalizeLibraryPreferences({ ...selected, liked: 'invalid' as 'yes' })
        .liked,
      'any'
    );
    assert.equal(normalizeLibraryPreferences({}).liked, 'any');
  });
  it('maps independent Active and Archived selections to the existing scope values', () => {
    assert.equal(isLibraryScopeSelected('current', 'active'), true);
    assert.equal(isLibraryScopeSelected('current', 'archived'), false);
    assert.equal(isLibraryScopeSelected('archive', 'active'), false);
    assert.equal(isLibraryScopeSelected('archive', 'archived'), true);
    assert.equal(isLibraryScopeSelected('all', 'active'), true);
    assert.equal(isLibraryScopeSelected('all', 'archived'), true);

    assert.equal(toggleLibraryScopeSelection('current', 'archived'), 'all');
    assert.equal(toggleLibraryScopeSelection('all', 'active'), 'archive');
    assert.equal(toggleLibraryScopeSelection('archive', 'active'), 'all');
    assert.equal(toggleLibraryScopeSelection('all', 'archived'), 'current');
    assert.equal(toggleLibraryScopeSelection('current', 'active'), 'current');
    assert.equal(toggleLibraryScopeSelection('archive', 'archived'), 'archive');
  });

  it('toggles multiple users only within association-filtered state', () => {
    const associationFiltered = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      watched: 'yes',
      userIds: toggleLibraryUserSelection(
        toggleLibraryUserSelection([], 11),
        22
      ),
    });
    assert.deepEqual(associationFiltered.userIds, [11, 22]);

    const firstDeselected = normalizeLibraryPreferences({
      ...associationFiltered,
      userIds: toggleLibraryUserSelection(associationFiltered.userIds, 11),
    });
    assert.deepEqual(firstDeselected.userIds, [22]);

    const switchedUser = normalizeLibraryPreferences({
      ...associationFiltered,
      userIds: toggleLibraryUserSelection(
        toggleLibraryUserSelection([11], 11),
        22
      ),
    });
    assert.deepEqual(switchedUser.userIds, [22]);

    const fullyDeselected = normalizeLibraryPreferences({
      ...firstDeselected,
      userIds: toggleLibraryUserSelection(firstDeselected.userIds, 22),
    });
    assert.deepEqual(fullyDeselected.userIds, []);
  });

  it('clears users and their URL state when all association filters are Any', () => {
    for (const association of [
      'watchlist',
      'watched',
      'requested',
      'liked',
    ] as const) {
      const enabled = normalizeLibraryPreferences({
        ...defaultLibraryPreferences,
        [association]: 'no',
        userIds: [11, 22],
      });
      assert.equal(hasLibraryUserAssociationFilter(enabled), true);
      assert.deepEqual(enabled.userIds, [11, 22]);
    }

    const disabled = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      userIds: [11, 22],
    });
    assert.equal(hasLibraryUserAssociationFilter(disabled), false);
    assert.deepEqual(disabled.userIds, []);
    assert.equal(libraryPreferencesToQuery(disabled).userIds, undefined);

    const returnedToAny = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      watched: 'any',
      userIds: [11, 22],
    });
    assert.deepEqual(returnedToAny.userIds, []);
    assert.deepEqual(
      readLibraryPreferences(JSON.stringify(returnedToAny)).userIds,
      []
    );
  });

  it('canonicalizes picker date values without a UTC calendar-day shift', () => {
    assert.equal(normalizeLibraryDate('2026-2-1'), '2026-02-01');
    assert.equal(normalizeLibraryDate('2026-12-9'), '2026-12-09');
    assert.equal(normalizeLibraryDate('2024-2-29'), '2024-02-29');
    assert.equal(normalizeLibraryDate('2025-2-29'), undefined);
    assert.equal(normalizeLibraryDate('2026-13-1'), undefined);
    assert.equal(normalizeLibraryDate('2026-4-31'), undefined);
    assert.equal(normalizeLibraryDate('not-a-date'), undefined);

    const localDate = new Date(2026, 0, 2, 23, 30);
    assert.equal(normalizeLibraryDate(localDate), '2026-01-02');
  });

  it('round-trips all persistent controls through a canonical URL', () => {
    const preferences = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      scope: 'all',
      mediaType: 'series',
      collectionMembership: 'in',
      animation: 'yes',
      storageRootIds: [4, 2, 4],
      watchlist: 'yes',
      watched: 'no',
      requested: 'yes',
      liked: 'no',
      userIds: [7, 3],
      addedFrom: '2024-01-01',
      addedTo: '2024-12-31',
      activity: 'present',
      activityFrom: '2024-03-01',
      activityTo: '2024-10-01',
      scheduled: 'yes',
      removalDueTo: '2027-01-01',
      removedFrom: '2023-01-01',
      removalSources: ['manual', 'external'],
      sort: 'watchedUsers',
      sortDirection: 'asc',
      pageSize: 50,
    });
    const query = libraryPreferencesToQuery(preferences);
    assert.deepEqual(
      resolveLibraryPreferences({ query, stored: defaultLibraryPreferences }),
      preferences
    );
  });

  it('restores stored preferences only for a URL without explicit browsing state', () => {
    const stored = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      scope: 'archive',
      watched: 'yes',
      sort: 'removed',
    });
    assert.deepEqual(resolveLibraryPreferences({ query: {}, stored }), stored);
    assert.equal(
      resolveLibraryPreferences({
        query: { scope: 'current' },
        stored,
      }).watched,
      'any'
    );
  });

  it('makes canonical history entries render-ready before Next restores scroll', () => {
    const query = {
      ...libraryPreferencesToQuery({
        ...defaultLibraryPreferences,
        mediaType: 'movie',
        collectionMembership: 'none',
        sort: 'title',
      }),
      page: '3',
      search: 'dune',
    };
    const initial = getInitialLibraryPreferenceState({
      query,
      routeReady: true,
    });

    assert.equal(initial.ready, true);
    assert.equal(initial.preferences.mediaType, 'movie');
    assert.equal(initial.preferences.collectionMembership, 'none');
    assert.equal(initial.preferences.sort, 'title');
    assert.equal(
      getInitialLibraryPreferenceState({ query, routeReady: false }).ready,
      false
    );
    assert.equal(
      getInitialLibraryPreferenceState({
        query: { page: '3', search: 'dune' },
        routeReady: true,
      }).ready,
      false
    );
  });

  it('does not persist transient search, page, or expanded row state', () => {
    const query = libraryPreferencesToQuery(defaultLibraryPreferences);
    assert.equal('search' in query, false);
    assert.equal('page' in query, false);
    assert.equal('expanded' in query, false);
  });

  it('clears incompatible scope filters while preserving meaningful All combinations', () => {
    const all = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      scope: 'all',
      animation: 'no',
      scheduled: 'yes',
      removalDueFrom: '2026-01-01',
      removedFrom: '2025-01-01',
      removalSources: ['scheduled'],
    });
    assert.equal(all.scheduled, 'yes');
    assert.equal(all.removedFrom, '2025-01-01');
    const current = normalizeLibraryPreferences({ ...all, scope: 'current' });
    assert.equal(current.removedFrom, undefined);
    assert.deepEqual(current.removalSources, []);
    const archive = normalizeLibraryPreferences({ ...all, scope: 'archive' });
    assert.equal(archive.scheduled, 'any');
    assert.equal(archive.removalDueFrom, undefined);
  });

  it('counts grouped ranges once and users only when a people predicate is active', () => {
    assert.equal(
      countActiveLibraryFilters({
        ...defaultLibraryPreferences,
        animation: 'yes',
      }),
      1
    );
    assert.equal(
      countActiveLibraryFilters({
        ...defaultLibraryPreferences,
        collectionMembership: 'in',
      }),
      1
    );
    const inactiveUsers = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      userIds: [1],
      addedFrom: '2025-01-01',
      addedTo: '2025-02-01',
    });
    assert.deepEqual(inactiveUsers.userIds, []);
    assert.equal(countActiveLibraryFilters(inactiveUsers), 1);
    const activeUsers = normalizeLibraryPreferences({
      ...inactiveUsers,
      watched: 'yes',
      userIds: [1],
    });
    assert.equal(countActiveLibraryFilters(activeUsers), 3);
    assert.equal(
      countActiveLibraryFilters({
        ...defaultLibraryPreferences,
        scope: 'archive',
      }),
      1
    );
  });

  it('clears scope and drawer filters without changing media, sort, or page size', () => {
    const original = normalizeLibraryPreferences({
      ...defaultLibraryPreferences,
      scope: 'all',
      mediaType: 'movie',
      collectionMembership: 'none',
      watched: 'yes',
      addedFrom: '2024-01-01',
      addedTo: '2024-01-31',
      activityFrom: '2024-02-01',
      activityTo: '2024-02-29',
      removalDueFrom: '2024-03-01',
      removalDueTo: '2024-03-31',
      removedFrom: '2025-01-01',
      removedTo: '2025-01-31',
      sort: 'title',
      pageSize: 100,
    });
    const cleared = clearLibraryDrawerFilters(original);
    assert.equal(cleared.scope, defaultLibraryPreferences.scope);
    assert.equal(cleared.mediaType, 'movie');
    assert.equal(cleared.collectionMembership, 'any');
    assert.equal(cleared.animation, 'any');
    assert.equal(cleared.sort, 'title');
    assert.equal(cleared.pageSize, 100);
    assert.equal(countActiveLibraryFilters(cleared), 0);
    const query = libraryPreferencesToQuery(cleared);
    for (const key of [
      'addedFrom',
      'addedTo',
      'activityFrom',
      'activityTo',
      'removalDueFrom',
      'removalDueTo',
      'removedFrom',
      'removedTo',
    ])
      assert.equal(query[key], undefined, key);
    assert.deepEqual(
      resolveLibraryPreferences({ query, stored: original }),
      cleared
    );
    assert.deepEqual(readLibraryPreferences(JSON.stringify(cleared)), cleared);
  });

  it('safely rejects malformed persisted values', () => {
    assert.deepEqual(
      readLibraryPreferences('{broken'),
      defaultLibraryPreferences
    );
    assert.equal(
      readLibraryPreferences(JSON.stringify({ pageSize: 999 })).pageSize,
      25
    );
    assert.equal(
      readLibraryPreferences(
        JSON.stringify({ collectionMembership: 'unknown' })
      ).collectionMembership,
      'any'
    );
  });
});
