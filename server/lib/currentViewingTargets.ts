import { LibraryMediaType } from '@server/constants/libraryHistory';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import {
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { normalizeExactJellyfinId } from '@server/lib/jellyfinViewingSource';
import { normalizeLibraryDatabaseDate } from '@server/lib/libraryActivity';
import { In, type EntityManager } from 'typeorm';

interface RawActiveCurrentViewingState {
  stateId: number | string;
  viewerId: number | string;
  sourceScope: string;
  sourceItemId: string;
  mediaType: 'movie' | 'episode';
  canonicalMediaId: number | string;
  canonicalEpisodeId: number | string | null;
  played: boolean | number | string;
  playCount: number | string;
  lastPlayedAt: Date | string | null;
  playbackPositionTicks: string | number | null;
  runtimeTicks: string | number | null;
  progressBasisPoints: number | string | null;
  observedAt: Date | string;
  userId: number | string | null;
  username: string | null;
  jellyfinUsername: string | null;
  plexUsername: string | null;
  avatar: string | null;
  includeInUserMetrics: boolean | number | string | null;
}

const databaseBoolean = (value: boolean | number | string | null) =>
  value === true || value === 1 || value === '1';

const normalizedJellyfinIdSql = (value: string) =>
  `LOWER(REPLACE(TRIM(${value}), '-', ''))`;

export interface CurrentViewingTarget {
  sourceItemId: string;
  canonicalMediaId: number;
  canonicalEpisodeId: number | null;
  mediaType: 'movie' | 'episode';
}

const targetKey = (
  scope: string,
  target: Pick<
    CurrentViewingTarget,
    'sourceItemId' | 'canonicalMediaId' | 'mediaType'
  > & { canonicalEpisodeId?: number | null }
) =>
  [
    scope,
    target.sourceItemId,
    target.canonicalMediaId,
    target.canonicalEpisodeId ?? '',
    target.mediaType,
  ].join(':');

export const loadCurrentViewingTargets = async (
  scope: string,
  manager: EntityManager = dataSource.manager
): Promise<CurrentViewingTarget[]> => {
  const visiblePresences = await manager.getRepository(LibraryPresence).findBy({
    sourceSystem: 'jellyfin',
    sourceScope: scope,
    isCurrent: true,
    jellyfinVisible: true,
  });
  const movies = visiblePresences.flatMap(
    (presence): CurrentViewingTarget[] => {
      const prefix = `${LibraryMediaType.MOVIE}:`;
      if (!presence.sourceItemId.startsWith(prefix)) return [];
      const sourceItemId = normalizeExactJellyfinId(
        presence.sourceItemId.slice(prefix.length)
      );
      return sourceItemId
        ? [
            {
              sourceItemId,
              canonicalMediaId: presence.canonicalMediaId,
              canonicalEpisodeId: null,
              mediaType: 'movie',
            },
          ]
        : [];
    }
  );

  const availableEpisodeRows = (await manager
    .createQueryBuilder()
    .select('DISTINCT link.canonicalEpisodeId', 'canonicalEpisodeId')
    .from(LibraryFileEpisode, 'link')
    .innerJoin('link.libraryFile', 'file')
    .innerJoin('file.libraryPresence', 'presence')
    .where('file.isCurrent = :current', { current: true })
    .andWhere('presence.isCurrent = :current', { current: true })
    .andWhere('presence.servarrHasFile = :hasFile', { hasFile: true })
    .getRawMany()) as { canonicalEpisodeId: number | string }[];
  const availableEpisodeIds = availableEpisodeRows.map((row) =>
    Number(row.canonicalEpisodeId)
  );
  const episodes =
    availableEpisodeIds.length === 0
      ? []
      : await manager.getRepository(CanonicalEpisode).find({
          where: { id: In(availableEpisodeIds) },
          relations: { season: true },
        });
  const currentSeriesIds = new Set(
    visiblePresences.map((presence) => presence.canonicalMediaId)
  );
  const episodeById = new Map(
    episodes
      .filter((episode) => currentSeriesIds.has(episode.season.seriesId))
      .map((episode) => [episode.id, episode])
  );
  const episodeIdentities =
    episodeById.size === 0
      ? []
      : await manager.getRepository(CanonicalEpisodeIdentity).find({
          where: {
            provider: 'jellyfin',
            sourceScope: scope,
            canonicalEpisodeId: In([...episodeById.keys()]),
          },
          order: { createdAt: 'DESC', id: 'DESC' },
        });
  const currentIdentityByEpisode = new Map<number, CanonicalEpisodeIdentity>();
  for (const identity of episodeIdentities) {
    if (!currentIdentityByEpisode.has(identity.canonicalEpisodeId)) {
      currentIdentityByEpisode.set(identity.canonicalEpisodeId, identity);
    }
  }
  const episodeTargets = [...currentIdentityByEpisode.values()].flatMap(
    (identity): CurrentViewingTarget[] => {
      const sourceItemId = normalizeExactJellyfinId(identity.value);
      const episode = episodeById.get(identity.canonicalEpisodeId);
      return sourceItemId && episode
        ? [
            {
              sourceItemId,
              canonicalMediaId: episode.season.seriesId,
              canonicalEpisodeId: episode.id,
              mediaType: 'episode',
            },
          ]
        : [];
    }
  );

  return [...movies, ...episodeTargets].sort((left, right) =>
    left.sourceItemId.localeCompare(right.sourceItemId)
  );
};

export const loadActiveCurrentViewingStatesForMedia = async (
  canonicalMediaIds: number[]
): Promise<CurrentViewingState[]> => {
  const selectedIds = [
    ...new Set(
      canonicalMediaIds.filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];
  if (selectedIds.length === 0) return [];

  const movieTarget =
    `state."mediaType" = 'movie' AND ` +
    `state."canonicalEpisodeId" IS NULL AND EXISTS (` +
    `SELECT 1 FROM "library_presence" movie_presence WHERE ` +
    `movie_presence."canonicalMediaId" = state."canonicalMediaId" AND ` +
    `movie_presence."sourceSystem" = 'jellyfin' AND ` +
    `movie_presence."sourceScope" = state."sourceScope" AND ` +
    `movie_presence."isCurrent" = :current AND ` +
    `movie_presence."jellyfinVisible" = :current AND ` +
    `SUBSTR(movie_presence."sourceItemId", 1, 6) = 'movie:' AND ` +
    `${normalizedJellyfinIdSql(
      'SUBSTR(movie_presence."sourceItemId", 7)'
    )} = state."sourceItemId"` +
    `)`;
  const episodeTarget =
    `state."mediaType" = 'episode' AND ` +
    `state."canonicalEpisodeId" IS NOT NULL AND EXISTS (` +
    `SELECT 1 FROM "canonical_episode" episode ` +
    `INNER JOIN "canonical_season" season ON ` +
    `season.id = episode."seasonId" ` +
    `INNER JOIN "canonical_episode_identity" episode_identity ON ` +
    `episode_identity."canonicalEpisodeId" = episode.id AND ` +
    `episode_identity.provider = 'jellyfin' AND ` +
    `episode_identity."sourceScope" = state."sourceScope" ` +
    `WHERE episode.id = state."canonicalEpisodeId" AND ` +
    `season."seriesId" = state."canonicalMediaId" AND ` +
    `${normalizedJellyfinIdSql('episode_identity.value')} = ` +
    `state."sourceItemId" AND ` +
    `episode_identity.id = (` +
    `SELECT latest_identity.id FROM "canonical_episode_identity" latest_identity ` +
    `WHERE latest_identity."canonicalEpisodeId" = episode.id AND ` +
    `latest_identity.provider = 'jellyfin' AND ` +
    `latest_identity."sourceScope" = state."sourceScope" ` +
    `ORDER BY latest_identity."createdAt" DESC, latest_identity.id DESC ` +
    `LIMIT 1` +
    `) AND EXISTS (` +
    `SELECT 1 FROM "library_presence" series_presence WHERE ` +
    `series_presence."canonicalMediaId" = state."canonicalMediaId" AND ` +
    `series_presence."sourceSystem" = 'jellyfin' AND ` +
    `series_presence."sourceScope" = state."sourceScope" AND ` +
    `series_presence."isCurrent" = :current AND ` +
    `series_presence."jellyfinVisible" = :current` +
    `) AND EXISTS (` +
    `SELECT 1 FROM "library_file_episode" available_link ` +
    `INNER JOIN "library_file" available_file ON ` +
    `available_file.id = available_link."libraryFileId" ` +
    `INNER JOIN "library_presence" available_presence ON ` +
    `available_presence.id = available_file."libraryPresenceId" ` +
    `WHERE available_link."canonicalEpisodeId" = episode.id AND ` +
    `available_file."isCurrent" = :current AND ` +
    `available_presence."isCurrent" = :current AND ` +
    `available_presence."servarrHasFile" = :current` +
    `)` +
    `)`;

  const rows = await getRepository(CurrentViewingState)
    .createQueryBuilder('state')
    .innerJoin(Viewer, 'state_viewer', 'state_viewer.id = state.viewerId')
    .leftJoin(User, 'state_user', 'state_user.id = state_viewer.userId')
    .select('state.id', 'stateId')
    .addSelect('state.viewerId', 'viewerId')
    .addSelect('state.sourceScope', 'sourceScope')
    .addSelect('state.sourceItemId', 'sourceItemId')
    .addSelect('state.mediaType', 'mediaType')
    .addSelect('state.canonicalMediaId', 'canonicalMediaId')
    .addSelect('state.canonicalEpisodeId', 'canonicalEpisodeId')
    .addSelect('state.played', 'played')
    .addSelect('state.playCount', 'playCount')
    .addSelect('state.lastPlayedAt', 'lastPlayedAt')
    .addSelect('state.playbackPositionTicks', 'playbackPositionTicks')
    .addSelect('state.runtimeTicks', 'runtimeTicks')
    .addSelect('state.progressBasisPoints', 'progressBasisPoints')
    .addSelect('state.observedAt', 'observedAt')
    .addSelect('state_user.id', 'userId')
    .addSelect('state_user.username', 'username')
    .addSelect('state_user.jellyfinUsername', 'jellyfinUsername')
    .addSelect('state_user.plexUsername', 'plexUsername')
    .addSelect('state_user.avatar', 'avatar')
    .addSelect('state_user.includeInUserMetrics', 'includeInUserMetrics')
    .where('state.canonicalMediaId IN (:...canonicalMediaIds)', {
      canonicalMediaIds: selectedIds,
    })
    .andWhere(`((${movieTarget}) OR (${episodeTarget}))`)
    .setParameter('current', true)
    .getRawMany<RawActiveCurrentViewingState>();

  return rows.map((row) => {
    const userId = row.userId === null ? null : Number(row.userId);
    const user = userId
      ? new User({
          id: userId,
          username: row.username ?? undefined,
          jellyfinUsername: row.jellyfinUsername,
          plexUsername: row.plexUsername,
          avatar: row.avatar ?? '',
          includeInUserMetrics: databaseBoolean(row.includeInUserMetrics),
        })
      : null;
    const viewerId = Number(row.viewerId);
    return new CurrentViewingState({
      id: Number(row.stateId),
      viewerId,
      viewer: new Viewer({ id: viewerId, userId, user }),
      sourceScope: row.sourceScope,
      sourceItemId: row.sourceItemId,
      mediaType: row.mediaType,
      canonicalMediaId: Number(row.canonicalMediaId),
      canonicalEpisodeId:
        row.canonicalEpisodeId === null ? null : Number(row.canonicalEpisodeId),
      played: databaseBoolean(row.played),
      playCount: Number(row.playCount),
      lastPlayedAt: normalizeLibraryDatabaseDate(row.lastPlayedAt),
      playbackPositionTicks:
        row.playbackPositionTicks === null
          ? null
          : String(row.playbackPositionTicks),
      runtimeTicks: row.runtimeTicks === null ? null : String(row.runtimeTicks),
      progressBasisPoints:
        row.progressBasisPoints === null
          ? null
          : Number(row.progressBasisPoints),
      observedAt: normalizeLibraryDatabaseDate(row.observedAt) as Date,
    });
  });
};

export const filterActiveCurrentViewingStates = async <
  T extends CurrentViewingState,
>(
  states: T[]
): Promise<T[]> => {
  const targetsByScope = new Map<string, Set<string>>();
  for (const scope of new Set(states.map((state) => state.sourceScope))) {
    targetsByScope.set(
      scope,
      new Set(
        (await loadCurrentViewingTargets(scope)).map((target) =>
          targetKey(scope, target)
        )
      )
    );
  }
  return states.filter((state) =>
    targetsByScope
      .get(state.sourceScope)
      ?.has(targetKey(state.sourceScope, state))
  );
};
