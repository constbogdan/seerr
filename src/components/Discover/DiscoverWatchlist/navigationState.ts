import type { WatchlistPreferences } from './preferences';

export const WATCHLIST_INITIAL_PAGE_COUNT = 3;
export const WATCHLIST_RETAINED_QUERY_LIMIT = 10;
export const WATCHLIST_RETAINED_PAGE_LIMIT = 50;

export const getWatchlistQueryIdentity = (
  endpoint: string,
  options?: Record<string, string | undefined>
): string =>
  JSON.stringify([
    endpoint,
    Object.entries(options ?? {})
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ]);

export const getInitialWatchlistPageCount = (
  retainedPageCount?: number
): number =>
  Math.min(
    WATCHLIST_RETAINED_PAGE_LIMIT,
    Math.max(
      WATCHLIST_INITIAL_PAGE_COUNT,
      Math.floor(retainedPageCount ?? WATCHLIST_INITIAL_PAGE_COUNT)
    )
  );

const retainBoundedValue = <T>(
  retainedValues: Map<string, T>,
  key: string,
  value: T,
  limit = WATCHLIST_RETAINED_QUERY_LIMIT
): void => {
  retainedValues.delete(key);
  retainedValues.set(key, value);

  while (retainedValues.size > limit) {
    const oldestKey = retainedValues.keys().next().value;
    if (oldestKey === undefined) break;
    retainedValues.delete(oldestKey);
  }
};

export const retainWatchlistPageCount = (
  retainedPageCounts: Map<string, number>,
  queryIdentity: string,
  pageCount: number,
  limit = WATCHLIST_RETAINED_QUERY_LIMIT
): void => {
  retainBoundedValue(
    retainedPageCounts,
    queryIdentity,
    Math.min(WATCHLIST_RETAINED_PAGE_LIMIT, Math.max(1, Math.floor(pageCount))),
    limit
  );
};

export const retainWatchlistPreferences = (
  retainedPreferences: Map<string, WatchlistPreferences>,
  preferenceKey: string,
  preferences: WatchlistPreferences,
  limit = WATCHLIST_RETAINED_QUERY_LIMIT
): void => {
  retainBoundedValue(
    retainedPreferences,
    preferenceKey,
    { ...preferences },
    limit
  );
};
