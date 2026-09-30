export const watchlistCategories = [
  'all',
  'movies',
  'series',
  'animation',
] as const;
export type WatchlistCategory = (typeof watchlistCategories)[number];

export const watchlistSorts = [
  'added_desc',
  'added_asc',
  'title_asc',
  'title_desc',
] as const;
export type WatchlistSort = (typeof watchlistSorts)[number];

export const watchlistWatchedFilters = [
  'not_watched',
  'watched',
  'all',
] as const;
export type WatchlistWatchedFilter = (typeof watchlistWatchedFilters)[number];

export type WatchState = 'watched' | 'not_watched' | 'unknown';
