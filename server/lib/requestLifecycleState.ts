import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type { EntityManager } from 'typeorm';

/** Immutable scope, not a dispatch-attempt identifier (Approved/Failed/Approved is ambiguous). */
export const requestIdentity = (request: MediaRequest) =>
  Object.freeze({
    id: request.id,
    mediaId: request.media.id,
    tmdbId: request.media.tmdbId,
    type: request.type,
    is4k: request.is4k,
    requestedById: request.requestedBy.id,
  });

export type RequestIdentity = ReturnType<typeof requestIdentity>;

/** Scalar, existing-row transition. Never save a captured request/Season graph. */
export const transitionRequestStatus = async (
  manager: EntityManager,
  identity: RequestIdentity,
  from: MediaRequestStatus[],
  to: MediaRequestStatus,
  modifiedById?: number,
  requireCompletedSeasons = false
): Promise<MediaRequest | null> => {
  const query = manager
    .createQueryBuilder()
    .update(MediaRequest)
    .set({
      status: to,
      ...(modifiedById !== undefined && { modifiedBy: { id: modifiedById } }),
    })
    .where('id = :id AND mediaId = :mediaId AND type = :type', identity)
    .andWhere('is4k = :is4k AND requestedById = :requestedById', identity)
    .andWhere('status IN (:...from)', { from })
    .andWhere(
      `EXISTS (${manager
        .createQueryBuilder(Media, 'identity_media')
        .select('1')
        .where('identity_media.id = :mediaId')
        .andWhere('identity_media.tmdbId = :tmdbId')
        .andWhere('identity_media.mediaType = :type')
        .getQuery()})`
    )
    // QueryBuilder emits partial entities; lifecycle effects belong to the winning caller.
    .callListeners(false);
  if (requireCompletedSeasons) {
    query
      .andWhere(
        'EXISTS (SELECT 1 FROM "season_request" "scope" WHERE "scope"."requestId" = :id)'
      )
      .andWhere(
        'NOT EXISTS (SELECT 1 FROM "season_request" "scope" WHERE "scope"."requestId" = :id AND "scope"."status" <> :completed)',
        { completed: MediaRequestStatus.COMPLETED }
      );
  }
  if (
    to === MediaRequestStatus.COMPLETED &&
    identity.type === MediaType.MOVIE
  ) {
    query.andWhere(
      `EXISTS (${manager
        .createQueryBuilder(Media, 'ready_movie')
        .select('1')
        .where('ready_movie.id = :mediaId')
        .andWhere(
          'ready_movie.' +
            (identity.is4k ? 'status4k' : 'status') +
            ' IN (:...movieReady)'
        )
        .getQuery()})`,
      { movieReady: [MediaStatus.AVAILABLE, MediaStatus.DELETED] }
    );
  }
  const result = await query.execute();
  if (result.affected !== 1) return null;
  return manager.getRepository(MediaRequest).findOneBy({ id: identity.id });
};

export const failApprovedRequest = (
  manager: EntityManager,
  identity: RequestIdentity
) =>
  transitionRequestStatus(
    manager,
    identity,
    [MediaRequestStatus.APPROVED],
    MediaRequestStatus.FAILED
  );

/** Provider acceptance bookkeeping must not resave stale availability/Season fields. */
export const linkAcceptedProviderMedia = async (
  manager: EntityManager,
  identity: RequestIdentity,
  serviceId: number,
  externalId: number | undefined,
  slug: string
) => {
  if (!Number.isSafeInteger(externalId) || (externalId ?? 0) <= 0) return;
  const serviceKey = identity.is4k ? 'serviceId4k' : 'serviceId';
  const externalKey = identity.is4k
    ? 'externalServiceId4k'
    : 'externalServiceId';
  const slugKey = identity.is4k
    ? 'externalServiceSlug4k'
    : 'externalServiceSlug';
  await manager
    .createQueryBuilder()
    .update(Media)
    .set({
      [serviceKey]: serviceId,
      [externalKey]: externalId,
      [slugKey]: slug,
    })
    .where('id = :mediaId AND tmdbId = :tmdbId AND mediaType = :type', identity)
    .andWhere(
      '(' + serviceKey + ' IS NULL OR ' + serviceKey + ' = :serviceId)',
      { serviceId }
    )
    .andWhere(
      '(' + externalKey + ' IS NULL OR ' + externalKey + ' = :externalId)',
      { externalId }
    )
    .callListeners(false)
    .execute();
};
