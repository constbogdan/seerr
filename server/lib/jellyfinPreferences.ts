import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import { MediaType } from '@server/constants/media';
import { CanonicalMediaIdentity } from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { UserMediaState } from '@server/entity/UserMediaState';
import {
  chunkValues,
  normalizeExactJellyfinId,
} from '@server/lib/jellyfinViewingSource';
import { getSettings } from '@server/lib/settings';
import { In, type EntityManager } from 'typeorm';

export interface JellyfinPreferenceTarget {
  mediaType: MediaType;
  tmdbId: number;
  ids: string[];
  mediaId?: number;
  stateId?: number;
}

export const jellyfinPreferenceScope = (): string =>
  getSettings().jellyfin.serverId || '';

export const preferenceItemIds = (
  ids: (string | null | undefined)[]
): string[] =>
  [
    ...new Set(
      ids.map(normalizeExactJellyfinId).filter((id): id is string => !!id)
    ),
  ].sort();

/** undefined is incomplete/conflicting; null is an observed Neutral rating. */
export const deriveJellyfinPreference = (
  target: JellyfinPreferenceTarget,
  items: Map<string, JellyfinLibraryItemExtended>
): boolean | null | undefined => {
  if (!target.ids.length) return undefined;
  const ratings: (boolean | null)[] = [];
  for (const id of target.ids) {
    const item = items.get(id);
    if (
      !item ||
      normalizeExactJellyfinId(item.Id) !== id ||
      item.Type !==
        (target.mediaType === MediaType.MOVIE ? 'Movie' : 'Series') ||
      String(item.ProviderIds?.Tmdb) !== String(target.tmdbId) ||
      !item.UserData ||
      typeof item.UserData.Played !== 'boolean'
    )
      return undefined;
    const rating = item.UserData.Likes;
    if (rating !== undefined && rating !== null && typeof rating !== 'boolean')
      return undefined;
    // Jellyfin 10.10.7 omits null DTO properties (WhenWritingNull). A complete
    // successful UserData observation without Likes is Neutral, not a missing item.
    ratings.push(rating ?? null);
  }
  return ratings.every((rating) => rating === ratings[0])
    ? ratings[0]
    : undefined;
};

export const logicalJellyfinPreference = (
  state: UserMediaState | undefined | null,
  userId: string | null | undefined,
  sourceScope = jellyfinPreferenceScope(),
  currentItemIds?: string[]
): { liked: boolean | null; disliked: boolean | null } => {
  if (
    !state?.jellyfinPreferenceObservedAt ||
    !normalizeExactJellyfinId(userId) ||
    state.jellyfinPreferenceUserId !== normalizeExactJellyfinId(userId) ||
    state.jellyfinPreferenceSourceScope !== sourceScope ||
    (currentItemIds &&
      state.jellyfinPreferenceItemIds !==
        preferenceItemIds(currentItemIds).join(','))
  ) {
    return { liked: null, disliked: null };
  }
  return {
    liked: state.jellyfinLikes === true,
    disliked: state.jellyfinLikes === false,
  };
};

/** Top-level identities from the existing current Library generation; no scan. */
export const loadLibraryPreferenceTargets = async (
  manager: EntityManager,
  sourceScope: string
): Promise<JellyfinPreferenceTarget[]> => {
  const presences = await manager.getRepository(LibraryPresence).findBy({
    sourceSystem: 'jellyfin',
    sourceScope,
    isCurrent: true,
    jellyfinVisible: true,
  });
  const ids = [
    ...new Set(presences.map((presence) => presence.canonicalMediaId)),
  ];
  if (!ids.length) return [];
  const identities = new Map<number, CanonicalMediaIdentity[]>();
  const presencesById = new Map<number, LibraryPresence[]>();
  for (const presence of presences) {
    const group = presencesById.get(presence.canonicalMediaId) ?? [];
    group.push(presence);
    presencesById.set(presence.canonicalMediaId, group);
  }
  for (const batch of chunkValues(ids, 500)) {
    const rows = await manager.getRepository(CanonicalMediaIdentity).findBy({
      canonicalMediaId: In(batch),
      provider: 'tmdb',
      sourceScope: '',
    });
    for (const row of rows) {
      const group = identities.get(row.canonicalMediaId) ?? [];
      group.push(row);
      identities.set(row.canonicalMediaId, group);
    }
  }
  const targets: JellyfinPreferenceTarget[] = [];
  for (const canonicalId of ids) {
    const identity = identities.get(canonicalId) ?? [];
    if (
      identity.length !== 1 ||
      !/^\d+$/.test(identity[0].value) ||
      !Number.isSafeInteger(Number(identity[0].value)) ||
      Number(identity[0].value) <= 0
    )
      continue;
    const mediaType =
      identity[0].mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV;
    const prefix = mediaType === MediaType.MOVIE ? 'movie:' : 'series:';
    const itemIds = preferenceItemIds(
      (presencesById.get(canonicalId) ?? [])
        .filter(
          (presence) =>
            presence.canonicalMediaId === canonicalId &&
            presence.sourceItemId.startsWith(prefix)
        )
        .map((presence) => presence.sourceItemId.slice(prefix.length))
    );
    if (itemIds.length)
      targets.push({
        mediaType,
        tmdbId: Number(identity[0].value),
        ids: itemIds,
      });
  }
  return targets;
};

/** Preference-only writes. Never writes played, viewing evidence or membership. */
export const persistJellyfinPreference = async ({
  manager,
  target,
  items,
  userId,
  sourceUserId,
  sourceScope,
  observedAt,
}: {
  manager: EntityManager;
  target: JellyfinPreferenceTarget;
  items: Map<string, JellyfinLibraryItemExtended>;
  userId: number;
  sourceUserId: string;
  sourceScope: string;
  observedAt: Date;
}): Promise<boolean> => {
  const rating = deriveJellyfinPreference(target, items);
  if (
    rating === undefined ||
    !sourceScope ||
    sourceScope !== jellyfinPreferenceScope() ||
    !Number.isFinite(observedAt.getTime())
  )
    return false;
  const user = await manager.getRepository(User).findOneBy({ id: userId });
  if (!user || normalizeExactJellyfinId(user.jellyfinUserId) !== sourceUserId)
    return false;
  const mappings = await manager
    .getRepository(User)
    .createQueryBuilder('mapped')
    .where(
      "LOWER(REPLACE(TRIM(mapped.jellyfinUserId), '-', '')) = :sourceUserId",
      {
        sourceUserId,
      }
    )
    .getCount();
  if (mappings !== 1) return false;
  if (target.mediaId) {
    const media = await manager
      .getRepository(Media)
      .findOneBy({ id: target.mediaId });
    if (
      !media ||
      media.tmdbId !== target.tmdbId ||
      media.mediaType !== target.mediaType ||
      JSON.stringify(
        preferenceItemIds([media.jellyfinMediaId, media.jellyfinMediaId4k])
      ) !== JSON.stringify(target.ids)
    )
      return false;
  }
  if (!target.stateId)
    await manager
      .createQueryBuilder()
      .insert()
      .into(UserMediaState)
      .values({
        user,
        mediaType: target.mediaType,
        tmdbId: target.tmdbId,
        jellyfinPlayStateTracked: false,
      })
      .orIgnore()
      .updateEntity(false)
      .execute();
  const result = await manager
    .createQueryBuilder()
    .update(UserMediaState)
    .set({
      jellyfinLikes: rating,
      jellyfinPreferenceObservedAt: observedAt,
      jellyfinPreferenceSourceScope: sourceScope,
      jellyfinPreferenceUserId: sourceUserId,
      jellyfinPreferenceItemIds: target.ids.join(','),
    })
    .where(
      '"userId" = :userId AND "mediaType" = :mediaType AND "tmdbId" = :tmdbId',
      { userId, mediaType: target.mediaType, tmdbId: target.tmdbId }
    )
    .andWhere(
      '("jellyfinPreferenceObservedAt" IS NULL OR "jellyfinPreferenceObservedAt" < :observedAt)',
      { observedAt }
    )
    .andWhere(target.stateId ? '"id" = :stateId' : '1 = 1', {
      stateId: target.stateId,
    })
    .execute();
  return (result.affected ?? 0) > 0;
};
