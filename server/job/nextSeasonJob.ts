import nextSeason from '@server/lib/nextSeason';
import { getSettings } from '@server/lib/settings';
import { validateWatchlistRouletteRequestOwner } from '@server/lib/watchlistRoulette';
import logger from '@server/logger';

interface NextSeasonJobSettings {
  jobs: { 'next-season': { enabled?: boolean } };
  watchlistRoulette: { requestOwnerUserId: number | null };
  save: () => Promise<void>;
}

interface NextSeasonJobControlDependencies {
  settings: () => NextSeasonJobSettings;
  validateEnablement: (requestOwnerUserId: number | null) => Promise<void>;
}

export const createNextSeasonJobControl = (
  dependencies: NextSeasonJobControlDependencies
) => {
  let transition: Promise<void> = Promise.resolve();
  let enablementPending = false;

  const setEnabled = (enabled: boolean): Promise<void> => {
    const operation = transition.then(async () => {
      const settings = dependencies.settings();
      if (enabled) {
        await dependencies.validateEnablement(
          settings.watchlistRoulette.requestOwnerUserId
        );
      }
      const previous = settings.jobs['next-season'].enabled;
      enablementPending = enabled;
      settings.jobs['next-season'].enabled = enabled;
      try {
        await settings.save();
      } catch (error) {
        settings.jobs['next-season'].enabled = previous;
        throw error;
      } finally {
        enablementPending = false;
      }
    });
    transition = operation.catch(() => undefined);
    return operation;
  };

  return {
    enabled: () =>
      !enablementPending &&
      dependencies.settings().jobs['next-season'].enabled === true,
    setEnabled,
  };
};

const nextSeasonJobControl = createNextSeasonJobControl({
  settings: getSettings,
  validateEnablement: async (requestOwnerUserId) => {
    const owner =
      await validateWatchlistRouletteRequestOwner(requestOwnerUserId);
    if (!owner) {
      throw Object.assign(
        new Error(
          'Select and save a current administrator as the Watchlist Roulette request owner before enabling Next Season.'
        ),
        { status: 400 }
      );
    }
  },
});

export const nextSeasonJobEnabled = nextSeasonJobControl.enabled;
export const setNextSeasonJobEnabled = nextSeasonJobControl.setEnabled;

export const createNextSeasonRunner =
  (dependencies: { enabled: () => boolean; run: () => Promise<unknown> }) =>
  async () => {
    if (!dependencies.enabled()) return null;
    logger.info('Starting scheduled job: Next Season', { label: 'Jobs' });
    return dependencies.run();
  };

export const runNextSeason = createNextSeasonRunner({
  enabled: nextSeasonJobEnabled,
  run: () => nextSeason.run(),
});

export const runNextSeasonDryRun = async () => {
  logger.info('Starting dry run: Next Season', { label: 'Jobs' });
  return nextSeason.upcoming();
};

export default nextSeason;
