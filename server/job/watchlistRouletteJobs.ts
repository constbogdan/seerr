import { MediaType } from '@server/constants/media';
import type { JobId } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  movieWatchlistRoulette,
  seriesWatchlistRoulette,
  validateWatchlistRouletteRequestOwner,
} from '@server/lib/watchlistRoulette';
import logger from '@server/logger';

export const watchlistRouletteJobEnabled = (jobId: JobId): boolean =>
  getSettings().jobs[jobId]?.enabled === true;

const assertRequestOwner = async (): Promise<void> => {
  const owner = await validateWatchlistRouletteRequestOwner(
    getSettings().watchlistRoulette.requestOwnerUserId
  );
  if (!owner) {
    throw Object.assign(
      new Error(
        'Select and save a current administrator as the Watchlist Roulette request owner before enabling this job.'
      ),
      { status: 400 }
    );
  }
};

export const setWatchlistRouletteJobEnabled = async (
  jobId: 'watchlist-roulette-movies' | 'watchlist-roulette-series',
  enabled: boolean
): Promise<void> => {
  if (enabled) await assertRequestOwner();
  const settings = getSettings();
  settings.jobs[jobId].enabled = enabled;
  await settings.save();
};

export const runMovieWatchlistRoulette = async () => {
  if (!watchlistRouletteJobEnabled('watchlist-roulette-movies')) return null;
  logger.info('Starting scheduled job: Watchlist Roulette Movies', {
    label: 'Jobs',
  });
  return movieWatchlistRoulette.run();
};

export const runSeriesWatchlistRoulette = async () => {
  if (!watchlistRouletteJobEnabled('watchlist-roulette-series')) return null;
  logger.info('Starting scheduled job: Watchlist Roulette Series', {
    label: 'Jobs',
  });
  return seriesWatchlistRoulette.run();
};

export const watchlistRouletteJobResult = (mediaType: MediaType) => {
  const settings = getSettings().watchlistRoulette;
  return mediaType === MediaType.MOVIE
    ? (movieWatchlistRoulette.status() ?? settings.lastMovieRun)
    : (seriesWatchlistRoulette.status() ?? settings.lastSeriesRun);
};

export const watchlistRouletteJobRunning = (mediaType: MediaType): boolean =>
  mediaType === MediaType.MOVIE
    ? movieWatchlistRoulette.running()
    : seriesWatchlistRoulette.running();
