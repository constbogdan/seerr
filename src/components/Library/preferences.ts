import type {
  LibraryActivityFilter,
  LibraryAnimationFilter,
  LibraryMediaTypeFilter,
  LibraryRemovalSource,
  LibraryRequestedFilter,
  LibraryScheduledFilter,
  LibraryScope,
  LibrarySort,
  LibrarySortDirection,
  LibraryWatchedFilter,
  LibraryWatchlistFilter,
} from '@server/interfaces/api/libraryInterfaces';
import type { ParsedUrlQuery } from 'querystring';

export const LIBRARY_PREFERENCE_KEY = 'library-presentation-v1';

export const getLibraryPreferenceKey = (userId: number): string =>
  `${LIBRARY_PREFERENCE_KEY}:user-${userId}`;

export interface LibraryPreferences {
  scope: LibraryScope;
  mediaType: LibraryMediaTypeFilter;
  animation: LibraryAnimationFilter;
  storageRootIds: number[];
  watchlist: LibraryWatchlistFilter;
  watched: LibraryWatchedFilter;
  requested: LibraryRequestedFilter;
  userIds: number[];
  addedFrom?: string;
  addedTo?: string;
  activity: LibraryActivityFilter;
  activityFrom?: string;
  activityTo?: string;
  scheduled: LibraryScheduledFilter;
  removalDueFrom?: string;
  removalDueTo?: string;
  removedFrom?: string;
  removedTo?: string;
  removalSources: LibraryRemovalSource[];
  sort: LibrarySort;
  sortDirection: LibrarySortDirection;
  pageSize: number;
}

export const defaultLibraryPreferences: LibraryPreferences = {
  scope: 'current',
  mediaType: 'all',
  animation: 'any',
  storageRootIds: [],
  watchlist: 'any',
  watched: 'any',
  requested: 'any',
  userIds: [],
  activity: 'any',
  scheduled: 'any',
  removalSources: [],
  sort: 'size',
  sortDirection: 'desc',
  pageSize: 25,
};

export type LibraryScopeSelection = 'active' | 'archived';

export const isLibraryScopeSelected = (
  scope: LibraryScope,
  selection: LibraryScopeSelection
): boolean =>
  selection === 'active' ? scope !== 'archive' : scope !== 'current';

export const toggleLibraryScopeSelection = (
  scope: LibraryScope,
  selection: LibraryScopeSelection
): LibraryScope => {
  let active = isLibraryScopeSelected(scope, 'active');
  let archived = isLibraryScopeSelected(scope, 'archived');
  if (selection === 'active') active = !active;
  else archived = !archived;
  if (!active && !archived) return scope;
  if (active && archived) return 'all';
  return active ? 'current' : 'archive';
};

export const toggleLibraryUserSelection = (
  userIds: number[],
  userId: number
): number[] =>
  userIds.includes(userId)
    ? userIds.filter((id) => id !== userId)
    : [...userIds, userId];

export const hasLibraryUserAssociationFilter = (
  preferences: Pick<LibraryPreferences, 'watchlist' | 'watched' | 'requested'>
): boolean =>
  [preferences.watchlist, preferences.watched, preferences.requested].some(
    (value) => value !== 'any'
  );

const allowedScope = new Set<LibraryScope>(['current', 'archive', 'all']);
const allowedMediaType = new Set<LibraryMediaTypeFilter>([
  'all',
  'movie',
  'series',
]);
const allowedTriState = new Set(['any', 'yes', 'no']);
const allowedActivity = new Set<LibraryActivityFilter>([
  'any',
  'present',
  'none',
]);
const allowedSort = new Set<LibrarySort>([
  'title',
  'added',
  'lastActive',
  'size',
  'removed',
  'watchedUsers',
]);
const allowedDirection = new Set<LibrarySortDirection>(['asc', 'desc']);
const allowedRemovalSource = new Set<LibraryRemovalSource>([
  'manual',
  'scheduled',
  'external',
  'unknown',
]);
const allowedPageSize = new Set([10, 25, 50, 100]);
const datePattern = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const numbers = (value: unknown): number[] => {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return [
    ...new Set(
      source
        .map(Number)
        .filter((item) => Number.isSafeInteger(item) && item > 0)
    ),
  ];
};

export const normalizeLibraryDate = (value: unknown): string | undefined => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return [
      String(value.getFullYear()).padStart(4, '0'),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }
  if (typeof value !== 'string') return undefined;
  const match = datePattern.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  )
    return undefined;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(
    2,
    '0'
  )}`;
};

const date = normalizeLibraryDate;

export const normalizeLibraryPreferences = (
  input: Partial<LibraryPreferences>
): LibraryPreferences => {
  const scope = allowedScope.has(input.scope as LibraryScope)
    ? (input.scope as LibraryScope)
    : defaultLibraryPreferences.scope;
  const normalized: LibraryPreferences = {
    scope,
    mediaType: allowedMediaType.has(input.mediaType as LibraryMediaTypeFilter)
      ? (input.mediaType as LibraryMediaTypeFilter)
      : defaultLibraryPreferences.mediaType,
    animation: allowedTriState.has(input.animation ?? '')
      ? (input.animation as LibraryAnimationFilter)
      : 'any',
    storageRootIds: numbers(input.storageRootIds),
    watchlist: allowedTriState.has(input.watchlist ?? '')
      ? (input.watchlist as LibraryWatchlistFilter)
      : 'any',
    watched: allowedTriState.has(input.watched ?? '')
      ? (input.watched as LibraryWatchedFilter)
      : 'any',
    requested: allowedTriState.has(input.requested ?? '')
      ? (input.requested as LibraryRequestedFilter)
      : 'any',
    userIds: numbers(input.userIds),
    addedFrom: date(input.addedFrom),
    addedTo: date(input.addedTo),
    activity: allowedActivity.has(input.activity as LibraryActivityFilter)
      ? (input.activity as LibraryActivityFilter)
      : 'any',
    activityFrom: date(input.activityFrom),
    activityTo: date(input.activityTo),
    scheduled: allowedTriState.has(input.scheduled ?? '')
      ? (input.scheduled as LibraryScheduledFilter)
      : 'any',
    removalDueFrom: date(input.removalDueFrom),
    removalDueTo: date(input.removalDueTo),
    removedFrom: date(input.removedFrom),
    removedTo: date(input.removedTo),
    removalSources: (input.removalSources ?? []).filter((source) =>
      allowedRemovalSource.has(source)
    ),
    sort: allowedSort.has(input.sort as LibrarySort)
      ? (input.sort as LibrarySort)
      : defaultLibraryPreferences.sort,
    sortDirection: allowedDirection.has(
      input.sortDirection as LibrarySortDirection
    )
      ? (input.sortDirection as LibrarySortDirection)
      : defaultLibraryPreferences.sortDirection,
    pageSize: allowedPageSize.has(Number(input.pageSize))
      ? Number(input.pageSize)
      : defaultLibraryPreferences.pageSize,
  };
  if (!hasLibraryUserAssociationFilter(normalized)) normalized.userIds = [];
  if (scope === 'current') {
    normalized.removedFrom = undefined;
    normalized.removedTo = undefined;
    normalized.removalSources = [];
  } else if (scope === 'archive') {
    normalized.scheduled = 'any';
    normalized.removalDueFrom = undefined;
    normalized.removalDueTo = undefined;
  }
  return normalized;
};

export const readLibraryPreferences = (
  value: string | null
): LibraryPreferences => {
  if (!value) return defaultLibraryPreferences;
  try {
    return normalizeLibraryPreferences(
      JSON.parse(value) as Partial<LibraryPreferences>
    );
  } catch {
    return defaultLibraryPreferences;
  }
};

const preferenceQueryKeys: (keyof LibraryPreferences)[] = [
  'scope',
  'mediaType',
  'animation',
  'storageRootIds',
  'watchlist',
  'watched',
  'requested',
  'userIds',
  'addedFrom',
  'addedTo',
  'activity',
  'activityFrom',
  'activityTo',
  'scheduled',
  'removalDueFrom',
  'removalDueTo',
  'removedFrom',
  'removedTo',
  'removalSources',
  'sort',
  'sortDirection',
  'pageSize',
];

export const hasExplicitLibraryPreferences = (query: ParsedUrlQuery): boolean =>
  preferenceQueryKeys.some((key) => query[key] !== undefined);

export const resolveLibraryPreferences = ({
  query,
  stored,
}: {
  query: ParsedUrlQuery;
  stored: LibraryPreferences;
}): LibraryPreferences => {
  const base = hasExplicitLibraryPreferences(query)
    ? defaultLibraryPreferences
    : stored;
  return normalizeLibraryPreferences({
    ...base,
    ...(query.scope !== undefined && {
      scope: first(query.scope) as LibraryScope,
    }),
    ...(query.mediaType !== undefined && {
      mediaType: first(query.mediaType) as LibraryMediaTypeFilter,
    }),
    ...(query.animation !== undefined && {
      animation: first(query.animation) as LibraryAnimationFilter,
    }),
    ...(query.storageRootIds !== undefined && {
      storageRootIds: numbers(first(query.storageRootIds)),
    }),
    ...(query.watchlist !== undefined && {
      watchlist: first(query.watchlist) as LibraryWatchlistFilter,
    }),
    ...(query.watched !== undefined && {
      watched: first(query.watched) as LibraryWatchedFilter,
    }),
    ...(query.requested !== undefined && {
      requested: first(query.requested) as LibraryRequestedFilter,
    }),
    ...(query.userIds !== undefined && {
      userIds: numbers(first(query.userIds)),
    }),
    ...(query.addedFrom !== undefined && { addedFrom: first(query.addedFrom) }),
    ...(query.addedTo !== undefined && { addedTo: first(query.addedTo) }),
    ...(query.activity !== undefined && {
      activity: first(query.activity) as LibraryActivityFilter,
    }),
    ...(query.activityFrom !== undefined && {
      activityFrom: first(query.activityFrom),
    }),
    ...(query.activityTo !== undefined && {
      activityTo: first(query.activityTo),
    }),
    ...(query.scheduled !== undefined && {
      scheduled: first(query.scheduled) as LibraryScheduledFilter,
    }),
    ...(query.removalDueFrom !== undefined && {
      removalDueFrom: first(query.removalDueFrom),
    }),
    ...(query.removalDueTo !== undefined && {
      removalDueTo: first(query.removalDueTo),
    }),
    ...(query.removedFrom !== undefined && {
      removedFrom: first(query.removedFrom),
    }),
    ...(query.removedTo !== undefined && {
      removedTo: first(query.removedTo),
    }),
    ...(query.removalSources !== undefined && {
      removalSources: first(query.removalSources)
        ?.split(',')
        .filter((source): source is LibraryRemovalSource =>
          allowedRemovalSource.has(source as LibraryRemovalSource)
        ),
    }),
    ...(query.sort !== undefined && { sort: first(query.sort) as LibrarySort }),
    ...(query.sortDirection !== undefined && {
      sortDirection: first(query.sortDirection) as LibrarySortDirection,
    }),
    ...(query.pageSize !== undefined && {
      pageSize: Number(first(query.pageSize)),
    }),
  });
};

export const libraryPreferencesToQuery = (
  preferences: LibraryPreferences
): Record<string, string | undefined> => ({
  scope: preferences.scope,
  mediaType: preferences.mediaType,
  animation: preferences.animation,
  storageRootIds: preferences.storageRootIds.length
    ? preferences.storageRootIds.join(',')
    : undefined,
  watchlist: preferences.watchlist,
  watched: preferences.watched,
  requested: preferences.requested,
  userIds:
    hasLibraryUserAssociationFilter(preferences) && preferences.userIds.length
      ? preferences.userIds.join(',')
      : undefined,
  addedFrom: preferences.addedFrom,
  addedTo: preferences.addedTo,
  activity: preferences.activity,
  activityFrom: preferences.activityFrom,
  activityTo: preferences.activityTo,
  scheduled: preferences.scheduled,
  removalDueFrom: preferences.removalDueFrom,
  removalDueTo: preferences.removalDueTo,
  removedFrom: preferences.removedFrom,
  removedTo: preferences.removedTo,
  removalSources: preferences.removalSources.length
    ? preferences.removalSources.join(',')
    : undefined,
  sort: preferences.sort,
  sortDirection: preferences.sortDirection,
  pageSize: String(preferences.pageSize),
});

export const clearLibraryDrawerFilters = (
  preferences: LibraryPreferences
): LibraryPreferences =>
  normalizeLibraryPreferences({
    ...preferences,
    scope: defaultLibraryPreferences.scope,
    animation: 'any',
    storageRootIds: [],
    watchlist: 'any',
    watched: 'any',
    requested: 'any',
    userIds: [],
    addedFrom: undefined,
    addedTo: undefined,
    activity: 'any',
    activityFrom: undefined,
    activityTo: undefined,
    scheduled: 'any',
    removalDueFrom: undefined,
    removalDueTo: undefined,
    removedFrom: undefined,
    removedTo: undefined,
    removalSources: [],
  });

export const countActiveLibraryFilters = (
  preferences: LibraryPreferences
): number => {
  let count = 0;
  if (preferences.scope !== defaultLibraryPreferences.scope) count++;
  if (preferences.animation !== 'any') count++;
  if (preferences.storageRootIds.length) count++;
  if (preferences.watchlist !== 'any') count++;
  if (preferences.watched !== 'any') count++;
  if (preferences.requested !== 'any') count++;
  if (
    preferences.userIds.length &&
    hasLibraryUserAssociationFilter(preferences)
  )
    count++;
  if (preferences.addedFrom || preferences.addedTo) count++;
  if (preferences.activity !== 'any') count++;
  if (preferences.activityFrom || preferences.activityTo) count++;
  if (preferences.scheduled !== 'any') count++;
  if (preferences.removalDueFrom || preferences.removalDueTo) count++;
  if (preferences.removedFrom || preferences.removedTo) count++;
  if (preferences.removalSources.length) count++;
  return count;
};
