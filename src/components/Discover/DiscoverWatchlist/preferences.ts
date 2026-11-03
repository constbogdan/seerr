import {
  watchlistCategories,
  watchlistLibraryStatusFilters,
  watchlistSorts,
  watchlistWatchedFilters,
  type WatchlistCategory,
  type WatchlistLibraryStatusFilter,
  type WatchlistSort,
  type WatchlistWatchedFilter,
} from '@server/constants/watchlist';

export const WATCHLIST_PREFERENCE_KEY = 'watchlist-presentation-v1';

export const getWatchlistPreferenceKey = (userId: number): string =>
  `${WATCHLIST_PREFERENCE_KEY}:user-${userId}`;

export interface WatchlistPreferences {
  owner: string;
  category: WatchlistCategory;
  sort: WatchlistSort;
  watched: WatchlistWatchedFilter;
  libraryStatus: WatchlistLibraryStatusFilter;
}

export const defaultWatchlistPreferences: WatchlistPreferences = {
  owner: 'me',
  category: 'all',
  sort: 'added_desc',
  watched: 'not_watched',
  libraryStatus: 'absent',
};

export const readWatchlistPreferences = (
  value: string | null
): WatchlistPreferences => {
  if (!value) {
    return defaultWatchlistPreferences;
  }

  try {
    const parsed = JSON.parse(value) as Partial<WatchlistPreferences>;
    return {
      owner:
        parsed.owner === 'me' ||
        parsed.owner === 'all' ||
        (typeof parsed.owner === 'string' && /^[1-9]\d*$/.test(parsed.owner))
          ? parsed.owner
          : defaultWatchlistPreferences.owner,
      category: watchlistCategories.includes(
        parsed.category as WatchlistCategory
      )
        ? (parsed.category as WatchlistCategory)
        : defaultWatchlistPreferences.category,
      sort: watchlistSorts.includes(parsed.sort as WatchlistSort)
        ? (parsed.sort as WatchlistSort)
        : defaultWatchlistPreferences.sort,
      watched: watchlistWatchedFilters.includes(
        parsed.watched as WatchlistWatchedFilter
      )
        ? (parsed.watched as WatchlistWatchedFilter)
        : defaultWatchlistPreferences.watched,
      libraryStatus: watchlistLibraryStatusFilters.includes(
        parsed.libraryStatus as WatchlistLibraryStatusFilter
      )
        ? (parsed.libraryStatus as WatchlistLibraryStatusFilter)
        : defaultWatchlistPreferences.libraryStatus,
    };
  } catch {
    return defaultWatchlistPreferences;
  }
};

export const resolveWatchlistPreferences = ({
  queryCategory,
  queryOwner,
  querySort,
  queryWatched,
  queryLibraryStatus,
  stored,
}: {
  queryCategory?: string;
  queryOwner?: string;
  querySort?: string;
  queryWatched?: string;
  queryLibraryStatus?: string;
  stored: WatchlistPreferences;
}): WatchlistPreferences => ({
  owner:
    queryOwner === 'me' ||
    queryOwner === 'all' ||
    (typeof queryOwner === 'string' && /^[1-9]\d*$/.test(queryOwner))
      ? queryOwner
      : stored.owner,
  category: watchlistCategories.includes(queryCategory as WatchlistCategory)
    ? (queryCategory as WatchlistCategory)
    : stored.category,
  sort: watchlistSorts.includes(querySort as WatchlistSort)
    ? (querySort as WatchlistSort)
    : stored.sort,
  watched: watchlistWatchedFilters.includes(
    queryWatched as WatchlistWatchedFilter
  )
    ? (queryWatched as WatchlistWatchedFilter)
    : stored.watched,
  libraryStatus: watchlistLibraryStatusFilters.includes(
    queryLibraryStatus as WatchlistLibraryStatusFilter
  )
    ? (queryLibraryStatus as WatchlistLibraryStatusFilter)
    : stored.libraryStatus,
});

export const resolveEligibleWatchlistOwner = (
  owner: string,
  eligibleOwners: string[]
): string => {
  if (eligibleOwners.includes(owner)) return owner;
  return eligibleOwners.includes('me') ? 'me' : 'all';
};
