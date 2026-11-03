import { MediaStatus } from '@server/constants/media';
import type { Collection } from '@server/models/Collection';

export interface CollectionAvailability {
  available: number;
  total: number;
}

export const formatCollectionAvailability = (
  availability: CollectionAvailability | undefined
): string | undefined =>
  availability ? `${availability.available}/${availability.total}` : undefined;

export const getCollectionAvailability = (
  collection: Pick<Collection, 'parts'>
): CollectionAvailability | undefined => {
  const availabilityByTmdbId = new Map<number, boolean>();

  for (const part of collection.parts) {
    const isAvailable = part.mediaInfo?.status === MediaStatus.AVAILABLE;
    availabilityByTmdbId.set(
      part.id,
      (availabilityByTmdbId.get(part.id) ?? false) || isAvailable
    );
  }

  if (availabilityByTmdbId.size === 0) {
    return undefined;
  }

  return {
    available: [...availabilityByTmdbId.values()].filter(Boolean).length,
    total: availabilityByTmdbId.size,
  };
};
