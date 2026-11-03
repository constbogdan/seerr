import type {
  PhysicalVolume,
  StorageLocation,
} from '@server/lib/storageSettings';

export const storageRouteLabel = (
  location: StorageLocation,
  volumes: PhysicalVolume[],
  unknownVolumeLabel: string
): string => {
  const volume = volumes.find((candidate) =>
    candidate.locationIds.includes(location.id)
  );
  return `${location.name} (${location.serviceName}) \u2014 ${
    volume?.name ?? unknownVolumeLabel
  }`;
};
