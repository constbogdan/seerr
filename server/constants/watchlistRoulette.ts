export const MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN = 1;
export const MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN = 100;

export type WatchlistRouletteRunStatus = 'succeeded' | 'failed';

export type WatchlistRouletteFailureCode =
  | 'request-owner-unavailable'
  | 'provider-not-configured'
  | 'acquisition-state-unavailable'
  | 'unexpected-error';

export interface WatchlistRouletteRunSummary {
  startedAt: string;
  completedAt: string;
  status: WatchlistRouletteRunStatus;
  requested: number;
  skipped: number;
  failed: number;
  examined: number;
  requestIds: number[];
  failureCode?: WatchlistRouletteFailureCode;
}

export interface WatchlistRouletteSettings {
  requestOwnerUserId: number | null;
  movieItemsPerRun: number;
  seriesItemsPerRun: number;
  lastMovieRun?: WatchlistRouletteRunSummary;
  lastSeriesRun?: WatchlistRouletteRunSummary;
}

export const DEFAULT_WATCHLIST_ROULETTE_SETTINGS: WatchlistRouletteSettings = {
  requestOwnerUserId: null,
  movieItemsPerRun: 3,
  seriesItemsPerRun: 1,
};

const normalizeItemsPerRun = (value: unknown, fallback: number): number =>
  Number.isSafeInteger(value) &&
  Number(value) >= MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN &&
  Number(value) <= MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN
    ? Number(value)
    : fallback;

const normalizeRunSummary = (
  value: unknown
): WatchlistRouletteRunSummary | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<WatchlistRouletteRunSummary>;
  if (
    typeof candidate.startedAt !== 'string' ||
    typeof candidate.completedAt !== 'string' ||
    !['succeeded', 'failed'].includes(candidate.status ?? '') ||
    !Number.isSafeInteger(candidate.requested) ||
    !Number.isSafeInteger(candidate.skipped) ||
    !Number.isSafeInteger(candidate.failed) ||
    !Number.isSafeInteger(candidate.examined) ||
    !Array.isArray(candidate.requestIds) ||
    candidate.requestIds.some(
      (requestId) => !Number.isSafeInteger(requestId) || requestId <= 0
    )
  ) {
    return undefined;
  }
  return {
    startedAt: candidate.startedAt,
    completedAt: candidate.completedAt,
    status: candidate.status as WatchlistRouletteRunStatus,
    requested: Number(candidate.requested),
    skipped: Number(candidate.skipped),
    failed: Number(candidate.failed),
    examined: Number(candidate.examined),
    requestIds: [...candidate.requestIds],
    ...(candidate.failureCode && { failureCode: candidate.failureCode }),
  };
};

export const normalizeWatchlistRouletteSettings = (
  value?: Partial<WatchlistRouletteSettings> | null
): WatchlistRouletteSettings => ({
  requestOwnerUserId:
    Number.isSafeInteger(value?.requestOwnerUserId) &&
    Number(value?.requestOwnerUserId) > 0
      ? Number(value?.requestOwnerUserId)
      : null,
  movieItemsPerRun: normalizeItemsPerRun(
    value?.movieItemsPerRun,
    DEFAULT_WATCHLIST_ROULETTE_SETTINGS.movieItemsPerRun
  ),
  seriesItemsPerRun: normalizeItemsPerRun(
    value?.seriesItemsPerRun,
    DEFAULT_WATCHLIST_ROULETTE_SETTINGS.seriesItemsPerRun
  ),
  ...(normalizeRunSummary(value?.lastMovieRun) && {
    lastMovieRun: normalizeRunSummary(value?.lastMovieRun),
  }),
  ...(normalizeRunSummary(value?.lastSeriesRun) && {
    lastSeriesRun: normalizeRunSummary(value?.lastSeriesRun),
  }),
});
