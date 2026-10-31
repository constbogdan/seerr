import { LibraryMediaType } from '@server/constants/libraryHistory';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import type { Repository } from 'typeorm';

export interface TmdbCollectionMembershipObservation {
  tmdbCollectionId: number | null;
  observedAt: Date;
}

export const parseTmdbCollectionMembership = (
  value: unknown,
  observedAt: Date
): TmdbCollectionMembershipObservation | undefined => {
  if (value === null) {
    return { tmdbCollectionId: null, observedAt };
  }
  if (typeof value !== 'object' || value === undefined) return undefined;
  const id = (value as { id?: unknown }).id;
  if (!Number.isSafeInteger(id) || (id as number) <= 0) return undefined;
  return { tmdbCollectionId: id as number, observedAt };
};

export const persistMovieQueryMetadata = async (
  repository: Repository<CanonicalMedia>,
  input: {
    canonicalMediaId: number;
    titleSnapshot: string;
    year: number | null;
    collectionMembership?: TmdbCollectionMembershipObservation;
  }
): Promise<boolean> => {
  const values: Partial<CanonicalMedia> = {
    titleSnapshot: input.titleSnapshot,
    year: input.year,
  };
  if (input.collectionMembership) {
    values.tmdbCollectionId = input.collectionMembership.tmdbCollectionId;
    values.collectionMembershipHydratedAt =
      input.collectionMembership.observedAt;
  }

  const update = repository
    .createQueryBuilder()
    .update(CanonicalMedia)
    .set(values)
    .where('"id" = :canonicalMediaId', {
      canonicalMediaId: input.canonicalMediaId,
    })
    .andWhere('"mediaType" = :mediaType', {
      mediaType: LibraryMediaType.MOVIE,
    });
  if (input.collectionMembership) {
    update.andWhere(
      '("collectionMembershipHydratedAt" IS NULL OR ' +
        '"collectionMembershipHydratedAt" < :observedAt)',
      { observedAt: input.collectionMembership.observedAt }
    );
  }
  const result = await update.execute();
  return (result.affected ?? 0) > 0;
};

// A collection 404 is not evidence of non-membership. Only a subsequent valid
// Movie observation may change the association, without rewriting other metadata.
export const persistMovieCollectionMembership = async (
  repository: Repository<CanonicalMedia>,
  input: {
    canonicalMediaId: number;
    expectedCollectionId: number;
    collectionMembership: TmdbCollectionMembershipObservation;
  }
): Promise<boolean> => {
  const result = await repository
    .createQueryBuilder()
    .update(CanonicalMedia)
    .set({
      tmdbCollectionId: input.collectionMembership.tmdbCollectionId,
      collectionMembershipHydratedAt: input.collectionMembership.observedAt,
    })
    .where('"id" = :canonicalMediaId', {
      canonicalMediaId: input.canonicalMediaId,
    })
    .andWhere('"mediaType" = :mediaType', {
      mediaType: LibraryMediaType.MOVIE,
    })
    .andWhere('"tmdbCollectionId" = :expectedCollectionId', {
      expectedCollectionId: input.expectedCollectionId,
    })
    .andWhere(
      '("collectionMembershipHydratedAt" IS NULL OR ' +
        '"collectionMembershipHydratedAt" < :observedAt)',
      { observedAt: input.collectionMembership.observedAt }
    )
    .execute();
  return (result.affected ?? 0) > 0;
};
