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

export const watchlistLibraryStatusFilters = [
  'any',
  'absent',
  'active',
  'archived',
] as const;
export type WatchlistLibraryStatusFilter =
  (typeof watchlistLibraryStatusFilters)[number];

export type WatchState = 'watched' | 'not_watched' | 'unknown';

export enum UserMediaIntentType {
  WATCHLIST = 'WATCHLIST',
}

export enum UserMediaIntentState {
  ACTIVE = 'ACTIVE',
  SATISFIED = 'SATISFIED',
  REMOVED = 'REMOVED',
}

export enum UserMediaIntentEndReason {
  USER_REMOVED = 'user_removed',
  CONFIRMED_COMPLETION = 'confirmed_completion',
}
