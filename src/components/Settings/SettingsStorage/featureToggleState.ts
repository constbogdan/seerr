import type { OverflowSettings } from '@server/constants/overflow';
import type { JobId } from '@server/lib/settings';

export interface StorageJobState {
  id: JobId;
  enabled: boolean;
  configurableEnabled: boolean;
}

export const setOverflowRoutingEnabled = (
  settings: OverflowSettings,
  enabled: boolean
): OverflowSettings => ({ ...settings, enabled });

export const setAutomaticSeriesPlacementEnabled = (
  settings: OverflowSettings,
  automaticSeriesPlacement: boolean
): OverflowSettings => ({ ...settings, automaticSeriesPlacement });

export const isOverflowRoutingActivationValid = (
  settings: Pick<OverflowSettings, 'enabled' | 'routes'>
): boolean =>
  !settings.enabled || settings.routes.some((route) => route.enabled);

export const isSeriesRelocationRoutingConfigured = (
  settings: Pick<
    OverflowSettings,
    'defaultSeriesVolumeId' | 'expansionSeriesVolumeId'
  >,
  sonarrVolumeIds: ReadonlySet<string>
): boolean =>
  settings.defaultSeriesVolumeId !== null &&
  settings.expansionSeriesVolumeId !== null &&
  settings.defaultSeriesVolumeId !== settings.expansionSeriesVolumeId &&
  sonarrVolumeIds.has(settings.defaultSeriesVolumeId) &&
  sonarrVolumeIds.has(settings.expansionSeriesVolumeId);

export const replaceStorageJobState = <T extends StorageJobState>(
  jobs: T[] | undefined,
  updatedJob: T
): T[] => {
  if (!jobs) return [updatedJob];
  const exists = jobs.some((job) => job.id === updatedJob.id);
  if (!exists) return [...jobs, updatedJob];
  return jobs.map((job) =>
    job.id === updatedJob.id ? { ...job, ...updatedJob } : job
  );
};

export const seriesRelocationConfigurationChanged = (
  current: OverflowSettings,
  persisted: OverflowSettings
): boolean =>
  current.defaultSeriesVolumeId !== persisted.defaultSeriesVolumeId ||
  current.expansionSeriesVolumeId !== persisted.expansionSeriesVolumeId ||
  current.seriesSeasonThreshold !== persisted.seriesSeasonThreshold ||
  current.torrentRelocationDelayHours !== persisted.torrentRelocationDelayHours;
