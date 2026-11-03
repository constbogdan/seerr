import seriesRelocation from '@server/lib/seriesRelocation';
import { getSettings } from '@server/lib/settings';
import {
  discoverStorageLocations,
  validateSeriesPlacementVolumes,
} from '@server/lib/storageSettings';
import logger from '@server/logger';

interface SeriesRelocationJobSettings {
  jobs: { 'series-relocation': { enabled?: boolean } };
  save: () => Promise<void>;
}

interface SeriesRelocationJobControlDependencies {
  settings: () => SeriesRelocationJobSettings;
  validateEnablement: () => Promise<void>;
}

export const isSeriesRelocationJobEnabled = (enabled: unknown): boolean =>
  enabled === true;

export const createSeriesRelocationJobControl = (
  dependencies: SeriesRelocationJobControlDependencies
): {
  enabled: () => boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
} => {
  let transition: Promise<void> = Promise.resolve();
  let enablementPending = false;

  const setEnabled = (enabled: boolean): Promise<void> => {
    const operation = transition.then(async () => {
      const settings = dependencies.settings();
      if (enabled) await dependencies.validateEnablement();

      const previous = settings.jobs['series-relocation'].enabled;
      enablementPending = enabled;
      settings.jobs['series-relocation'].enabled = enabled;
      try {
        await settings.save();
      } catch (error) {
        settings.jobs['series-relocation'].enabled = previous;
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
      isSeriesRelocationJobEnabled(
        dependencies.settings().jobs['series-relocation'].enabled
      ),
    setEnabled,
  };
};

const seriesRelocationJobControl = createSeriesRelocationJobControl({
  settings: getSettings,
  validateEnablement: async () => {
    const settings = getSettings();
    const discovery = await discoverStorageLocations(settings);
    const validation = validateSeriesPlacementVolumes(
      settings.overflow,
      discovery,
      true
    );
    if (!validation.valid) {
      throw Object.assign(new Error(validation.message), {
        status: validation.status,
      });
    }
  },
});

export const seriesRelocationJobEnabled = seriesRelocationJobControl.enabled;

export const setSeriesRelocationJobEnabled =
  seriesRelocationJobControl.setEnabled;

interface SeriesRelocationRunnerDependencies {
  enabled: () => boolean;
  relocate: () => Promise<unknown>;
}

export const createSeriesRelocationRunner = (
  dependencies: SeriesRelocationRunnerDependencies
) => {
  return async () => {
    if (!dependencies.enabled()) return null;
    logger.info('Starting scheduled job: Series Relocation', {
      label: 'Jobs',
    });
    return dependencies.relocate();
  };
};

export const runSeriesRelocation = createSeriesRelocationRunner({
  enabled: seriesRelocationJobEnabled,
  relocate: () => seriesRelocation.run(1),
});

export default seriesRelocation;
