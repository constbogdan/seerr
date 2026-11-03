import { MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import { UserMediaState } from '@server/entity/UserMediaState';
import {
  jellyfinPreferenceScope,
  logicalJellyfinPreference,
  preferenceItemIds,
} from '@server/lib/jellyfinPreferences';
import type { EntityManager } from 'typeorm';

interface Target {
  canonicalMediaId: number;
  tmdbId: number | null;
  mediaType: 'movie' | 'series';
}
export interface LibraryPreferenceCounts {
  likedUserCount: number;
  dislikedUserCount: number;
}
interface PreferenceRow {
  userId: number;
  jellyfinUserId: string;
  mediaType: MediaType;
  tmdbId: number;
  jellyfinLikes: number | boolean | null;
  jellyfinPreferenceObservedAt: Date | null;
  jellyfinPreferenceSourceScope: string | null;
  jellyfinPreferenceUserId: string | null;
  jellyfinPreferenceItemIds: string | null;
}

/** Two read-only page batches. Never hydrates User entities or calls providers. */
export async function loadLibraryPreferenceCounts(
  targets: Target[],
  manager: EntityManager = dataSource.manager,
  sourceScope = jellyfinPreferenceScope()
): Promise<Map<number, LibraryPreferenceCounts>> {
  const valid = targets.filter(
    (target) => Number.isSafeInteger(target.tmdbId) && (target.tmdbId ?? 0) > 0
  );
  if (!sourceScope || !valid.length) return new Map();
  const pairs = [
    ...new Map(
      valid.map((target) => [
        `${target.mediaType}:${target.tmdbId}`,
        {
          tmdbId: target.tmdbId!,
          mediaType:
            target.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
        },
      ])
    ).values(),
  ];
  const [preferences, presences] = await Promise.all([
    manager
      .getRepository(UserMediaState)
      .createQueryBuilder('preference')
      .innerJoin('preference.user', 'person')
      .select(
        [
          'mediaType',
          'tmdbId',
          'jellyfinLikes',
          'jellyfinPreferenceObservedAt',
          'jellyfinPreferenceSourceScope',
          'jellyfinPreferenceUserId',
          'jellyfinPreferenceItemIds',
        ].map((column) => `preference."${column}" AS "${column}"`)
      )
      .addSelect('person.id', 'userId')
      .addSelect('person.jellyfinUserId', 'jellyfinUserId')
      .where(
        `(${pairs
          .map(
            (_, i) =>
              `(preference.tmdbId = :tmdb${i} AND preference.mediaType = :type${i})`
          )
          .join(' OR ')})`,
        Object.fromEntries(
          pairs.flatMap((pair, i) => [
            [`tmdb${i}`, pair.tmdbId],
            [`type${i}`, pair.mediaType],
          ])
        )
      )
      .andWhere('preference.jellyfinPreferenceSourceScope = :sourceScope', {
        sourceScope,
      })
      .andWhere('preference.jellyfinPreferenceObservedAt IS NOT NULL')
      .andWhere('person.includeInUserMetrics = :included', { included: true })
      .andWhere(
        `NOT EXISTS (SELECT 1 FROM "user" duplicate_user WHERE duplicate_user.id <> person.id AND LOWER(REPLACE(TRIM(duplicate_user."jellyfinUserId"), '-', '')) = LOWER(REPLACE(TRIM(person."jellyfinUserId"), '-', '')))`
      )
      .getRawMany<PreferenceRow>(),
    manager
      .getRepository(LibraryPresence)
      .createQueryBuilder('presence')
      .select('presence.canonicalMediaId', 'canonicalMediaId')
      .addSelect('presence.sourceItemId', 'sourceItemId')
      .where('presence.canonicalMediaId IN (:...ids)', {
        ids: valid.map((target) => target.canonicalMediaId),
      })
      .andWhere('presence.sourceSystem = :system', { system: 'jellyfin' })
      .andWhere('presence.sourceScope = :sourceScope', { sourceScope })
      .andWhere('presence.isCurrent = :current', { current: true })
      .andWhere('presence.jellyfinVisible = :visible', { visible: true })
      .getRawMany<{ canonicalMediaId: number; sourceItemId: string }>(),
  ]);
  const result = new Map<number, LibraryPreferenceCounts>();
  for (const target of valid) {
    const type = target.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV;
    const current = presences.filter(
      (presence) =>
        Number(presence.canonicalMediaId) === target.canonicalMediaId
    );
    const currentIds = preferenceItemIds(
      current
        .filter((presence) =>
          presence.sourceItemId.startsWith(`${target.mediaType}:`)
        )
        .map((presence) =>
          presence.sourceItemId.slice(target.mediaType.length + 1)
        )
    );
    const liked = new Set<number>();
    const disliked = new Set<number>();
    for (const row of preferences) {
      if (row.mediaType !== type || Number(row.tmdbId) !== target.tmdbId)
        continue;
      // An observation without a valid stored item binding is not a vote.
      const storedIds = preferenceItemIds(
        row.jellyfinPreferenceItemIds?.split(',') ?? []
      );
      if (
        !storedIds.length ||
        storedIds.join(',') !== row.jellyfinPreferenceItemIds
      )
        continue;
      const logical = logicalJellyfinPreference(
        new UserMediaState({
          ...row,
          jellyfinLikes:
            row.jellyfinLikes === true || row.jellyfinLikes === 1
              ? true
              : row.jellyfinLikes === false || row.jellyfinLikes === 0
                ? false
                : null,
        }),
        row.jellyfinUserId,
        sourceScope,
        current.length ? currentIds : undefined
      );
      if (logical.liked) liked.add(Number(row.userId));
      else if (logical.disliked) disliked.add(Number(row.userId));
    }
    result.set(target.canonicalMediaId, {
      likedUserCount: liked.size,
      dislikedUserCount: disliked.size,
    });
  }
  return result;
}
