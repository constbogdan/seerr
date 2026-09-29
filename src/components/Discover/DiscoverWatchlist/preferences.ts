import {
  watchlistCategories,
  watchlistSorts,
  watchlistWatchedFilters,
  type WatchlistCategory,
  type WatchlistSort,
  type WatchlistWatchedFilter,
} from '@server/constants/watchlist';

export const WATCHLIST_PREFERENCE_KEY = 'watchlist-presentation-v1';

export const getWatchlistPreferenceKey = (userId: number): string =>
  `${WATCHLIST_PREFERENCE_KEY}:user-${userId}`;

export interface WatchlistPreferences {
  category: WatchlistCategory;
  sort: WatchlistSort;
  watched: WatchlistWatchedFilter;
}

export const defaultWatchlistPreferences: WatchlistPreferences = {
  category: 'all',
  sort: 'added_desc',
  watched: 'not_watched',
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
    };
  } catch {
    return defaultWatchlistPreferences;
  }
};

export const resolveWatchlistPreferences = ({
  queryCategory,
  querySort,
  queryWatched,
  stored,
}: {
  queryCategory?: string;
  querySort?: string;
  queryWatched?: string;
  stored: WatchlistPreferences;
}): WatchlistPreferences => ({
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
});
