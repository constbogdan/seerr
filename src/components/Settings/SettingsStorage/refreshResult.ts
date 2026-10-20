import type { StorageInstanceStatus } from '@server/lib/storageSettings';

export type StorageRefreshResult = {
  status: 'success' | 'partial' | 'failure';
  failedServices: string[];
};

const serviceLabel = (instance: StorageInstanceStatus): string =>
  `${instance.provider === 'radarr' ? 'Radarr' : 'Sonarr'} · ${instance.serviceName}`;

export const classifyStorageRefresh = (
  instances: StorageInstanceStatus[]
): StorageRefreshResult => {
  const failedInstances = instances.filter(
    (instance) => !instance.available || !instance.capacityAvailable
  );
  const failedServices = [...new Set(failedInstances.map(serviceLabel))];

  if (instances.length === 0 || failedInstances.length === instances.length) {
    return { status: 'failure', failedServices };
  }
  if (failedServices.length > 0) {
    return { status: 'partial', failedServices };
  }
  return { status: 'success', failedServices };
};
