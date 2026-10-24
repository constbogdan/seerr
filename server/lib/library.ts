import {
  LibraryMediaType,
  LibraryRemovalSource,
  SourceCheckpointStatus,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { RemovalScheduleStatus } from '@server/constants/removal';
import { MediaServerType } from '@server/constants/server';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
  CanonicalSeasonIdentity,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import FreshMedia from '@server/entity/FreshMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import { SourceCheckpoint } from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { Watchlist } from '@server/entity/Watchlist';
import type {
  LibraryActivityFilter,
  LibraryAnimationFilter,
  LibraryCollectionMembershipFilter,
  LibraryExternalLink,
  LibraryFilterUser,
  LibraryFilterUsersResponse,
  LibraryItem,
  LibraryMediaTypeFilter,
  LibraryPresentationBatchStatus,
  LibraryRequestFact,
  LibraryRequestedFilter,
  LibraryRequester,
  LibraryResultsResponse,
  LibraryScheduledFilter,
  LibraryScope,
  LibrarySeasonSummary,
  LibrarySeasonWatchedUser,
  LibrarySeriesDetailResponse,
  LibrarySort,
  LibrarySortDirection,
  LibrarySourceStatus,
  LibraryUser,
  LibraryWatchedFilter,
  LibraryWatchedUser,
  LibraryWatchlistFilter,
} from '@server/interfaces/api/libraryInterfaces';
import {
  filterActiveCurrentViewingStates,
  loadActiveCurrentViewingStatesForMedia,
} from '@server/lib/currentViewingTargets';
import { historicalImportStatus } from '@server/lib/historicalDataInspection';
import {
  normalizeExactJellyfinId,
  normalizeJellyfinActivityDate,
} from '@server/lib/jellyfinViewingSource';
import {
  currentLibraryAddedSql,
  currentLibraryLastActiveSql,
  currentLibraryPresenceSql,
  everPhysicalLibraryMembershipSql,
  isQualifyingLibraryEvidence,
  normalizeLibraryDatabaseDate,
  physicalLibraryPresenceSql,
} from '@server/lib/libraryActivity';
import libraryPresentation, {
  fetchLibraryPresentation,
  type LibraryPresentation,
  type LibraryPresentationCoordinator,
} from '@server/lib/libraryPresentation';
import { getSettings } from '@server/lib/settings';
import { storageRootDisplayLabel } from '@server/lib/storageRootDisplayNames';
import { getHostname } from '@server/utils/getHostname';
import { In, type SelectQueryBuilder } from 'typeorm';

export interface LibraryQuery {
  take: number;
  skip: number;
  scope?: LibraryScope;
  search?: string;
  mediaType?: LibraryMediaTypeFilter;
  collectionMembership?: LibraryCollectionMembershipFilter;
  animation?: LibraryAnimationFilter;
  storageRootId?: number;
  storageRootIds?: number[];
  watchlist: LibraryWatchlistFilter;
  watched: LibraryWatchedFilter;
  requested?: LibraryRequestedFilter;
  userId?: number;
  userIds?: number[];
  addedFrom?: string;
  addedTo?: string;
  activity?: LibraryActivityFilter;
  activityFrom?: string;
  activityTo?: string;
  sort: LibrarySort;
  sortDirection: LibrarySortDirection;
  locale?: string;
  scheduled?: LibraryScheduledFilter;
  removalDueFrom?: string;
  removalDueTo?: string;
  removedFrom?: string;
  removedTo?: string;
  removalSources?: LibraryRemovalSource[];
}

export type { LibraryPresentation } from '@server/lib/libraryPresentation';

export interface LibraryDependencies {
  fetchPresentation(
    mediaType: LibraryMediaType,
    tmdbId: number,
    locale: string
  ): Promise<LibraryPresentation>;
  presentationCoordinator?: Pick<LibraryPresentationCoordinator, 'prepare'>;
}

const defaultDependencies: LibraryDependencies = {
  fetchPresentation: fetchLibraryPresentation,
  presentationCoordinator: libraryPresentation,
};

export const isLibrarySeasonVisible = (
  season: Pick<LibrarySeasonSummary, 'seasonNumber' | 'isSpecial' | 'state'>,
  tmdbSeasons: LibraryPresentation['seasons'],
  today: string
): boolean => {
  if (season.isSpecial || season.seasonNumber <= 0) return false;
  if (season.state === 'current' || season.state === 'archive') return true;
  const airDate = tmdbSeasons?.find(
    (candidate) => candidate.seasonNumber === season.seasonNumber
  )?.airDate;
  return Boolean(
    airDate && /^\d{4}-\d{2}-\d{2}$/.test(airDate) && airDate <= today
  );
};

export const activeLibraryRequestSeasonNumbers = (
  requesters: readonly LibraryRequester[]
): Set<number> =>
  new Set(
    requesters.flatMap((requester) =>
      requester.requests.flatMap((request) =>
        !request.is4k &&
        (request.status === MediaRequestStatus.PENDING ||
          request.status === MediaRequestStatus.APPROVED)
          ? request.seasons
              .filter(
                (season) =>
                  season.status === MediaRequestStatus.PENDING ||
                  season.status === MediaRequestStatus.APPROVED
              )
              .map((season) => season.seasonNumber)
          : []
      )
    )
  );

const mapBounded = async <T>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<void>
): Promise<void> => {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        await mapper(values[index]);
      }
    })
  );
};

interface RawLibraryRow {
  canonicalMediaId: string | number;
  tmdbId: string | number | null;
  mediaType: LibraryMediaType;
  title: string | null;
  year: string | number | null;
  addedAt: string | Date | null;
  removedAt: string | Date | null;
  removalSource: LibraryRemovalSource | null;
  logicalSizeBytes: string | number | null;
  lastActiveAt: string | Date | null;
  watchedUserCount: string | number;
  libraryStatus: Exclude<LibraryScope, 'all'>;
}

interface PageEnrichments {
  storageRoots: Map<
    number,
    { id: number; label: string; color: string | null }[]
  >;
  freshKeys: Set<string>;
  seasonSummaries: Map<number, LibrarySeasonSummary[]>;
  requestMediaCanonicalIds: Set<number>;
  unavailableRequestSeasonKeys: Set<string>;
  resolutions: Map<number, number | null>;
  externalLinks: Map<number, LibraryExternalLink[]>;
}

interface LibraryFileSummaries {
  media: Map<number, number | null>;
  seasons: Map<string, number | null>;
  seasonSizes: Map<string, string | null>;
}

export interface AvailableEpisodeRow {
  canonicalMediaId: number;
  canonicalEpisodeId: number;
  seasonNumber: number;
  episodeNumber: number;
  isSpecial: boolean;
}

export interface PageFacts {
  states: CurrentViewingState[];
  evidence: ViewingEvidence[];
  episodes: AvailableEpisodeRow[];
  watchlists: Watchlist[];
  requesters: Map<number, LibraryRequester[]>;
}

interface SeasonRemovalFact {
  removedAt: string | null;
  removalSource: LibraryRemovalSource | null;
}

interface MutableViewerFact {
  key: string;
  userId: number | null;
  displayName: string;
  avatar: string | null;
  completedMovie: boolean;
  completedEpisodeIds: Set<number>;
  watchedAt: Date | null;
  lastActiveAt: Date | null;
}

interface RawLibraryViewingEvidence {
  id: number | string;
  sourceClass: string;
  viewerId: number | string | null;
  canonicalMediaId: number | string | null;
  canonicalEpisodeId: number | string | null;
  observedAt: Date | string | null;
  observedEndAt: Date | string | null;
  playbackDurationSeconds: number | string | null;
  progressBasisPoints: number | string | null;
  completionClassification: number | string;
  userId: number | string | null;
  username: string | null;
  jellyfinUsername: string | null;
  plexUsername: string | null;
  avatar: string | null;
  includeInUserMetrics: boolean | number | string | null;
}

interface RawLibraryRequester {
  canonicalMediaId: number | string;
  requestId: number | string;
  requestType: MediaType;
  requestStatus: number | string;
  requestIs4k: boolean | number | string;
  requestIsAuto: boolean | number | string;
  requestCreatedAt: Date | string;
  requestUpdatedAt: Date | string;
  userId: number | string;
  username: string | null;
  jellyfinUsername: string | null;
  plexUsername: string | null;
  avatar: string | null;
  seasonId: number | string | null;
  seasonNumber: number | string | null;
  seasonStatus: number | string | null;
  seasonCreatedAt: Date | string | null;
  seasonUpdatedAt: Date | string | null;
}

const currentPresenceSql = currentLibraryPresenceSql;

const historicalStoragePresenceSql = (alias: string) =>
  `(${physicalLibraryPresenceSql(alias)} OR EXISTS (` +
  `SELECT 1 FROM "library_file" historical_storage_file WHERE ` +
  `historical_storage_file."libraryPresenceId" = ${alias}.id))`;

const storagePresenceForScopeSql = (
  alias: string,
  scope: LibraryScope,
  currentMembership: string
): string =>
  scope === 'current'
    ? currentPresenceSql(alias)
    : scope === 'archive'
      ? historicalStoragePresenceSql(alias)
      : `((${currentMembership} AND ${currentPresenceSql(
          alias
        )}) OR (NOT (${currentMembership}) AND ${historicalStoragePresenceSql(
          alias
        )}))`;

const currentMembershipSql = () =>
  `EXISTS (SELECT 1 FROM "library_presence" library_current_population WHERE ` +
  `library_current_population."canonicalMediaId" = canonical.id AND ${currentPresenceSql(
    'library_current_population'
  )})`;

const historicalMembershipSql = () =>
  everPhysicalLibraryMembershipSql('canonical.id');

const libraryStatusSql = (currentMembership = currentMembershipSql()) =>
  `CASE WHEN ${currentMembership} THEN 'current' ELSE 'archive' END`;

const populationSql = (
  scope: LibraryScope,
  currentMembership = currentMembershipSql(),
  historicalMembership = historicalMembershipSql()
) => {
  if (scope === 'current') return currentMembership;
  if (scope === 'archive')
    return `(${historicalMembership} AND NOT (${currentMembership}))`;
  return `(${currentMembership} OR ${historicalMembership})`;
};

const tmdbIdSql = (alias: string) =>
  `COALESCE((SELECT CAST(identity."value" AS INTEGER) FROM ` +
  `"canonical_media_identity" identity WHERE ` +
  `identity."canonicalMediaId" = ${alias}.id AND identity."provider" = 'tmdb' ` +
  `AND identity."sourceScope" = '' LIMIT 1), (SELECT media."tmdbId" FROM ` +
  `"media" media WHERE media.id = ${alias}."currentMediaId"))`;

const currentAvailableEpisodeScopeSql = (activityAlias: string) =>
  `(canonical."mediaType" = 'movie' OR EXISTS (` +
  `SELECT 1 FROM "library_file_episode" activity_link ` +
  `INNER JOIN "library_file" activity_file ON activity_file.id = activity_link."libraryFileId" ` +
  `INNER JOIN "library_presence" activity_presence ON activity_presence.id = activity_file."libraryPresenceId" ` +
  `WHERE activity_link."canonicalEpisodeId" = ${activityAlias}."canonicalEpisodeId" ` +
  `AND activity_presence."canonicalMediaId" = canonical.id ` +
  `AND activity_file."isCurrent" = :current ` +
  `AND activity_presence."isCurrent" = :current ` +
  `AND activity_presence."sourceSystem" IN ('radarr', 'sonarr') ` +
  `AND activity_presence."servarrHasFile" = :current))`;

const historicalAvailableEpisodeScopeSql = (activityAlias: string) =>
  `(canonical."mediaType" = 'movie' OR EXISTS (` +
  `SELECT 1 FROM "library_file_episode" historical_activity_link ` +
  `INNER JOIN "library_file" historical_activity_file ON historical_activity_file.id = historical_activity_link."libraryFileId" ` +
  `INNER JOIN "library_presence" historical_activity_presence ON historical_activity_presence.id = historical_activity_file."libraryPresenceId" ` +
  `WHERE historical_activity_link."canonicalEpisodeId" = ${activityAlias}."canonicalEpisodeId" ` +
  `AND historical_activity_presence."canonicalMediaId" = canonical.id ` +
  `AND historical_activity_presence."sourceSystem" IN ('radarr', 'sonarr')))`;

const qualifyingEvidenceSql = (alias: string) =>
  `(${alias}."completionClassification" IN (` +
  `${ViewingCompletionClassification.CONFIRMED}, ` +
  `${ViewingCompletionClassification.LIKELY}, ` +
  `${ViewingCompletionClassification.PARTIAL}) OR (` +
  `${alias}."completionClassification" = ${ViewingCompletionClassification.UNKNOWN} AND (` +
  `COALESCE(${alias}."progressBasisPoints", 0) > 0 OR ` +
  `COALESCE(${alias}."playbackDurationSeconds", 0) > 0 OR ` +
  `${alias}."sourceClass" = 'historical-manual-activity')))`;

const nonSentinelActivitySql = (expression: string) =>
  `(${expression} IS NOT NULL AND ${expression} NOT IN (` +
  `'1970-01-01 00:00:00', '1970-01-01 00:00:00.000', ` +
  `'1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z'))`;

const activeCurrentStateSql = (alias: string) =>
  `((` +
  `${alias}."mediaType" = 'movie' AND EXISTS (SELECT 1 FROM "library_presence" active_movie WHERE ` +
  `active_movie."canonicalMediaId" = ${alias}."canonicalMediaId" AND active_movie."sourceSystem" = 'jellyfin' ` +
  `AND active_movie."sourceScope" = ${alias}."sourceScope" AND active_movie."sourceItemId" = 'movie:' || ${alias}."sourceItemId" ` +
  `AND active_movie."isCurrent" = :current AND active_movie."jellyfinVisible" = :current)) OR (` +
  `${alias}."mediaType" = 'episode' AND EXISTS (SELECT 1 FROM "canonical_episode_identity" active_episode WHERE ` +
  `active_episode."canonicalEpisodeId" = ${alias}."canonicalEpisodeId" AND active_episode."provider" = 'jellyfin' ` +
  `AND active_episode."sourceScope" = ${alias}."sourceScope" AND active_episode."value" = ${alias}."sourceItemId") ` +
  `AND EXISTS (SELECT 1 FROM "library_presence" active_series WHERE active_series."canonicalMediaId" = ${alias}."canonicalMediaId" ` +
  `AND active_series."sourceSystem" = 'jellyfin' AND active_series."sourceScope" = ${alias}."sourceScope" ` +
  `AND active_series."isCurrent" = :current AND active_series."jellyfinVisible" = :current)))`;

const regularEpisodeSql = (activityAlias: string) =>
  `(canonical."mediaType" = 'movie' OR EXISTS (` +
  `SELECT 1 FROM "canonical_episode" regular_episode ` +
  `INNER JOIN "canonical_season" regular_season ON regular_season.id = regular_episode."seasonId" ` +
  `WHERE regular_episode.id = ${activityAlias}."canonicalEpisodeId" ` +
  `AND regular_episode."isSpecial" = :notCurrent AND regular_season."seasonNumber" > 0))`;

const selectedUserIds = (input: LibraryQuery): number[] => [
  ...new Set([
    ...(input.userIds ?? []),
    ...(input.userId ? [input.userId] : []),
  ]),
];

const currentWatchedExistsSql = (
  userIds: number[] = [],
  userIdExpression?: string
) => {
  const currentUser = userIdExpression
    ? ` AND EXISTS (SELECT 1 FROM "viewer" completed_viewer WHERE completed_viewer.id = completed_state."viewerId" AND completed_viewer."userId" = ${userIdExpression})`
    : userIds.length
      ? ` AND EXISTS (SELECT 1 FROM "viewer" completed_viewer WHERE completed_viewer.id = completed_state."viewerId" AND completed_viewer."userId" IN (:...userIds))`
      : '';
  return (
    `EXISTS (SELECT 1 FROM "current_viewing_state" completed_state WHERE ` +
    `completed_state."canonicalMediaId" = canonical.id AND completed_state."played" = :current ` +
    `AND ${activeCurrentStateSql('completed_state')} ` +
    `AND ${regularEpisodeSql('completed_state')} ` +
    `AND ${currentAvailableEpisodeScopeSql('completed_state')}${currentUser})`
  );
};

const historicalWatchedExistsSql = (
  userIds: number[] = [],
  userIdExpression?: string
) => {
  const historicalUser = userIdExpression
    ? ` AND EXISTS (SELECT 1 FROM "viewer" historical_completed_viewer WHERE historical_completed_viewer.id = historical_completed."viewerId" AND historical_completed_viewer."userId" = ${userIdExpression})`
    : userIds.length
      ? ` AND EXISTS (SELECT 1 FROM "viewer" historical_completed_viewer WHERE historical_completed_viewer.id = historical_completed."viewerId" AND historical_completed_viewer."userId" IN (:...userIds))`
      : '';
  return (
    `EXISTS (SELECT 1 FROM "viewing_evidence" historical_completed WHERE ` +
    `historical_completed."canonicalMediaId" = canonical.id AND ` +
    `historical_completed."viewerId" IS NOT NULL AND ` +
    `historical_completed."completionClassification" = ${ViewingCompletionClassification.CONFIRMED} ` +
    `AND ${regularEpisodeSql('historical_completed')} ` +
    `AND ${historicalAvailableEpisodeScopeSql(
      'historical_completed'
    )}${historicalUser})`
  );
};

const watchedExistsSql = (
  scope: LibraryScope,
  userIds: number[] = [],
  userIdExpression?: string,
  currentMembership = currentMembershipSql()
) => {
  const currentWatched = currentWatchedExistsSql(userIds, userIdExpression);
  const historicalWatched = historicalWatchedExistsSql(
    userIds,
    userIdExpression
  );
  if (scope === 'current') return currentWatched;
  if (scope === 'archive') return historicalWatched;
  return (
    `((${currentMembership} AND ${currentWatched}) OR (` +
    `NOT (${currentMembership}) AND ${historicalWatched}))`
  );
};

const watchlistExistsSql = (
  userIds: number[] = [],
  userIdExpression?: string,
  identity = tmdbIdSql('canonical')
) => {
  const user = userIdExpression
    ? ` AND library_watchlist."requestedById" = ${userIdExpression}`
    : userIds.length
      ? ` AND library_watchlist."requestedById" IN (:...userIds)`
      : '';
  return (
    `EXISTS (SELECT 1 FROM "watchlist" library_watchlist WHERE ` +
    `library_watchlist."tmdbId" = ${identity} AND ` +
    `library_watchlist."mediaType" = CASE WHEN canonical."mediaType" = 'series' THEN 'tv' ELSE 'movie' END${user})`
  );
};

const requestedExistsSql = (
  userIds: number[] = [],
  userIdExpression?: string,
  identity = tmdbIdSql('canonical')
) => {
  const user = userIdExpression
    ? ` AND library_request."requestedById" = ${userIdExpression}`
    : userIds.length
      ? ` AND library_request."requestedById" IN (:...userIds)`
      : '';
  return (
    `EXISTS (SELECT 1 FROM "media_request" library_request ` +
    `INNER JOIN "media" requested_media ON requested_media.id = library_request."mediaId" WHERE (` +
    `requested_media.id = canonical."currentMediaId" OR (` +
    `requested_media."tmdbId" = ${identity} AND ` +
    `requested_media."mediaType" = CASE WHEN canonical."mediaType" = 'series' THEN 'tv' ELSE 'movie' END))${user})`
  );
};

const applyPeopleFilters = (
  query: SelectQueryBuilder<CanonicalMedia>,
  input: Pick<LibraryQuery, 'watchlist' | 'watched' | 'requested'>,
  scope: LibraryScope,
  userIds: number[] = [],
  userIdExpression?: string,
  sql: Pick<LibraryQuerySql, 'currentMembership' | 'tmdbId'> = {
    currentMembership: currentMembershipSql(),
    tmdbId: tmdbIdSql('canonical'),
  }
) => {
  const parameters =
    userIds.length && !userIdExpression ? { userIds } : undefined;
  if (input.watchlist === 'yes')
    query.andWhere(
      watchlistExistsSql(userIds, userIdExpression, sql.tmdbId),
      parameters
    );
  if (input.watchlist === 'no')
    query.andWhere(
      `NOT (${watchlistExistsSql(userIds, userIdExpression, sql.tmdbId)})`,
      parameters
    );
  if (input.watched === 'yes')
    query.andWhere(
      watchedExistsSql(scope, userIds, userIdExpression, sql.currentMembership),
      parameters
    );
  if (input.watched === 'no')
    query.andWhere(
      `NOT (${watchedExistsSql(
        scope,
        userIds,
        userIdExpression,
        sql.currentMembership
      )})`,
      parameters
    );
  if (input.requested === 'yes')
    query.andWhere(
      requestedExistsSql(userIds, userIdExpression, sql.tmdbId),
      parameters
    );
  if (input.requested === 'no')
    query.andWhere(
      `NOT (${requestedExistsSql(userIds, userIdExpression, sql.tmdbId)})`,
      parameters
    );
  return query;
};

const currentAddedSql = currentLibraryAddedSql();

const historicalAddedFallbackSql =
  `COALESCE(` +
  `(SELECT MIN(historical_file."importedAt") FROM "library_file" historical_file ` +
  `INNER JOIN "library_presence" historical_file_presence ON historical_file_presence.id = historical_file."libraryPresenceId" ` +
  `WHERE historical_file_presence."canonicalMediaId" = canonical.id AND historical_file."importedAt" IS NOT NULL), ` +
  `(SELECT MIN(historical_presence."addedAt") FROM "library_presence" historical_presence WHERE ` +
  `historical_presence."canonicalMediaId" = canonical.id AND ${physicalLibraryPresenceSql(
    'historical_presence'
  )} AND historical_presence."addedAt" IS NOT NULL))`;

const latestFileClosureSql = (presenceAlias: string, fileAlias: string) =>
  `(SELECT MAX(${fileAlias}."removedAt") FROM "library_file" ${fileAlias} ` +
  `WHERE ${fileAlias}."libraryPresenceId" = ${presenceAlias}.id AND ` +
  `${fileAlias}."removedAt" IS NOT NULL)`;

const terminalPhysicalClosureSql = (
  presenceAlias: string,
  fileAlias: string
) => {
  const fileClosure = latestFileClosureSql(presenceAlias, fileAlias);
  return (
    `(CASE WHEN ${presenceAlias}."removedAt" IS NULL THEN ${fileClosure} ` +
    `WHEN ${fileClosure} IS NULL THEN ${presenceAlias}."removedAt" ` +
    `WHEN ${presenceAlias}."removedAt" >= ${fileClosure} THEN ${presenceAlias}."removedAt" ` +
    `ELSE ${fileClosure} END)`
  );
};

const physicalWinnerSql = (
  value: (presenceAlias: string, closureSql: string) => string
) => {
  const presence = 'historical_physical_presence';
  const closure = terminalPhysicalClosureSql(
    presence,
    'historical_physical_closure_file'
  );
  return (
    `(SELECT ${value(presence, closure)} FROM "library_presence" ${presence} ` +
    `WHERE ${presence}."canonicalMediaId" = canonical.id AND ` +
    `${presence}."sourceSystem" IN ('radarr', 'sonarr') AND ${closure} IS NOT NULL ` +
    `ORDER BY ${closure} DESC, ${presence}.id DESC LIMIT 1)`
  );
};

const physicalRemovedSql = physicalWinnerSql((_presence, closure) => closure);
const physicalAddedSql = physicalWinnerSql(
  (presence) =>
    `COALESCE(${presence}."addedAt", ` +
    `(SELECT MIN(historical_physical_added_file."importedAt") FROM "library_file" historical_physical_added_file ` +
    `WHERE historical_physical_added_file."libraryPresenceId" = ${presence}.id AND ` +
    `historical_physical_added_file."importedAt" IS NOT NULL))`
);
const physicalRemovalSourceSql = physicalWinnerSql((presence) => {
  const fileClosure = latestFileClosureSql(
    presence,
    'historical_physical_source_closure_file'
  );
  const fileSource =
    `(SELECT COALESCE(historical_physical_source_file."removalSource", 'unknown') ` +
    `FROM "library_file" historical_physical_source_file WHERE ` +
    `historical_physical_source_file."libraryPresenceId" = ${presence}.id AND ` +
    `historical_physical_source_file."removedAt" IS NOT NULL ORDER BY ` +
    `historical_physical_source_file."removedAt" DESC, historical_physical_source_file.id DESC LIMIT 1)`;
  return (
    `(CASE WHEN ${presence}."removedAt" IS NOT NULL AND (` +
    `${fileClosure} IS NULL OR ${presence}."removedAt" >= ${fileClosure}) ` +
    `THEN COALESCE(${presence}."removalSource", 'unknown') ELSE ${fileSource} END)`
  );
});

const jellyfinWinnerSql = (column: 'addedAt' | 'removedAt') =>
  `(SELECT historical_jellyfin_presence."${column}" FROM "library_presence" historical_jellyfin_presence ` +
  `WHERE historical_jellyfin_presence."canonicalMediaId" = canonical.id AND ` +
  `historical_jellyfin_presence."sourceSystem" = 'jellyfin' AND ` +
  `historical_jellyfin_presence."removedAt" IS NOT NULL ORDER BY ` +
  `historical_jellyfin_presence."removedAt" DESC, historical_jellyfin_presence.id DESC LIMIT 1)`;

const jellyfinRemovalSourceSql =
  `(SELECT COALESCE(historical_jellyfin_presence."removalSource", 'unknown') ` +
  `FROM "library_presence" historical_jellyfin_presence WHERE ` +
  `historical_jellyfin_presence."canonicalMediaId" = canonical.id AND ` +
  `historical_jellyfin_presence."sourceSystem" = 'jellyfin' AND ` +
  `historical_jellyfin_presence."removedAt" IS NOT NULL ORDER BY ` +
  `historical_jellyfin_presence."removedAt" DESC, historical_jellyfin_presence.id DESC LIMIT 1)`;

const historicalRemovedSql = `COALESCE(${physicalRemovedSql}, ${jellyfinWinnerSql(
  'removedAt'
)})`;
const historicalRemovalSourceSql = `CASE WHEN ${physicalRemovedSql} IS NOT NULL THEN ${physicalRemovalSourceSql} ELSE ${jellyfinRemovalSourceSql} END`;
const historicalAddedSql = `COALESCE(${physicalAddedSql}, ${jellyfinWinnerSql(
  'addedAt'
)}, ${historicalAddedFallbackSql})`;

const addedSql = `CASE WHEN ${currentMembershipSql()} THEN ${currentAddedSql} ELSE ${historicalAddedSql} END`;
const removedSql = `CASE WHEN ${currentMembershipSql()} THEN NULL ELSE ${historicalRemovedSql} END`;
const removalSourceSql = `CASE WHEN ${currentMembershipSql()} THEN NULL ELSE ${historicalRemovalSourceSql} END`;

const currentSizeSql =
  `COALESCE((SELECT SUM(CAST(library_size_file."sizeBytes" AS BIGINT)) FROM "library_file" library_size_file ` +
  `INNER JOIN "library_presence" library_size_presence ON library_size_presence.id = library_size_file."libraryPresenceId" ` +
  `WHERE library_size_presence."canonicalMediaId" = canonical.id AND library_size_file."isCurrent" = :current ` +
  `AND library_size_presence."isCurrent" = :current AND library_size_presence."sourceSystem" IN ('radarr', 'sonarr') ` +
  `AND library_size_presence."servarrHasFile" = :current), ` +
  `(SELECT MAX(CAST(library_size_presence."logicalSizeBytes" AS BIGINT)) FROM "library_presence" library_size_presence ` +
  `WHERE library_size_presence."canonicalMediaId" = canonical.id AND library_size_presence."isCurrent" = :current ` +
  `AND library_size_presence."sourceSystem" IN ('radarr', 'sonarr') AND library_size_presence."servarrHasFile" = :current))`;

const sizeSql = `CASE WHEN ${currentMembershipSql()} THEN ${currentSizeSql} ELSE NULL END`;

const currentLastActiveSql = currentLibraryLastActiveSql();

const historicalLastActiveSql =
  `(SELECT MAX(COALESCE(historical_activity."observedEndAt", historical_activity."observedAt")) ` +
  `FROM "viewing_evidence" historical_activity WHERE ` +
  `historical_activity."canonicalMediaId" = canonical.id AND ` +
  `${qualifyingEvidenceSql('historical_activity')} AND ` +
  `${historicalAvailableEpisodeScopeSql('historical_activity')} AND ` +
  `${nonSentinelActivitySql(
    'COALESCE(historical_activity."observedEndAt", historical_activity."observedAt")'
  )})`;

const lastActiveSql = `CASE WHEN ${currentMembershipSql()} THEN ${currentLastActiveSql} ELSE ${historicalLastActiveSql} END`;

const removalDueSql =
  `(SELECT MIN(library_due."removeAt") FROM "removal_schedule" library_due WHERE ` +
  `library_due."canonicalMediaId" = canonical.id AND library_due.status IN ('active', 'deferred'))`;

const currentWatchedUserCountSql =
  `(SELECT COUNT(DISTINCT metric_current_viewer."userId") FROM "current_viewing_state" metric_current_state ` +
  `INNER JOIN "viewer" metric_current_viewer ON metric_current_viewer.id = metric_current_state."viewerId" ` +
  `INNER JOIN "user" metric_current_user ON metric_current_user.id = metric_current_viewer."userId" WHERE ` +
  `metric_current_state."canonicalMediaId" = canonical.id AND metric_current_state."played" = :current ` +
  `AND metric_current_user."includeInUserMetrics" = :current ` +
  `AND ${activeCurrentStateSql('metric_current_state')} ` +
  `AND ${regularEpisodeSql('metric_current_state')} ` +
  `AND ${currentAvailableEpisodeScopeSql('metric_current_state')})`;

const historicalWatchedUserCountSql =
  `(SELECT COUNT(DISTINCT metric_historical_viewer."userId") FROM "viewing_evidence" metric_historical_evidence ` +
  `INNER JOIN "viewer" metric_historical_viewer ON metric_historical_viewer.id = metric_historical_evidence."viewerId" ` +
  `INNER JOIN "user" metric_historical_user ON metric_historical_user.id = metric_historical_viewer."userId" WHERE ` +
  `metric_historical_evidence."canonicalMediaId" = canonical.id AND ` +
  `metric_historical_evidence."completionClassification" = ${ViewingCompletionClassification.CONFIRMED} ` +
  `AND metric_historical_user."includeInUserMetrics" = :current ` +
  `AND ${regularEpisodeSql('metric_historical_evidence')} ` +
  `AND ${historicalAvailableEpisodeScopeSql('metric_historical_evidence')})`;

const watchedUserCountSql = `CASE WHEN ${currentMembershipSql()} THEN ${currentWatchedUserCountSql} ELSE ${historicalWatchedUserCountSql} END`;

type LibraryQueryStrategy =
  | 'legacy'
  | 'candidateFacts'
  | 'candidatePhysicalFacts';

interface LibraryQuerySql {
  currentMembership: string;
  historicalMembership: string;
  tmdbId: string;
  added: string;
  removed: string;
  removalSource: string;
  size: string;
  lastActive: string;
  watchedUserCount: string;
  libraryStatus: string;
}

const candidateMembershipCte = 'library_candidate_membership';
const candidateMembershipAlias = 'candidate_membership';
const candidatePhysicalFactsCte = 'library_candidate_physical_facts';
const candidatePhysicalFactsAlias = 'candidate_physical_facts';

const candidateMembershipSql =
  `WITH ` +
  `candidate_tmdb_identity AS (` +
  `SELECT identity."canonicalMediaId" AS "canonicalMediaId", ` +
  `MAX(CAST(identity."value" AS INTEGER)) AS "tmdbId" ` +
  `FROM "canonical_media_identity" identity WHERE identity."provider" = 'tmdb' ` +
  `AND identity."sourceScope" = '' GROUP BY identity."canonicalMediaId"), ` +
  `candidate_presence_membership AS (` +
  `SELECT candidate_presence."canonicalMediaId" AS "canonicalMediaId", ` +
  `MAX(CASE WHEN ${currentPresenceSql(
    'candidate_presence'
  )} THEN 1 ELSE 0 END) AS "currentMembership", ` +
  `MAX(CASE WHEN ${physicalLibraryPresenceSql(
    'candidate_presence'
  )} THEN 1 ELSE 0 END) AS "historicalPresenceMembership" ` +
  `FROM "library_presence" candidate_presence GROUP BY candidate_presence."canonicalMediaId"), ` +
  `candidate_file_membership AS (` +
  `SELECT candidate_file_presence."canonicalMediaId" AS "canonicalMediaId", ` +
  `1 AS "historicalFileMembership" FROM "library_file" candidate_file ` +
  `INNER JOIN "library_presence" candidate_file_presence ` +
  `ON candidate_file_presence.id = candidate_file."libraryPresenceId" ` +
  `GROUP BY candidate_file_presence."canonicalMediaId") ` +
  `SELECT canonical.id AS "canonicalMediaId", ` +
  `COALESCE(candidate_identity."tmdbId", candidate_media."tmdbId") AS "tmdbId", ` +
  `COALESCE(candidate_presence."currentMembership", 0) AS "currentMembership", ` +
  `CASE WHEN COALESCE(candidate_presence."historicalPresenceMembership", 0) = 1 ` +
  `OR COALESCE(candidate_files."historicalFileMembership", 0) = 1 THEN 1 ELSE 0 END AS "historicalMembership", ` +
  `CASE WHEN COALESCE(candidate_presence."currentMembership", 0) = 1 THEN 'current' ELSE 'archive' END AS "libraryStatus" ` +
  `FROM "canonical_media" canonical ` +
  `LEFT JOIN candidate_tmdb_identity candidate_identity ` +
  `ON candidate_identity."canonicalMediaId" = canonical.id ` +
  `LEFT JOIN "media" candidate_media ON candidate_media.id = canonical."currentMediaId" ` +
  `LEFT JOIN candidate_presence_membership candidate_presence ` +
  `ON candidate_presence."canonicalMediaId" = canonical.id ` +
  `LEFT JOIN candidate_file_membership candidate_files ` +
  `ON candidate_files."canonicalMediaId" = canonical.id`;

const candidatePhysicalFactsSql =
  `WITH ` +
  `candidate_presence_rollup AS (` +
  `SELECT candidate_presence."canonicalMediaId" AS "canonicalMediaId", ` +
  `MIN(CASE WHEN ${currentPresenceSql(
    'candidate_presence'
  )} THEN candidate_presence."addedAt" ELSE NULL END) AS "currentAddedAt", ` +
  `MIN(CASE WHEN ${currentPresenceSql(
    'candidate_presence'
  )} THEN candidate_presence."firstObservedAt" ELSE NULL END) AS "currentFirstObservedAt", ` +
  `MAX(CASE WHEN candidate_presence."isCurrent" = :current ` +
  `AND candidate_presence."sourceSystem" IN ('radarr', 'sonarr') ` +
  `AND candidate_presence."servarrHasFile" = :current ` +
  `THEN CAST(candidate_presence."logicalSizeBytes" AS BIGINT) ELSE NULL END) AS "currentLogicalSizeBytes", ` +
  `MIN(CASE WHEN candidate_presence."isCurrent" = :notCurrent ` +
  `THEN candidate_presence."addedAt" ELSE NULL END) AS "historicalPresenceAddedAt" ` +
  `FROM "library_presence" candidate_presence GROUP BY candidate_presence."canonicalMediaId"), ` +
  `candidate_file_rollup AS (` +
  `SELECT candidate_file_presence."canonicalMediaId" AS "canonicalMediaId", ` +
  `MIN(candidate_file."importedAt") AS "historicalFileAddedAt", ` +
  `MIN(CASE WHEN candidate_file."isCurrent" = :current ` +
  `AND candidate_file_presence."isCurrent" = :current ` +
  `AND candidate_file_presence."sourceSystem" IN ('radarr', 'sonarr') ` +
  `AND candidate_file_presence."servarrHasFile" = :current ` +
  `THEN candidate_file."importedAt" ELSE NULL END) AS "currentImportedAt", ` +
  `SUM(CASE WHEN candidate_file."isCurrent" = :current ` +
  `AND candidate_file_presence."isCurrent" = :current ` +
  `AND candidate_file_presence."sourceSystem" IN ('radarr', 'sonarr') ` +
  `AND candidate_file_presence."servarrHasFile" = :current ` +
  `THEN CAST(candidate_file."sizeBytes" AS BIGINT) ELSE NULL END) AS "currentSizeBytes" ` +
  `FROM "library_file" candidate_file ` +
  `INNER JOIN "library_presence" candidate_file_presence ` +
  `ON candidate_file_presence.id = candidate_file."libraryPresenceId" ` +
  `GROUP BY candidate_file_presence."canonicalMediaId"), ` +
  `candidate_presence_file_rollup AS (` +
  `SELECT candidate_presence_file."libraryPresenceId" AS "libraryPresenceId", ` +
  `MIN(candidate_presence_file."importedAt") AS "firstImportedAt", ` +
  `MAX(candidate_presence_file."removedAt") AS "lastRemovedAt" ` +
  `FROM "library_file" candidate_presence_file ` +
  `GROUP BY candidate_presence_file."libraryPresenceId"), ` +
  `candidate_latest_removed_file AS (` +
  `SELECT candidate_removed_file."libraryPresenceId" AS "libraryPresenceId", ` +
  `candidate_removed_file."removalSource" AS "removalSource", ` +
  `ROW_NUMBER() OVER (PARTITION BY candidate_removed_file."libraryPresenceId" ` +
  `ORDER BY candidate_removed_file."removedAt" DESC, candidate_removed_file.id DESC) AS "fileRank" ` +
  `FROM "library_file" candidate_removed_file ` +
  `WHERE candidate_removed_file."removedAt" IS NOT NULL), ` +
  `candidate_physical_tenure AS (` +
  `SELECT candidate_physical_presence.id AS "presenceId", ` +
  `candidate_physical_presence."canonicalMediaId" AS "canonicalMediaId", ` +
  `COALESCE(candidate_physical_presence."addedAt", candidate_physical_files."firstImportedAt") AS "addedAt", ` +
  `(CASE WHEN candidate_physical_presence."removedAt" IS NULL THEN candidate_physical_files."lastRemovedAt" ` +
  `WHEN candidate_physical_files."lastRemovedAt" IS NULL THEN candidate_physical_presence."removedAt" ` +
  `WHEN candidate_physical_presence."removedAt" >= candidate_physical_files."lastRemovedAt" ` +
  `THEN candidate_physical_presence."removedAt" ELSE candidate_physical_files."lastRemovedAt" END) AS "removedAt", ` +
  `(CASE WHEN candidate_physical_presence."removedAt" IS NOT NULL AND (` +
  `candidate_physical_files."lastRemovedAt" IS NULL OR ` +
  `candidate_physical_presence."removedAt" >= candidate_physical_files."lastRemovedAt") ` +
  `THEN COALESCE(candidate_physical_presence."removalSource", 'unknown') ` +
  `ELSE COALESCE(candidate_physical_source."removalSource", 'unknown') END) AS "removalSource" ` +
  `FROM "library_presence" candidate_physical_presence ` +
  `LEFT JOIN candidate_presence_file_rollup candidate_physical_files ` +
  `ON candidate_physical_files."libraryPresenceId" = candidate_physical_presence.id ` +
  `LEFT JOIN candidate_latest_removed_file candidate_physical_source ` +
  `ON candidate_physical_source."libraryPresenceId" = candidate_physical_presence.id ` +
  `AND candidate_physical_source."fileRank" = 1 ` +
  `WHERE candidate_physical_presence."sourceSystem" IN ('radarr', 'sonarr')), ` +
  `candidate_physical_ranked AS (` +
  `SELECT candidate_physical_tenure.*, ` +
  `ROW_NUMBER() OVER (PARTITION BY candidate_physical_tenure."canonicalMediaId" ` +
  `ORDER BY candidate_physical_tenure."removedAt" DESC, candidate_physical_tenure."presenceId" DESC) AS "tenureRank" ` +
  `FROM candidate_physical_tenure ` +
  `WHERE candidate_physical_tenure."removedAt" IS NOT NULL), ` +
  `candidate_jellyfin_ranked AS (` +
  `SELECT candidate_jellyfin_presence."canonicalMediaId" AS "canonicalMediaId", ` +
  `candidate_jellyfin_presence."addedAt" AS "addedAt", ` +
  `candidate_jellyfin_presence."removedAt" AS "removedAt", ` +
  `COALESCE(candidate_jellyfin_presence."removalSource", 'unknown') AS "removalSource", ` +
  `ROW_NUMBER() OVER (PARTITION BY candidate_jellyfin_presence."canonicalMediaId" ` +
  `ORDER BY candidate_jellyfin_presence."removedAt" DESC, candidate_jellyfin_presence.id DESC) AS "tenureRank" ` +
  `FROM "library_presence" candidate_jellyfin_presence ` +
  `WHERE candidate_jellyfin_presence."sourceSystem" = 'jellyfin' ` +
  `AND candidate_jellyfin_presence."removedAt" IS NOT NULL) ` +
  `SELECT candidate_membership."canonicalMediaId" AS "canonicalMediaId", ` +
  `CASE WHEN candidate_membership."currentMembership" = 1 ` +
  `THEN COALESCE(candidate_files."currentImportedAt", candidate_presence."currentAddedAt", candidate_presence."currentFirstObservedAt") ` +
  `ELSE COALESCE(candidate_physical."addedAt", candidate_jellyfin."addedAt", ` +
  `candidate_files."historicalFileAddedAt", candidate_presence."historicalPresenceAddedAt") END AS "addedAt", ` +
  `CASE WHEN candidate_membership."currentMembership" = 1 THEN NULL ` +
  `ELSE COALESCE(candidate_physical."removedAt", candidate_jellyfin."removedAt") END AS "removedAt", ` +
  `CASE WHEN candidate_membership."currentMembership" = 1 THEN NULL ` +
  `WHEN candidate_physical."removedAt" IS NOT NULL THEN candidate_physical."removalSource" ` +
  `ELSE candidate_jellyfin."removalSource" END AS "removalSource", ` +
  `CASE WHEN candidate_membership."currentMembership" = 1 ` +
  `THEN COALESCE(candidate_files."currentSizeBytes", candidate_presence."currentLogicalSizeBytes") ` +
  `ELSE NULL END AS "logicalSizeBytes" ` +
  `FROM "${candidateMembershipCte}" candidate_membership ` +
  `LEFT JOIN candidate_presence_rollup candidate_presence ` +
  `ON candidate_presence."canonicalMediaId" = candidate_membership."canonicalMediaId" ` +
  `LEFT JOIN candidate_file_rollup candidate_files ` +
  `ON candidate_files."canonicalMediaId" = candidate_membership."canonicalMediaId" ` +
  `LEFT JOIN candidate_physical_ranked candidate_physical ` +
  `ON candidate_physical."canonicalMediaId" = candidate_membership."canonicalMediaId" AND candidate_physical."tenureRank" = 1 ` +
  `LEFT JOIN candidate_jellyfin_ranked candidate_jellyfin ` +
  `ON candidate_jellyfin."canonicalMediaId" = candidate_membership."canonicalMediaId" AND candidate_jellyfin."tenureRank" = 1`;

const legacyQuerySql: LibraryQuerySql = {
  currentMembership: currentMembershipSql(),
  historicalMembership: historicalMembershipSql(),
  tmdbId: tmdbIdSql('canonical'),
  added: addedSql,
  removed: removedSql,
  removalSource: removalSourceSql,
  size: sizeSql,
  lastActive: lastActiveSql,
  watchedUserCount: watchedUserCountSql,
  libraryStatus: libraryStatusSql(),
};

const candidateCurrentMembership = `${candidateMembershipAlias}."currentMembership" = 1`;
const candidateHistoricalMembership = `${candidateMembershipAlias}."historicalMembership" = 1`;

const candidatePhysicalQuerySql: LibraryQuerySql = {
  currentMembership: candidateCurrentMembership,
  historicalMembership: candidateHistoricalMembership,
  tmdbId: `${candidateMembershipAlias}."tmdbId"`,
  added: `${candidatePhysicalFactsAlias}."addedAt"`,
  removed: `${candidatePhysicalFactsAlias}."removedAt"`,
  removalSource: `${candidatePhysicalFactsAlias}."removalSource"`,
  size: `${candidatePhysicalFactsAlias}."logicalSizeBytes"`,
  lastActive: `CASE WHEN ${candidateCurrentMembership} THEN ${currentLastActiveSql} ELSE ${historicalLastActiveSql} END`,
  watchedUserCount: `CASE WHEN ${candidateCurrentMembership} THEN ${currentWatchedUserCountSql} ELSE ${historicalWatchedUserCountSql} END`,
  libraryStatus: `${candidateMembershipAlias}."libraryStatus"`,
};

const candidateQuerySql: LibraryQuerySql = {
  currentMembership: candidateCurrentMembership,
  historicalMembership: candidateHistoricalMembership,
  tmdbId: `${candidateMembershipAlias}."tmdbId"`,
  added: `CASE WHEN ${candidateCurrentMembership} THEN ${currentAddedSql} ELSE ${historicalAddedSql} END`,
  removed: `CASE WHEN ${candidateCurrentMembership} THEN NULL ELSE ${historicalRemovedSql} END`,
  removalSource: `CASE WHEN ${candidateCurrentMembership} THEN NULL ELSE ${historicalRemovalSourceSql} END`,
  size: `CASE WHEN ${candidateCurrentMembership} THEN ${currentSizeSql} ELSE NULL END`,
  lastActive: `CASE WHEN ${candidateCurrentMembership} THEN ${currentLastActiveSql} ELSE ${historicalLastActiveSql} END`,
  watchedUserCount: `CASE WHEN ${candidateCurrentMembership} THEN ${currentWatchedUserCountSql} ELSE ${historicalWatchedUserCountSql} END`,
  libraryStatus: `${candidateMembershipAlias}."libraryStatus"`,
};

const querySql = (strategy: LibraryQueryStrategy): LibraryQuerySql => {
  if (strategy === 'legacy') return legacyQuerySql;
  if (strategy === 'candidatePhysicalFacts') return candidatePhysicalQuerySql;
  return candidateQuerySql;
};

const exclusiveUpperDate = (date: string): string => {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
};

const dateString = (value: string | Date | null | undefined): string | null => {
  return normalizeLibraryDatabaseDate(value)?.toISOString() ?? null;
};

export const buildLibraryExternalLinks = (
  mediaType: LibraryMediaType,
  media?: Media | null,
  canonicalJellyfinUrl?: string | null
): LibraryExternalLink[] => {
  const links: LibraryExternalLink[] = [];
  const service = mediaType === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr';
  const serviceLabel = service === 'radarr' ? 'Radarr' : 'Sonarr';
  if (media?.serviceUrl)
    links.push({ service, label: serviceLabel, url: media.serviceUrl });
  if (media?.serviceUrl4k && media.serviceUrl4k !== media.serviceUrl)
    links.push({
      service,
      label: `${serviceLabel} 4K`,
      url: media.serviceUrl4k,
    });
  if (media?.mediaUrl)
    links.push({ service: 'jellyfin', label: 'Jellyfin', url: media.mediaUrl });
  if (media?.mediaUrl4k && media.mediaUrl4k !== media.mediaUrl)
    links.push({
      service: 'jellyfin',
      label: 'Jellyfin 4K',
      url: media.mediaUrl4k,
    });
  if (
    canonicalJellyfinUrl &&
    !links.some((link) => link.service === 'jellyfin')
  )
    links.push({
      service: 'jellyfin',
      label: 'Jellyfin',
      url: canonicalJellyfinUrl,
    });
  return links;
};

interface LibraryJellyfinIdentity {
  sourceScope: string;
  value: string;
}

interface LibraryJellyfinUrlOptions {
  identities: readonly LibraryJellyfinIdentity[];
  serverId: string;
  hostname: string;
  pageName: 'details' | 'item';
}

export const resolveLibraryJellyfinUrl = ({
  identities,
  serverId,
  hostname,
  pageName,
}: LibraryJellyfinUrlOptions): string | null => {
  const configuredScope = normalizeExactJellyfinId(serverId) ?? serverId.trim();
  if (!configuredScope) return null;
  const matchingIds = new Set(
    identities.flatMap((identity) => {
      const identityScope =
        normalizeExactJellyfinId(identity.sourceScope) ??
        identity.sourceScope.trim();
      const itemId = normalizeExactJellyfinId(identity.value);
      return identityScope === configuredScope && itemId ? [itemId] : [];
    })
  );
  if (matchingIds.size !== 1) return null;
  let parsedHostname: URL;
  try {
    parsedHostname = new URL(hostname);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsedHostname.protocol) ||
    parsedHostname.username ||
    parsedHostname.password ||
    parsedHostname.search ||
    parsedHostname.hash
  )
    return null;
  const normalizedHostname = parsedHostname.toString().replace(/\/$/, '');
  const [itemId] = matchingIds;
  return `${normalizedHostname}/web/index.html#!/${pageName}?id=${itemId}&context=home&serverId=${encodeURIComponent(
    serverId
  )}`;
};

const safeUser = (user?: User | null): LibraryUser | null => {
  if (!user) return null;
  return {
    id: user.id,
    displayName:
      user.username?.trim() ||
      user.jellyfinUsername?.trim() ||
      user.plexUsername?.trim() ||
      'Viewer',
    avatar: user.avatar || null,
  };
};

const rawBoolean = (value: boolean | number | string | null) =>
  value === true || value === 1 || value === '1';

const uniformLibraryResolution = (
  files: ReadonlyMap<number, number | null>
): number | null => {
  if (files.size === 0) return null;
  const resolutions = new Set<number>();
  for (const resolution of files.values()) {
    if (resolution === null) return null;
    resolutions.add(resolution);
  }
  if (resolutions.size !== 1) return null;
  const [resolution] = resolutions;
  return resolution === 1080 || resolution === 2160 ? resolution : null;
};

const totalLibraryFileSize = (
  files: ReadonlyMap<number, bigint | null>
): string | null => {
  if (files.size === 0) return null;
  let total = 0n;
  for (const size of files.values()) {
    if (size === null) return null;
    total += size;
  }
  return total.toString();
};

export const loadLibraryRequesters = async (
  canonicalMediaIds: number[]
): Promise<Map<number, LibraryRequester[]>> => {
  const selectedIds = [
    ...new Set(
      canonicalMediaIds.filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];
  if (selectedIds.length === 0) return new Map();

  const rows = await getRepository(CanonicalMedia)
    .createQueryBuilder('request_canonical')
    .innerJoin(
      Media,
      'request_media',
      `(request_media.id = request_canonical."currentMediaId" OR (` +
        `request_media."tmdbId" = ${tmdbIdSql('request_canonical')} AND ` +
        `request_media."mediaType" = CASE WHEN request_canonical."mediaType" = 'series' THEN 'tv' ELSE 'movie' END))`
    )
    .innerJoin(
      MediaRequest,
      'library_request',
      'library_request."mediaId" = request_media.id'
    )
    .innerJoin(
      User,
      'request_user',
      'request_user.id = library_request."requestedById"'
    )
    .leftJoin(
      SeasonRequest,
      'request_season',
      'request_season."requestId" = library_request.id'
    )
    .select('request_canonical.id', 'canonicalMediaId')
    .addSelect('library_request.id', 'requestId')
    .addSelect('library_request.type', 'requestType')
    .addSelect('library_request.status', 'requestStatus')
    .addSelect('library_request.is4k', 'requestIs4k')
    .addSelect('library_request.isAutoRequest', 'requestIsAuto')
    .addSelect('library_request.createdAt', 'requestCreatedAt')
    .addSelect('library_request.updatedAt', 'requestUpdatedAt')
    .addSelect('request_user.id', 'userId')
    .addSelect('request_user.username', 'username')
    .addSelect('request_user.jellyfinUsername', 'jellyfinUsername')
    .addSelect('request_user.plexUsername', 'plexUsername')
    .addSelect('request_user.avatar', 'avatar')
    .addSelect('request_season.id', 'seasonId')
    .addSelect('request_season.seasonNumber', 'seasonNumber')
    .addSelect('request_season.status', 'seasonStatus')
    .addSelect('request_season.createdAt', 'seasonCreatedAt')
    .addSelect('request_season.updatedAt', 'seasonUpdatedAt')
    .where('request_canonical.id IN (:...canonicalMediaIds)', {
      canonicalMediaIds: selectedIds,
    })
    .orderBy('request_canonical.id', 'ASC')
    .addOrderBy('request_user.id', 'ASC')
    .addOrderBy('library_request.createdAt', 'ASC')
    .addOrderBy('library_request.id', 'ASC')
    .addOrderBy('request_season.seasonNumber', 'ASC')
    .addOrderBy('request_season.id', 'ASC')
    .getRawMany<RawLibraryRequester>();

  const grouped = new Map<number, Map<number, LibraryRequester>>();
  for (const row of rows) {
    const canonicalMediaId = Number(row.canonicalMediaId);
    const userId = Number(row.userId);
    const requestId = Number(row.requestId);
    const requestCreatedAt = dateString(row.requestCreatedAt);
    const requestUpdatedAt = dateString(row.requestUpdatedAt);
    if (!requestCreatedAt || !requestUpdatedAt) {
      throw new Error(`Library request ${requestId} has an invalid timestamp`);
    }
    let byUser = grouped.get(canonicalMediaId);
    if (!byUser) {
      byUser = new Map();
      grouped.set(canonicalMediaId, byUser);
    }
    let requester = byUser.get(userId);
    if (!requester) {
      requester = {
        id: userId,
        displayName:
          row.username?.trim() ||
          row.jellyfinUsername?.trim() ||
          row.plexUsername?.trim() ||
          'Viewer',
        avatar: row.avatar || null,
        requests: [],
      };
      byUser.set(userId, requester);
    }
    let request = requester.requests.find((item) => item.id === requestId);
    if (!request) {
      request = {
        id: requestId,
        type: row.requestType,
        status: Number(row.requestStatus) as MediaRequestStatus,
        is4k: rawBoolean(row.requestIs4k),
        isAutoRequest: rawBoolean(row.requestIsAuto),
        createdAt: requestCreatedAt,
        updatedAt: requestUpdatedAt,
        seasons: [],
      };
      requester.requests.push(request);
    }
    if (row.seasonId !== null && row.seasonNumber !== null) {
      const seasonId = Number(row.seasonId);
      if (!request.seasons.some((season) => season.id === seasonId)) {
        const seasonCreatedAt = dateString(row.seasonCreatedAt);
        const seasonUpdatedAt = dateString(row.seasonUpdatedAt);
        if (!seasonCreatedAt || !seasonUpdatedAt) {
          throw new Error(
            `Library request Season ${seasonId} has an invalid timestamp`
          );
        }
        request.seasons.push({
          id: seasonId,
          seasonNumber: Number(row.seasonNumber),
          status: Number(row.seasonStatus) as MediaRequestStatus,
          createdAt: seasonCreatedAt,
          updatedAt: seasonUpdatedAt,
        });
      }
    }
  }

  return new Map(
    [...grouped].map(([canonicalMediaId, byUser]) => [
      canonicalMediaId,
      [...byUser.values()]
        .map((requester) => ({
          ...requester,
          requests: requester.requests
            .map(
              (request): LibraryRequestFact => ({
                ...request,
                seasons: [...request.seasons].sort(
                  (left, right) =>
                    left.seasonNumber - right.seasonNumber ||
                    left.createdAt.localeCompare(right.createdAt) ||
                    left.id - right.id
                ),
              })
            )
            .sort(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) ||
                left.id - right.id
            ),
        }))
        .sort((left, right) => left.id - right.id),
    ])
  );
};

export const loadLibraryViewingEvidence = async (
  canonicalMediaIds: number[]
): Promise<ViewingEvidence[]> => {
  const selectedIds = [
    ...new Set(
      canonicalMediaIds.filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];
  if (selectedIds.length === 0) return [];

  const rows = await getRepository(ViewingEvidence)
    .createQueryBuilder('evidence')
    .leftJoin(
      Viewer,
      'evidence_viewer',
      'evidence_viewer.id = evidence.viewerId'
    )
    .leftJoin(
      User,
      'evidence_user',
      'evidence_user.id = evidence_viewer.userId'
    )
    .select('evidence.id', 'id')
    .addSelect('evidence.sourceClass', 'sourceClass')
    .addSelect('evidence.viewerId', 'viewerId')
    .addSelect('evidence.canonicalMediaId', 'canonicalMediaId')
    .addSelect('evidence.canonicalEpisodeId', 'canonicalEpisodeId')
    .addSelect('evidence.observedAt', 'observedAt')
    .addSelect('evidence.observedEndAt', 'observedEndAt')
    .addSelect('evidence.playbackDurationSeconds', 'playbackDurationSeconds')
    .addSelect('evidence.progressBasisPoints', 'progressBasisPoints')
    .addSelect('evidence.completionClassification', 'completionClassification')
    .addSelect('evidence_user.id', 'userId')
    .addSelect('evidence_user.username', 'username')
    .addSelect('evidence_user.jellyfinUsername', 'jellyfinUsername')
    .addSelect('evidence_user.plexUsername', 'plexUsername')
    .addSelect('evidence_user.avatar', 'avatar')
    .addSelect('evidence_user.includeInUserMetrics', 'includeInUserMetrics')
    .where('evidence.canonicalMediaId IN (:...canonicalMediaIds)', {
      canonicalMediaIds: selectedIds,
    })
    .getRawMany<RawLibraryViewingEvidence>();

  return rows.map((row) => {
    const userId = row.userId === null ? null : Number(row.userId);
    const user = userId
      ? new User({
          id: userId,
          username: row.username ?? undefined,
          jellyfinUsername: row.jellyfinUsername,
          plexUsername: row.plexUsername,
          avatar: row.avatar ?? '',
          includeInUserMetrics: rawBoolean(row.includeInUserMetrics),
        })
      : null;
    const viewerId = row.viewerId === null ? null : Number(row.viewerId);
    return new ViewingEvidence({
      id: Number(row.id),
      sourceClass: row.sourceClass,
      viewerId,
      viewer: viewerId ? new Viewer({ id: viewerId, userId, user }) : null,
      canonicalMediaId:
        row.canonicalMediaId === null ? null : Number(row.canonicalMediaId),
      canonicalEpisodeId:
        row.canonicalEpisodeId === null ? null : Number(row.canonicalEpisodeId),
      observedAt: normalizeLibraryDatabaseDate(row.observedAt),
      observedEndAt: normalizeLibraryDatabaseDate(row.observedEndAt),
      playbackDurationSeconds:
        row.playbackDurationSeconds === null
          ? null
          : Number(row.playbackDurationSeconds),
      progressBasisPoints:
        row.progressBasisPoints === null
          ? null
          : Number(row.progressBasisPoints),
      completionClassification: Number(row.completionClassification),
    });
  });
};

const factKey = (viewerId: number, user?: User | null) =>
  user ? `user:${user.id}` : `viewer:${viewerId}`;

const updateLatest = (current: Date | null, candidate?: Date | null) => {
  const normalized = normalizeJellyfinActivityDate(candidate);
  if (!normalized) return current;
  return !current || normalized.getTime() > current.getTime()
    ? normalized
    : current;
};

export const isQualifyingEvidence = isQualifyingLibraryEvidence;

const createFact = (
  viewerId: number,
  user?: User | null
): MutableViewerFact => {
  const safe = safeUser(user);
  return {
    key: factKey(viewerId, user),
    userId: safe?.id ?? null,
    displayName: safe?.displayName ?? 'Unlinked viewer',
    avatar: safe?.avatar ?? null,
    completedMovie: false,
    completedEpisodeIds: new Set(),
    watchedAt: null,
    lastActiveAt: null,
  };
};

const getFact = (
  facts: Map<string, MutableViewerFact>,
  viewerId: number,
  user?: User | null
) => {
  const key = factKey(viewerId, user);
  const existing = facts.get(key);
  if (existing) return existing;
  const created = createFact(viewerId, user);
  facts.set(key, created);
  return created;
};

const collectLibraryActivityFacts = ({
  mediaType,
  states,
  evidence,
  episodes,
  completionScope = 'historical',
}: {
  mediaType: LibraryMediaType;
  states: CurrentViewingState[];
  evidence: ViewingEvidence[];
  episodes: AvailableEpisodeRow[];
  completionScope?: 'current' | 'historical';
}): Map<string, MutableViewerFact> => {
  const facts = new Map<string, MutableViewerFact>();
  const available = new Map(
    episodes.map((episode) => [episode.canonicalEpisodeId, episode])
  );

  for (const state of states) {
    if (!state.played && (state.progressBasisPoints ?? 0) <= 0) continue;
    if (
      mediaType === LibraryMediaType.SERIES &&
      (!state.canonicalEpisodeId || !available.has(state.canonicalEpisodeId))
    )
      continue;
    const fact = getFact(facts, state.viewerId, state.viewer?.user);
    if (mediaType === LibraryMediaType.MOVIE) {
      fact.completedMovie ||= state.played;
    } else if (state.played && state.canonicalEpisodeId)
      fact.completedEpisodeIds.add(state.canonicalEpisodeId);
    if (state.played && state.lastPlayedAt)
      fact.watchedAt = updateLatest(fact.watchedAt, state.lastPlayedAt);
    if (state.lastPlayedAt)
      fact.lastActiveAt = updateLatest(fact.lastActiveAt, state.lastPlayedAt);
  }

  for (const item of evidence) {
    if (!item.viewerId || !isQualifyingEvidence(item)) continue;
    if (
      mediaType === LibraryMediaType.SERIES &&
      (!item.canonicalEpisodeId || !available.has(item.canonicalEpisodeId))
    )
      continue;
    const fact = getFact(facts, item.viewerId, item.viewer?.user);
    if (completionScope === 'historical') {
      if (mediaType === LibraryMediaType.MOVIE) {
        fact.completedMovie ||=
          item.completionClassification ===
          ViewingCompletionClassification.CONFIRMED;
      } else if (
        item.canonicalEpisodeId &&
        item.completionClassification ===
          ViewingCompletionClassification.CONFIRMED
      )
        fact.completedEpisodeIds.add(item.canonicalEpisodeId);
      if (
        item.completionClassification ===
        ViewingCompletionClassification.CONFIRMED
      )
        fact.watchedAt = updateLatest(
          fact.watchedAt,
          item.observedEndAt ?? item.observedAt
        );
    }
    fact.lastActiveAt = updateLatest(
      fact.lastActiveAt,
      item.observedEndAt ?? item.observedAt
    );
  }

  return facts;
};

interface LibraryWatchedAggregation {
  watchedUsers: LibraryWatchedUser[];
  hasWatchedDetail: boolean;
  lastActiveUsers: LibraryUser[];
}

const percentage = (watched: number, available: number) =>
  available > 0 ? Math.round((watched / available) * 100) : 0;

export const aggregateLibraryWatched = ({
  mediaType,
  states,
  evidence,
  episodes,
  scope = 'current',
  authoritativeLastActiveAt = null,
}: {
  mediaType: LibraryMediaType;
  states: CurrentViewingState[];
  evidence: ViewingEvidence[];
  episodes: AvailableEpisodeRow[];
  scope?: Exclude<LibraryScope, 'all'>;
  authoritativeLastActiveAt?: string | Date | null;
}): LibraryWatchedAggregation => {
  const facts = collectLibraryActivityFacts({
    mediaType,
    states: scope === 'current' ? states : [],
    evidence,
    episodes,
    completionScope: scope === 'current' ? 'current' : 'historical',
  });
  const regularIds = new Set(
    episodes
      .filter((episode) => !episode.isSpecial && episode.seasonNumber > 0)
      .map((episode) => episode.canonicalEpisodeId)
  );
  const watchedUsers = [...facts.values()]
    .flatMap((fact): LibraryWatchedUser[] => {
      if (mediaType === LibraryMediaType.MOVIE) {
        return fact.completedMovie
          ? [
              {
                key: fact.key,
                userId: fact.userId,
                displayName: fact.displayName,
                avatar: fact.avatar,
                watchedEpisodeCount: null,
                availableEpisodeCount: null,
                watchedPercentage: 100,
                lastViewedAt: dateString(fact.watchedAt),
              },
            ]
          : [];
      }
      const watchedEpisodeCount = [...fact.completedEpisodeIds].filter((id) =>
        regularIds.has(id)
      ).length;
      return watchedEpisodeCount > 0
        ? [
            {
              key: fact.key,
              userId: fact.userId,
              displayName: fact.displayName,
              avatar: fact.avatar,
              watchedEpisodeCount,
              availableEpisodeCount: regularIds.size,
              watchedPercentage: percentage(
                watchedEpisodeCount,
                regularIds.size
              ),
              lastViewedAt: dateString(fact.watchedAt),
            },
          ]
        : [];
    })
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const authoritativeTime = normalizeLibraryDatabaseDate(
    authoritativeLastActiveAt
  )?.getTime();
  const lastActiveUsers =
    authoritativeTime === undefined
      ? []
      : [
          ...new Map(
            [...facts.values()]
              .filter(
                (fact) =>
                  fact.userId !== null &&
                  fact.lastActiveAt?.getTime() === authoritativeTime
              )
              .map((fact) => [
                fact.userId as number,
                {
                  id: fact.userId as number,
                  displayName: fact.displayName,
                  avatar: fact.avatar,
                },
              ])
          ).values(),
        ].sort((left, right) => left.id - right.id);
  const hasWatchedDetail =
    mediaType === LibraryMediaType.SERIES &&
    [...facts.values()].some((fact) => fact.completedEpisodeIds.size > 0);

  return {
    watchedUsers,
    hasWatchedDetail,
    lastActiveUsers,
  };
};

const normalizeEpisodeRows = (
  rows: {
    canonicalMediaId: string | number;
    canonicalEpisodeId: string | number;
    seasonNumber: string | number;
    episodeNumber: string | number;
    isSpecial: string | number | boolean;
  }[]
): AvailableEpisodeRow[] =>
  rows.map((row) => ({
    canonicalMediaId: Number(row.canonicalMediaId),
    canonicalEpisodeId: Number(row.canonicalEpisodeId),
    seasonNumber: Number(row.seasonNumber),
    episodeNumber: Number(row.episodeNumber),
    isSpecial:
      row.isSpecial === true || row.isSpecial === 1 || row.isSpecial === '1',
  }));

export class LibraryService {
  constructor(
    private readonly dependencies: LibraryDependencies = defaultDependencies
  ) {}

  private buildBase(
    input: LibraryQuery,
    strategy: LibraryQueryStrategy = 'candidateFacts',
    includePhysicalFacts = false
  ) {
    const scope = input.scope ?? 'current';
    const sql = querySql(strategy);
    const userIds = selectedUserIds(input);
    const storageRootIds = [
      ...new Set([
        ...(input.storageRootIds ?? []),
        ...(input.storageRootId ? [input.storageRootId] : []),
      ]),
    ];
    const query = getRepository(CanonicalMedia).createQueryBuilder('canonical');
    const physicalFactsRequired =
      includePhysicalFacts ||
      Boolean(
        input.addedFrom ||
        input.addedTo ||
        input.removedFrom ||
        input.removedTo ||
        input.removalSources?.length
      );
    if (strategy !== 'legacy') {
      query
        .addCommonTableExpression(
          candidateMembershipSql,
          candidateMembershipCte
        )
        .innerJoin(
          candidateMembershipCte,
          candidateMembershipAlias,
          `${candidateMembershipAlias}."canonicalMediaId" = canonical.id`
        );
      if (strategy === 'candidatePhysicalFacts' && physicalFactsRequired)
        query
          .addCommonTableExpression(
            candidatePhysicalFactsSql,
            candidatePhysicalFactsCte
          )
          .innerJoin(
            candidatePhysicalFactsCte,
            candidatePhysicalFactsAlias,
            `${candidatePhysicalFactsAlias}."canonicalMediaId" = canonical.id`
          );
    }
    query.where(
      populationSql(scope, sql.currentMembership, sql.historicalMembership),
      { current: true, notCurrent: false }
    );

    const collectionMembership = input.collectionMembership ?? 'any';
    if (collectionMembership !== 'any') {
      query
        .andWhere('canonical.mediaType = :collectionMediaType', {
          collectionMediaType: LibraryMediaType.MOVIE,
        })
        .andWhere('canonical.collectionMembershipHydratedAt IS NOT NULL')
        .andWhere(
          collectionMembership === 'in'
            ? 'canonical.tmdbCollectionId IS NOT NULL'
            : 'canonical.tmdbCollectionId IS NULL'
        );
    } else if (input.mediaType && input.mediaType !== 'all')
      query.andWhere('canonical.mediaType = :mediaType', {
        mediaType: input.mediaType,
      });
    if (storageRootIds.length)
      query.andWhere(
        `EXISTS (SELECT 1 FROM "library_presence" library_storage WHERE ` +
          `library_storage."canonicalMediaId" = canonical.id AND library_storage."storageRootId" IN (:...storageRootIds) ` +
          `AND ${storagePresenceForScopeSql(
            'library_storage',
            scope,
            sql.currentMembership
          )})`,
        { storageRootIds }
      );
    const animation = input.animation ?? 'any';
    if (animation !== 'any') {
      const animationMembership =
        `EXISTS (SELECT 1 FROM "library_presence" library_animation ` +
        `INNER JOIN "storage_root" library_animation_root ON ` +
        `library_animation_root.id = library_animation."storageRootId" WHERE ` +
        `library_animation."canonicalMediaId" = canonical.id AND ` +
        `library_animation_root."isAnimation" = :animationRoot AND ` +
        `${storagePresenceForScopeSql(
          'library_animation',
          scope,
          sql.currentMembership
        )})`;
      query.andWhere(
        animation === 'yes'
          ? animationMembership
          : `NOT (${animationMembership})`,
        { animationRoot: true }
      );
    }

    if (input.search?.trim()) {
      for (const [index, word] of input.search
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .entries()) {
        query.andWhere(
          `LOWER(COALESCE(canonical."titleSnapshot", '')) LIKE :search${index}`,
          { [`search${index}`]: `%${word}%` }
        );
      }
    }
    applyPeopleFilters(query, input, scope, userIds, undefined, sql);
    if (input.addedFrom)
      query.andWhere(`${sql.added} >= :addedFrom`, {
        addedFrom: new Date(`${input.addedFrom}T00:00:00.000Z`),
      });
    if (input.addedTo)
      query.andWhere(`${sql.added} < :addedTo`, {
        addedTo: new Date(exclusiveUpperDate(input.addedTo)),
      });
    if (input.activity === 'present')
      query.andWhere(`${sql.lastActive} IS NOT NULL`);
    if (input.activity === 'none') query.andWhere(`${sql.lastActive} IS NULL`);
    if (input.activityFrom)
      query.andWhere(`${sql.lastActive} >= :activityFrom`, {
        activityFrom: new Date(`${input.activityFrom}T00:00:00.000Z`),
      });
    if (input.activityTo)
      query.andWhere(`${sql.lastActive} < :activityTo`, {
        activityTo: new Date(exclusiveUpperDate(input.activityTo)),
      });
    if (input.scheduled === 'yes')
      query.andWhere(
        `${sql.currentMembership} AND EXISTS (SELECT 1 FROM "removal_schedule" library_schedule WHERE ` +
          `library_schedule."canonicalMediaId" = canonical.id AND ` +
          `library_schedule.status IN ('active', 'deferred'))`
      );
    if (input.scheduled === 'no')
      query.andWhere(
        `(${sql.currentMembership} AND NOT EXISTS (SELECT 1 FROM "removal_schedule" library_schedule WHERE ` +
          `library_schedule."canonicalMediaId" = canonical.id AND ` +
          `library_schedule.status IN ('active', 'deferred')))`
      );
    if (input.removalDueFrom)
      query.andWhere(
        `${sql.currentMembership} AND ${removalDueSql} >= :removalDueFrom`,
        {
          removalDueFrom: new Date(`${input.removalDueFrom}T00:00:00.000Z`),
        }
      );
    if (input.removalDueTo)
      query.andWhere(
        `${sql.currentMembership} AND ${removalDueSql} < :removalDueTo`,
        {
          removalDueTo: new Date(exclusiveUpperDate(input.removalDueTo)),
        }
      );
    if (input.removedFrom)
      query.andWhere(`${sql.removed} >= :removedFrom`, {
        removedFrom: new Date(`${input.removedFrom}T00:00:00.000Z`),
      });
    if (input.removedTo)
      query.andWhere(`${sql.removed} < :removedTo`, {
        removedTo: new Date(exclusiveUpperDate(input.removedTo)),
      });
    if (input.removalSources?.length)
      query.andWhere(`${sql.removalSource} IN (:...removalSources)`, {
        removalSources: input.removalSources,
      });
    return query;
  }

  private async loadEpisodes(
    canonicalIds: number[],
    scope: Exclude<LibraryScope, 'all'>
  ) {
    if (canonicalIds.length === 0) return [];
    const query = getRepository(LibraryFileEpisode)
      .createQueryBuilder('link')
      .innerJoin('link.libraryFile', 'file')
      .innerJoin('file.libraryPresence', 'presence')
      .innerJoin('link.canonicalEpisode', 'episode')
      .innerJoin('episode.season', 'season')
      .select('presence.canonicalMediaId', 'canonicalMediaId')
      .addSelect('episode.id', 'canonicalEpisodeId')
      .addSelect('season.seasonNumber', 'seasonNumber')
      .addSelect('episode.episodeNumber', 'episodeNumber')
      .addSelect('episode.isSpecial', 'isSpecial')
      .where('presence.canonicalMediaId IN (:...canonicalIds)', {
        canonicalIds,
      })
      .andWhere('presence.sourceSystem IN (:...sources)', {
        sources: ['radarr', 'sonarr'],
      });
    if (scope === 'current')
      query
        .andWhere('presence.isCurrent = :current', { current: true })
        .andWhere('presence.servarrHasFile = :current', { current: true })
        .andWhere('file.isCurrent = :current', { current: true });
    const rows = await query
      .orderBy('season.seasonNumber', 'ASC')
      .addOrderBy('episode.episodeNumber', 'ASC')
      .distinct(true)
      .getRawMany();
    return normalizeEpisodeRows(rows);
  }

  private async loadSeasonRemovalFacts(
    canonicalMediaId: number
  ): Promise<Map<number, SeasonRemovalFact>> {
    const rows = await getRepository(LibraryFile)
      .createQueryBuilder('file')
      .innerJoin('file.libraryPresence', 'presence')
      .innerJoin(LibraryFileEpisode, 'link', 'link.libraryFileId = file.id')
      .innerJoin(
        'canonical_episode',
        'episode',
        'episode.id = link.canonicalEpisodeId'
      )
      .innerJoin('canonical_season', 'season', 'season.id = episode.seasonId')
      .select('file.id', 'fileId')
      .addSelect('season.seasonNumber', 'seasonNumber')
      .addSelect('file.isCurrent', 'fileIsCurrent')
      .addSelect('presence.isCurrent', 'presenceIsCurrent')
      .addSelect('file.removedAt', 'removedAt')
      .addSelect('file.removalSource', 'removalSource')
      .where('presence.canonicalMediaId = :canonicalMediaId', {
        canonicalMediaId,
      })
      .andWhere('presence.sourceSystem IN (:...sources)', {
        sources: ['radarr', 'sonarr'],
      })
      .getRawMany<{
        fileId: string | number;
        seasonNumber: string | number;
        fileIsCurrent: string | number | boolean;
        presenceIsCurrent: string | number | boolean;
        removedAt: string | Date | null;
        removalSource: LibraryRemovalSource | null;
      }>();
    const bySeason = new Map<number, Map<number, (typeof rows)[number]>>();
    for (const row of rows) {
      const seasonNumber = Number(row.seasonNumber);
      const files = bySeason.get(seasonNumber) ?? new Map();
      files.set(Number(row.fileId), row);
      bySeason.set(seasonNumber, files);
    }
    return new Map(
      [...bySeason].map(([seasonNumber, files]) => {
        const values = [...files.values()];
        const current = values.some(
          (row) =>
            (row.fileIsCurrent === true ||
              row.fileIsCurrent === 1 ||
              row.fileIsCurrent === '1') &&
            (row.presenceIsCurrent === true ||
              row.presenceIsCurrent === 1 ||
              row.presenceIsCurrent === '1')
        );
        if (current)
          return [seasonNumber, { removedAt: null, removalSource: null }];
        const terminal = values
          .map((row) => ({
            ...row,
            normalizedRemovedAt: normalizeLibraryDatabaseDate(row.removedAt),
          }))
          .filter(
            (row): row is typeof row & { normalizedRemovedAt: Date } =>
              row.normalizedRemovedAt !== null
          )
          .sort(
            (left, right) =>
              right.normalizedRemovedAt.getTime() -
                left.normalizedRemovedAt.getTime() ||
              Number(right.fileId) - Number(left.fileId)
          )[0];
        return [
          seasonNumber,
          terminal
            ? {
                removedAt: terminal.normalizedRemovedAt.toISOString(),
                removalSource:
                  terminal.removalSource ?? LibraryRemovalSource.UNKNOWN,
              }
            : { removedAt: null, removalSource: null },
        ];
      })
    );
  }

  private async loadFileSummaries(
    targets: {
      canonicalMediaId: number;
      libraryStatus: Exclude<LibraryScope, 'all'>;
    }[],
    includeSeasonSizes = false
  ): Promise<LibraryFileSummaries> {
    const selectedTargets = new Map(
      targets.map((target) => [target.canonicalMediaId, target.libraryStatus])
    );
    const canonicalIds = [...selectedTargets.keys()];
    if (canonicalIds.length === 0)
      return { media: new Map(), seasons: new Map(), seasonSizes: new Map() };

    const query = getRepository(LibraryFile)
      .createQueryBuilder('resolution_file')
      .innerJoin('resolution_file.libraryPresence', 'resolution_presence')
      .leftJoin(
        LibraryFileEpisode,
        'resolution_link',
        'resolution_link.libraryFileId = resolution_file.id'
      )
      .leftJoin(
        'canonical_episode',
        'resolution_episode',
        'resolution_episode.id = resolution_link.canonicalEpisodeId'
      )
      .leftJoin(
        'canonical_season',
        'resolution_season',
        'resolution_season.id = resolution_episode.seasonId'
      )
      .select('resolution_presence.canonicalMediaId', 'canonicalMediaId')
      .addSelect('resolution_file.id', 'fileId')
      .addSelect('resolution_file.resolution', 'resolution')
      .addSelect('resolution_file.isCurrent', 'fileIsCurrent')
      .addSelect('resolution_presence.isCurrent', 'presenceIsCurrent')
      .addSelect('resolution_presence.servarrHasFile', 'servarrHasFile')
      .addSelect('resolution_season.seasonNumber', 'seasonNumber')
      .where('resolution_presence.canonicalMediaId IN (:...canonicalIds)', {
        canonicalIds,
      })
      .andWhere('resolution_presence.sourceSystem IN (:...sources)', {
        sources: ['radarr', 'sonarr'],
      });
    if (includeSeasonSizes)
      query.addSelect('resolution_file.sizeBytes', 'sizeBytes');
    const rows = await query.getRawMany<{
      canonicalMediaId: string | number;
      fileId: string | number;
      resolution: string | number | null;
      sizeBytes: string | number | null;
      fileIsCurrent: string | number | boolean;
      presenceIsCurrent: string | number | boolean;
      servarrHasFile: string | number | boolean | null;
      seasonNumber: string | number | null;
    }>();

    const mediaFiles = new Map<number, Map<number, number | null>>();
    const seasonFiles = new Map<string, Map<number, number | null>>();
    const seasonSizeFiles = new Map<string, Map<number, bigint | null>>();
    for (const row of rows) {
      const canonicalMediaId = Number(row.canonicalMediaId);
      const status = selectedTargets.get(canonicalMediaId);
      if (!status) continue;
      if (
        status === 'current' &&
        (!rawBoolean(row.fileIsCurrent) ||
          !rawBoolean(row.presenceIsCurrent) ||
          !rawBoolean(row.servarrHasFile))
      )
        continue;
      const fileId = Number(row.fileId);
      const parsedResolution =
        row.resolution === null ? null : Number(row.resolution);
      const resolution =
        parsedResolution !== null &&
        Number.isSafeInteger(parsedResolution) &&
        parsedResolution > 0
          ? parsedResolution
          : null;
      const files = mediaFiles.get(canonicalMediaId) ?? new Map();
      files.set(fileId, resolution);
      mediaFiles.set(canonicalMediaId, files);
      if (row.seasonNumber !== null) {
        const key = `${canonicalMediaId}:${Number(row.seasonNumber)}`;
        const season = seasonFiles.get(key) ?? new Map();
        season.set(fileId, resolution);
        seasonFiles.set(key, season);
        const seasonSizes = seasonSizeFiles.get(key) ?? new Map();
        let sizeBytes: bigint | null = null;
        if (includeSeasonSizes && row.sizeBytes !== null) {
          try {
            const parsedSize = BigInt(row.sizeBytes);
            if (parsedSize >= 0n) sizeBytes = parsedSize;
          } catch {
            sizeBytes = null;
          }
        }
        if (includeSeasonSizes) {
          seasonSizes.set(fileId, sizeBytes);
          seasonSizeFiles.set(key, seasonSizes);
        }
      }
    }

    return {
      media: new Map(
        canonicalIds.map((canonicalMediaId) => [
          canonicalMediaId,
          uniformLibraryResolution(
            mediaFiles.get(canonicalMediaId) ?? new Map()
          ),
        ])
      ),
      seasons: new Map(
        [...seasonFiles].map(([key, files]) => [
          key,
          uniformLibraryResolution(files),
        ])
      ),
      seasonSizes: new Map(
        [...seasonSizeFiles].map(([key, files]) => [
          key,
          totalLibraryFileSize(files),
        ])
      ),
    };
  }

  private async loadPageEnrichments(
    rows: RawLibraryRow[]
  ): Promise<PageEnrichments> {
    const currentIds = rows
      .filter((row) => row.libraryStatus === 'current')
      .map((row) => Number(row.canonicalMediaId));
    const seriesIds = rows
      .filter((row) => row.mediaType === LibraryMediaType.SERIES)
      .map((row) => Number(row.canonicalMediaId));
    const tmdbPairs = rows.flatMap((row) => {
      const tmdbId = row.tmdbId === null ? null : Number(row.tmdbId);
      return tmdbId && Number.isSafeInteger(tmdbId)
        ? [
            {
              mediaType:
                row.mediaType === LibraryMediaType.SERIES ? 'tv' : 'movie',
              tmdbId,
            } as const,
          ]
        : [];
    });

    const [
      storageRows,
      freshRows,
      seasonRows,
      canonicalRows,
      jellyfinIdentityRows,
      jellyfinPresenceRows,
      fileSummaries,
      requestMediaRows,
    ] = await Promise.all([
      currentIds.length
        ? getRepository(LibraryPresence)
            .createQueryBuilder('summary_presence')
            .innerJoin(
              StorageRoot,
              'summary_root',
              'summary_root.id = summary_presence.storageRootId'
            )
            .select('summary_presence.canonicalMediaId', 'canonicalMediaId')
            .addSelect('summary_root.id', 'rootId')
            .addSelect('summary_root.servarrType', 'servarrType')
            .addSelect('summary_root.nameSnapshot', 'nameSnapshot')
            .addSelect('summary_root.displayName', 'displayName')
            .addSelect('summary_root.color', 'color')
            .addSelect('summary_root.pathSnapshot', 'pathSnapshot')
            .where('summary_presence.canonicalMediaId IN (:...currentIds)', {
              currentIds,
            })
            .andWhere(currentPresenceSql('summary_presence'))
            .setParameter('current', true)
            .distinct(true)
            .getRawMany<{
              canonicalMediaId: string | number;
              rootId: string | number;
              servarrType: 'radarr' | 'sonarr';
              nameSnapshot: string | null;
              displayName: string | null;
              color: string | null;
              pathSnapshot: string | null;
            }>()
        : Promise.resolve([]),
      tmdbPairs.length
        ? getRepository(FreshMedia).find({
            where: tmdbPairs.map((pair) => ({ ...pair, active: true })),
          })
        : Promise.resolve([]),
      seriesIds.length
        ? getRepository(CanonicalSeason)
            .createQueryBuilder('summary_season')
            .leftJoin(
              'canonical_episode',
              'summary_episode',
              'summary_episode.seasonId = summary_season.id'
            )
            .leftJoin(
              CanonicalSeasonIdentity,
              'summary_season_identity',
              'summary_season_identity.canonicalSeasonId = summary_season.id AND ' +
                'summary_season_identity.provider = :summaryProvider',
              { summaryProvider: 'sonarr' }
            )
            .leftJoin(
              'library_file_episode',
              'summary_link',
              'summary_link.canonicalEpisodeId = summary_episode.id'
            )
            .leftJoin(
              'library_file',
              'summary_file',
              'summary_file.id = summary_link.libraryFileId'
            )
            .leftJoin(
              'library_presence',
              'summary_file_presence',
              `summary_file_presence.id = summary_file.libraryPresenceId AND ` +
                `summary_file_presence.sourceSystem IN ('radarr', 'sonarr')`
            )
            .select('summary_season.seriesId', 'canonicalMediaId')
            .addSelect('summary_season.seasonNumber', 'seasonNumber')
            .addSelect('summary_episode.id', 'episodeId')
            .addSelect('summary_season_identity.id', 'seasonIdentityId')
            .addSelect('summary_file.id', 'fileId')
            .addSelect('summary_file.isCurrent', 'fileIsCurrent')
            .addSelect('summary_file_presence.isCurrent', 'presenceIsCurrent')
            .addSelect('summary_file_presence.servarrHasFile', 'servarrHasFile')
            .where('summary_season.seriesId IN (:...seriesIds)', {
              seriesIds,
            })
            .orderBy('summary_season.seasonNumber', 'ASC')
            .getRawMany<{
              canonicalMediaId: string | number;
              seasonNumber: string | number;
              episodeId: string | number | null;
              seasonIdentityId: string | number | null;
              fileId: string | number | null;
              fileIsCurrent: string | number | boolean | null;
              presenceIsCurrent: string | number | boolean | null;
              servarrHasFile: string | number | boolean | null;
            }>()
        : Promise.resolve([]),
      currentIds.length
        ? getRepository(CanonicalMedia).find({
            where: { id: In(currentIds) },
            relations: { currentMedia: true },
          })
        : Promise.resolve([]),
      currentIds.length
        ? getRepository(CanonicalMediaIdentity).find({
            where: {
              canonicalMediaId: In(currentIds),
              provider: 'jellyfin',
            },
          })
        : Promise.resolve([]),
      currentIds.length
        ? getRepository(LibraryPresence).find({
            where: {
              canonicalMediaId: In(currentIds),
              sourceSystem: 'jellyfin',
              isCurrent: true,
              jellyfinVisible: true,
            },
          })
        : Promise.resolve([]),
      this.loadFileSummaries(
        rows.map((row) => ({
          canonicalMediaId: Number(row.canonicalMediaId),
          libraryStatus: row.libraryStatus,
        }))
      ),
      seriesIds.length
        ? getRepository(CanonicalMedia)
            .createQueryBuilder('requestability_canonical')
            .innerJoin(
              Media,
              'requestability_media',
              `(` +
                `(requestability_canonical."currentMediaId" IS NOT NULL AND requestability_media.id = requestability_canonical."currentMediaId") OR ` +
                `(requestability_canonical."currentMediaId" IS NULL AND ` +
                `requestability_media."tmdbId" = ${tmdbIdSql(
                  'requestability_canonical'
                )} AND requestability_media."mediaType" = 'tv')` +
                `)`
            )
            .leftJoin('requestability_media.seasons', 'requestability_season')
            .select('requestability_canonical.id', 'canonicalMediaId')
            .addSelect('requestability_season.seasonNumber', 'seasonNumber')
            .addSelect('requestability_season.status', 'seasonStatus')
            .where('requestability_canonical.id IN (:...seriesIds)', {
              seriesIds,
            })
            .getRawMany<{
              canonicalMediaId: string | number;
              seasonNumber: string | number | null;
              seasonStatus: string | number | null;
            }>()
        : Promise.resolve([]),
    ]);

    const storageRoots = new Map<
      number,
      { id: number; label: string; color: string | null }[]
    >();
    for (const row of storageRows) {
      const canonicalMediaId = Number(row.canonicalMediaId);
      const roots = storageRoots.get(canonicalMediaId) ?? [];
      const root = new StorageRoot({
        id: Number(row.rootId),
        servarrType: row.servarrType,
        nameSnapshot: row.nameSnapshot,
        displayName: row.displayName,
        color: row.color,
        pathSnapshot: row.pathSnapshot,
      });
      if (!roots.some((candidate) => candidate.id === root.id))
        roots.push({
          id: root.id,
          label: storageRootDisplayLabel(root),
          color: root.color ?? null,
        });
      storageRoots.set(canonicalMediaId, roots);
    }
    for (const roots of storageRoots.values())
      roots.sort(
        (left, right) =>
          left.label.localeCompare(right.label) || left.id - right.id
      );

    const freshKeys = new Set(
      freshRows.map((item) => `${item.mediaType}:${item.tmdbId}`)
    );
    const truthy = (value: string | number | boolean | null) =>
      value === true || value === 1 || value === '1';
    const seasons = new Map<
      string,
      {
        canonicalMediaId: number;
        seasonNumber: number;
        knownEpisodeIds: Set<number>;
        hasReliableKnownEpisodeTotal: boolean;
        currentEpisodeIds: Set<number>;
        historicalEpisodeIds: Set<number>;
      }
    >();
    for (const row of seasonRows) {
      const canonicalMediaId = Number(row.canonicalMediaId);
      const seasonNumber = Number(row.seasonNumber);
      const key = `${canonicalMediaId}:${seasonNumber}`;
      const season = seasons.get(key) ?? {
        canonicalMediaId,
        seasonNumber,
        knownEpisodeIds: new Set<number>(),
        hasReliableKnownEpisodeTotal: false,
        currentEpisodeIds: new Set<number>(),
        historicalEpisodeIds: new Set<number>(),
      };
      const episodeId = row.episodeId === null ? null : Number(row.episodeId);
      if (episodeId !== null) season.knownEpisodeIds.add(episodeId);
      if (row.seasonIdentityId !== null)
        season.hasReliableKnownEpisodeTotal = true;
      if (
        episodeId !== null &&
        row.fileId !== null &&
        row.presenceIsCurrent !== null
      ) {
        season.historicalEpisodeIds.add(episodeId);
        if (
          truthy(row.fileIsCurrent) &&
          truthy(row.presenceIsCurrent) &&
          truthy(row.servarrHasFile)
        )
          season.currentEpisodeIds.add(episodeId);
      }
      seasons.set(key, season);
    }
    const seasonSummaries = new Map<number, LibrarySeasonSummary[]>();
    const requestMediaCanonicalIds = new Set<number>();
    const unavailableRequestSeasonKeys = new Set<string>();
    for (const row of requestMediaRows) {
      const canonicalMediaId = Number(row.canonicalMediaId);
      requestMediaCanonicalIds.add(canonicalMediaId);
      if (
        row.seasonNumber !== null &&
        row.seasonStatus !== null &&
        Number(row.seasonStatus) !== MediaStatus.UNKNOWN &&
        Number(row.seasonStatus) !== MediaStatus.DELETED
      ) {
        unavailableRequestSeasonKeys.add(
          `${canonicalMediaId}:${Number(row.seasonNumber)}`
        );
      }
    }
    for (const season of seasons.values()) {
      const state = season.currentEpisodeIds.size
        ? 'current'
        : season.historicalEpisodeIds.size
          ? 'archive'
          : 'known_missing';
      const summaries = seasonSummaries.get(season.canonicalMediaId) ?? [];
      summaries.push({
        key: `season:${season.canonicalMediaId}:${season.seasonNumber}`,
        seasonNumber: season.seasonNumber,
        isSpecial: season.seasonNumber === 0,
        state,
        availableEpisodeCount:
          state === 'current'
            ? season.currentEpisodeIds.size
            : season.historicalEpisodeIds.size,
        knownEpisodeCount:
          season.hasReliableKnownEpisodeTotal && season.knownEpisodeIds.size > 0
            ? season.knownEpisodeIds.size
            : null,
        resolution:
          fileSummaries.seasons.get(
            `${season.canonicalMediaId}:${season.seasonNumber}`
          ) ?? null,
        requestable: false,
        acquiring: false,
      });
      seasonSummaries.set(season.canonicalMediaId, summaries);
    }
    for (const summaries of seasonSummaries.values())
      summaries.sort((left, right) => left.seasonNumber - right.seasonNumber);

    const currentJellyfinPresenceKeys = new Set(
      jellyfinPresenceRows.map(
        (presence) =>
          `${presence.canonicalMediaId}:${presence.sourceScope}:${presence.sourceItemId}`
      )
    );
    const jellyfinIdentities = new Map<number, LibraryJellyfinIdentity[]>();
    for (const identity of jellyfinIdentityRows) {
      if (
        !currentJellyfinPresenceKeys.has(
          `${identity.canonicalMediaId}:${identity.sourceScope}:${identity.mediaType}:${identity.value}`
        )
      )
        continue;
      const identities =
        jellyfinIdentities.get(identity.canonicalMediaId) ?? [];
      identities.push(identity);
      jellyfinIdentities.set(identity.canonicalMediaId, identities);
    }
    const settings = getSettings();
    const jellyfinPageName =
      settings.main.mediaServerType === MediaServerType.EMBY
        ? 'item'
        : 'details';
    const configuredJellyfinHost =
      settings.jellyfin.externalHostname?.trim() || getHostname();
    const externalLinks = new Map<number, LibraryExternalLink[]>();
    for (const canonical of canonicalRows) {
      const canonicalJellyfinUrl =
        settings.main.mediaServerType === MediaServerType.JELLYFIN ||
        settings.main.mediaServerType === MediaServerType.EMBY
          ? resolveLibraryJellyfinUrl({
              identities: jellyfinIdentities.get(canonical.id) ?? [],
              serverId: settings.jellyfin.serverId,
              hostname: configuredJellyfinHost,
              pageName: jellyfinPageName,
            })
          : null;
      const links = buildLibraryExternalLinks(
        canonical.mediaType,
        canonical.currentMedia,
        canonicalJellyfinUrl
      );
      if (links.length) externalLinks.set(canonical.id, links);
    }
    return {
      storageRoots,
      freshKeys,
      seasonSummaries,
      requestMediaCanonicalIds,
      unavailableRequestSeasonKeys,
      resolutions: fileSummaries.media,
      externalLinks,
    };
  }

  protected async loadFacts(
    rows: RawLibraryRow[],
    canonicalIds: number[]
  ): Promise<PageFacts> {
    const tmdbPairs = rows
      .filter((row) => row.tmdbId !== null)
      .map((row) => ({
        tmdbId: Number(row.tmdbId),
        mediaType:
          row.mediaType === LibraryMediaType.SERIES
            ? MediaType.TV
            : MediaType.MOVIE,
      }));
    const currentIds = rows
      .filter((row) => row.libraryStatus === 'current')
      .map((row) => Number(row.canonicalMediaId));
    const archiveIds = rows
      .filter((row) => row.libraryStatus === 'archive')
      .map((row) => Number(row.canonicalMediaId));
    const [
      states,
      evidence,
      currentEpisodes,
      archiveEpisodes,
      watchlists,
      requesters,
    ] = await Promise.all([
      loadActiveCurrentViewingStatesForMedia(canonicalIds),
      loadLibraryViewingEvidence(canonicalIds),
      this.loadEpisodes(currentIds, 'current'),
      this.loadEpisodes(archiveIds, 'archive'),
      tmdbPairs.length
        ? getRepository(Watchlist).find({
            where: tmdbPairs.map((pair) => ({
              tmdbId: pair.tmdbId,
              mediaType: pair.mediaType,
            })),
            relations: { requestedBy: true },
          })
        : Promise.resolve([]),
      loadLibraryRequesters(canonicalIds),
    ]);
    return {
      states,
      evidence,
      episodes: [...currentEpisodes, ...archiveEpisodes],
      watchlists,
      requesters,
    };
  }

  private async users(explicitUserIds: number[]): Promise<LibraryUser[]> {
    const query = getRepository(User)
      .createQueryBuilder('library_user')
      .select([
        'library_user.id',
        'library_user.username',
        'library_user.jellyfinUsername',
        'library_user.plexUsername',
        'library_user.avatar',
      ])
      .where('library_user.includeInUserMetrics = :included', {
        included: true,
      });
    if (explicitUserIds.length)
      query.orWhere('library_user.id IN (:...explicitUserIds)', {
        explicitUserIds,
      });
    const users = await query.getMany();
    return users
      .map(safeUser)
      .filter((user): user is LibraryUser => Boolean(user))
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  private async filterUsers(
    input: LibraryQuery,
    explicitUserIds: number[]
  ): Promise<LibraryFilterUser[]> {
    const users = await this.users(explicitUserIds);
    if (users.length === 0) return [];
    const scope = input.scope ?? 'current';
    const candidateQuery = this.buildBase({
      ...input,
      userId: undefined,
      userIds: [],
      watchlist: 'any',
      watched: 'any',
      requested: 'any',
    })
      .innerJoin(
        User,
        'library_available_user',
        'library_available_user.id IN (:...availabilityUserIds)',
        { availabilityUserIds: users.map((user) => user.id) }
      )
      .select('library_available_user.id', 'userId')
      .distinct(true);
    applyPeopleFilters(
      candidateQuery,
      input,
      scope,
      [],
      'library_available_user.id',
      candidateQuerySql
    );
    const availableRows = await candidateQuery.getRawMany<{
      userId: number | string;
    }>();
    const availableUserIds = new Set(
      availableRows.map((row) => Number(row.userId))
    );
    return users.map((user) => ({
      ...user,
      available: availableUserIds.has(user.id),
    }));
  }

  public async userAvailability(
    input: LibraryQuery
  ): Promise<LibraryFilterUsersResponse> {
    return {
      users: await this.filterUsers(input, selectedUserIds(input)),
    };
  }

  private async sourceStatus(): Promise<LibrarySourceStatus> {
    const [checkpoints, historicalImport] = await Promise.all([
      getRepository(SourceCheckpoint).find(),
      historicalImportStatus(dataSource.manager),
    ]);
    const current = (stage: string) => {
      const scoped = checkpoints.filter(
        (checkpoint) => checkpoint.stage === stage
      );
      return (
        scoped.length > 0 &&
        scoped.every(
          (checkpoint) => checkpoint.status === SourceCheckpointStatus.CURRENT
        )
      );
    };
    return {
      library: current('current-library') ? 'current' : 'incomplete',
      currentViewing: current('current-viewing') ? 'current' : 'incomplete',
      historicalViewing: checkpoints
        .filter((checkpoint) => checkpoint.stage === 'historical-import')
        .some(
          (checkpoint) => checkpoint.status === SourceCheckpointStatus.CURRENT
        )
        ? 'current'
        : 'incomplete',
      historicalImport,
    };
  }

  private async storageLocations(scope: LibraryScope) {
    const roots = await getRepository(StorageRoot)
      .createQueryBuilder('root')
      .innerJoin(
        LibraryPresence,
        'root_presence',
        'root_presence.storageRootId = root.id'
      )
      .where(
        scope === 'current'
          ? currentPresenceSql('root_presence')
          : scope === 'archive'
            ? historicalStoragePresenceSql('root_presence')
            : `(${currentPresenceSql(
                'root_presence'
              )} OR ${historicalStoragePresenceSql('root_presence')})`
      )
      .setParameters({ current: true, notCurrent: false })
      .orderBy('root.id', 'ASC')
      .getMany();
    return roots
      .map((root) => ({ id: root.id, label: storageRootDisplayLabel(root) }))
      .filter(
        (root, index, values) =>
          values.findIndex((candidate) => candidate.id === root.id) === index
      )
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  private buildPageQuery(input: LibraryQuery, strategy: LibraryQueryStrategy) {
    const sql = querySql(strategy);
    const direction = input.sortDirection.toUpperCase() as 'ASC' | 'DESC';
    const useProjectedPhysicalSort = strategy === 'candidateFacts';
    const order: Record<LibrarySort, string> = {
      title: `LOWER(COALESCE(canonical."titleSnapshot", ''))`,
      added: useProjectedPhysicalSort ? '"addedAt"' : sql.added,
      lastActive: sql.lastActive,
      size: useProjectedPhysicalSort ? '"logicalSizeBytes"' : sql.size,
      removed: useProjectedPhysicalSort ? '"removedAt"' : sql.removed,
      watchedUsers: sql.watchedUserCount,
    };
    return this.buildBase(input, strategy, true)
      .select('canonical.id', 'canonicalMediaId')
      .addSelect(sql.tmdbId, 'tmdbId')
      .addSelect('canonical.mediaType', 'mediaType')
      .addSelect('canonical.titleSnapshot', 'title')
      .addSelect('canonical.year', 'year')
      .addSelect(sql.added, 'addedAt')
      .addSelect(sql.removed, 'removedAt')
      .addSelect(sql.removalSource, 'removalSource')
      .addSelect(sql.size, 'logicalSizeBytes')
      .addSelect(sql.lastActive, 'lastActiveAt')
      .addSelect(sql.watchedUserCount, 'watchedUserCount')
      .addSelect(sql.libraryStatus, 'libraryStatus')
      .orderBy(order[input.sort], direction, 'NULLS LAST')
      .addOrderBy('canonical.id', 'ASC')
      .limit(input.take)
      .offset(input.skip);
  }

  private async executeQuery(
    input: LibraryQuery,
    strategy: LibraryQueryStrategy
  ): Promise<LibraryResultsResponse> {
    const scope = input.scope ?? 'current';
    const pageQuery = this.buildPageQuery(input, strategy);
    const collectionMembership = input.collectionMembership ?? 'any';
    const unknownCount =
      collectionMembership === 'any'
        ? Promise.resolve(undefined)
        : this.buildBase(
            {
              ...input,
              mediaType: LibraryMediaType.MOVIE,
              collectionMembership: 'any',
            },
            strategy
          )
            .andWhere('canonical.collectionMembershipHydratedAt IS NULL')
            .getCount();
    const [
      rows,
      total,
      sourceStatus,
      storageLocations,
      collectionMembershipUnknownCount,
    ] = await Promise.all([
      pageQuery.getRawMany<RawLibraryRow>(),
      this.buildBase(input, strategy).getCount(),
      this.sourceStatus(),
      this.storageLocations(scope),
      unknownCount,
    ]);
    if (rows.length === 0) {
      return {
        pageInfo: {
          pages: Math.ceil(total / input.take),
          page: Math.floor(input.skip / input.take) + 1,
          results: total,
          pageSize: input.take,
        },
        results: [],
        storageLocations,
        sourceStatus,
        collectionMembershipUnknownCount,
      };
    }
    const canonicalIds = rows.map((row) => Number(row.canonicalMediaId));
    const [facts, removalSchedules, enrichments] = await Promise.all([
      this.loadFacts(rows, canonicalIds),
      getRepository(RemovalSchedule).find({
        where: {
          canonicalMediaId: In(canonicalIds),
          status: In([
            RemovalScheduleStatus.ACTIVE,
            RemovalScheduleStatus.DEFERRED,
          ]),
        },
        order: { removeAt: 'ASC', id: 'ASC' },
      }),
      this.loadPageEnrichments(rows),
    ]);
    const presentationKeys = [
      ...new Map(
        rows.flatMap((row) => {
          const tmdbId = row.tmdbId === null ? null : Number(row.tmdbId);
          return tmdbId && Number.isSafeInteger(tmdbId) && tmdbId > 0
            ? [
                [
                  `${row.mediaType}:${tmdbId}`,
                  { mediaType: row.mediaType, tmdbId },
                ] as const,
              ]
            : [];
        })
      ).values(),
    ];
    let presentations = new Map<string, LibraryPresentation>();
    let presentationStatus: LibraryPresentationBatchStatus | undefined;
    if (this.dependencies.presentationCoordinator) {
      const prepared = this.dependencies.presentationCoordinator.prepare(
        presentationKeys,
        input.locale ?? 'en'
      );
      presentations = prepared.presentations;
      presentationStatus = prepared.status;
    } else {
      let failures = 0;
      await mapBounded(presentationKeys, 4, async ({ mediaType, tmdbId }) => {
        try {
          presentations.set(
            `${mediaType}:${tmdbId}`,
            await this.dependencies.fetchPresentation(
              mediaType,
              tmdbId,
              input.locale ?? 'en'
            )
          );
        } catch {
          failures++;
        }
      });
      presentationStatus = {
        state: failures > 0 ? 'partial' : 'complete',
        revision: 0,
        pendingCount: 0,
      };
    }
    const results = rows.map((row): LibraryItem => {
      const canonicalMediaId = Number(row.canonicalMediaId);
      const tmdbId = row.tmdbId === null ? null : Number(row.tmdbId);
      const presentation = tmdbId
        ? presentations.get(`${row.mediaType}:${tmdbId}`)
        : undefined;
      const mediaStates = facts.states.filter(
        (state) => state.canonicalMediaId === canonicalMediaId
      );
      const mediaEvidence = facts.evidence.filter(
        (item) => item.canonicalMediaId === canonicalMediaId
      );
      const mediaEpisodes = facts.episodes.filter(
        (episode) => episode.canonicalMediaId === canonicalMediaId
      );
      const { watchedUsers, hasWatchedDetail, lastActiveUsers } =
        aggregateLibraryWatched({
          mediaType: row.mediaType,
          states: mediaStates,
          evidence: mediaEvidence,
          episodes: mediaEpisodes,
          scope: row.libraryStatus,
          authoritativeLastActiveAt: row.lastActiveAt,
        });
      const watchlistUsers = [
        ...new Map(
          facts.watchlists
            .filter(
              (watchlist) =>
                watchlist.tmdbId === tmdbId &&
                watchlist.mediaType ===
                  (row.mediaType === LibraryMediaType.SERIES
                    ? MediaType.TV
                    : MediaType.MOVIE)
            )
            .map((watchlist) => safeUser(watchlist.requestedBy))
            .filter((user): user is LibraryUser => Boolean(user))
            .map((user) => [user.id, user])
        ).values(),
      ].sort((left, right) =>
        left.displayName.localeCompare(right.displayName)
      );
      const requesters = facts.requesters.get(canonicalMediaId) ?? [];
      const activelyRequestedSeasonNumbers =
        activeLibraryRequestSeasonNumbers(requesters);
      return {
        canonicalMediaId,
        tmdbId,
        mediaType: row.mediaType,
        libraryState: row.libraryStatus,
        title:
          presentation?.title.trim() || row.title?.trim() || 'Unknown title',
        year:
          presentation?.year ?? (row.year === null ? null : Number(row.year)),
        posterPath: presentation?.posterPath ?? null,
        backdropPath: presentation?.backdropPath ?? null,
        addedAt: dateString(row.addedAt),
        removedAt: dateString(row.removedAt),
        removalSource: row.removalSource,
        logicalSizeBytes:
          row.logicalSizeBytes === null ? null : String(row.logicalSizeBytes),
        resolution: enrichments.resolutions.get(canonicalMediaId) ?? null,
        watchlistUsers,
        watchedUsers,
        watchedUserCount: Number(row.watchedUserCount) || 0,
        hasWatchedDetail,
        lastActiveAt: dateString(row.lastActiveAt),
        lastActiveUsers,
        requesters,
        storageRoots: enrichments.storageRoots.get(canonicalMediaId) ?? [],
        fresh:
          tmdbId !== null &&
          enrichments.freshKeys.has(
            `${row.mediaType === LibraryMediaType.SERIES ? 'tv' : 'movie'}:${tmdbId}`
          ),
        seasonSummaries: (
          enrichments.seasonSummaries.get(canonicalMediaId) ?? []
        )
          .filter((season) =>
            isLibrarySeasonVisible(
              season,
              presentation?.seasons,
              new Date().toISOString().slice(0, 10)
            )
          )
          .map((season) => ({
            ...season,
            requestable:
              enrichments.requestMediaCanonicalIds.has(canonicalMediaId) &&
              !enrichments.unavailableRequestSeasonKeys.has(
                `${canonicalMediaId}:${season.seasonNumber}`
              ) &&
              !activelyRequestedSeasonNumbers.has(season.seasonNumber),
            acquiring:
              season.state === 'known_missing' &&
              activelyRequestedSeasonNumbers.has(season.seasonNumber),
          })),
        externalLinks:
          row.libraryStatus === 'current'
            ? (enrichments.externalLinks.get(canonicalMediaId) ?? [])
            : [],
        tmdbRating:
          presentation?.voteAverage !== null &&
          presentation?.voteAverage !== undefined &&
          presentation.voteCount !== null &&
          presentation.voteCount !== undefined
            ? {
                voteAverage: presentation.voteAverage,
                voteCount: presentation.voteCount,
              }
            : null,
        collection: presentation?.collection ?? null,
        removalSchedules: removalSchedules
          .filter((schedule) => schedule.canonicalMediaId === canonicalMediaId)
          .map((schedule) => ({
            id: schedule.id,
            canonicalMediaId: schedule.canonicalMediaId,
            targetType: schedule.targetType,
            seasonNumber: schedule.seasonNumber ?? null,
            origin: schedule.origin,
            status: schedule.status as 'active' | 'deferred',
            scheduledAt: schedule.scheduledAt.toISOString(),
            removeAt: schedule.removeAt.toISOString(),
            revision: schedule.revision,
          })),
      };
    });
    return {
      pageInfo: {
        pages: Math.ceil(total / input.take),
        page: Math.floor(input.skip / input.take) + 1,
        results: total,
        pageSize: input.take,
      },
      results,
      storageLocations,
      sourceStatus,
      collectionMembershipUnknownCount,
      presentation: presentationStatus,
    };
  }

  public async query(input: LibraryQuery): Promise<LibraryResultsResponse> {
    return this.executeQuery(input, 'legacy');
  }

  public async queryCandidateForParity(
    input: LibraryQuery
  ): Promise<LibraryResultsResponse> {
    return this.executeQuery(input, 'candidateFacts');
  }

  public async seriesDetail(
    canonicalMediaId: number
  ): Promise<LibrarySeriesDetailResponse | null> {
    const media = await getRepository(CanonicalMedia).findOneBy({
      id: canonicalMediaId,
      mediaType: LibraryMediaType.SERIES,
    });
    if (!media) return null;
    const current =
      (await getRepository(LibraryPresence)
        .createQueryBuilder('detail_presence')
        .where('detail_presence.canonicalMediaId = :canonicalMediaId', {
          canonicalMediaId,
        })
        .andWhere(currentPresenceSql('detail_presence'))
        .setParameters({ current: true })
        .getCount()) > 0;
    const historical =
      current ||
      (await getRepository(LibraryPresence).countBy({
        canonicalMediaId,
        isCurrent: false,
      })) > 0;
    if (!historical) return null;
    const scope: Exclude<LibraryScope, 'all'> = current ? 'current' : 'archive';
    const [episodes, fileSummaries] = await Promise.all([
      this.loadEpisodes([canonicalMediaId], scope),
      this.loadFileSummaries(
        [{ canonicalMediaId, libraryStatus: scope }],
        true
      ),
    ]);
    const [unfilteredStates, evidence, seasonRemovalFacts] = await Promise.all([
      getRepository(CurrentViewingState).find({
        where: { canonicalMediaId },
        relations: { viewer: { user: true } },
      }),
      getRepository(ViewingEvidence).find({
        where: { canonicalMediaId },
        relations: { viewer: { user: true } },
      }),
      this.loadSeasonRemovalFacts(canonicalMediaId),
    ]);
    const states = current
      ? await filterActiveCurrentViewingStates(unfilteredStates)
      : [];
    const facts = collectLibraryActivityFacts({
      mediaType: LibraryMediaType.SERIES,
      states,
      evidence,
      episodes,
      completionScope: scope === 'current' ? 'current' : 'historical',
    });
    const seasons = [
      ...new Set(episodes.map((episode) => episode.seasonNumber)),
    ]
      .sort((left, right) => left - right)
      .map((seasonNumber) => {
        const seasonEpisodes = episodes.filter(
          (episode) => episode.seasonNumber === seasonNumber
        );
        const seasonEpisodeIds = new Set(
          seasonEpisodes.map((episode) => episode.canonicalEpisodeId)
        );
        const seasonActivityFacts = collectLibraryActivityFacts({
          mediaType: LibraryMediaType.SERIES,
          states,
          evidence,
          episodes: seasonEpisodes,
          completionScope: scope === 'current' ? 'current' : 'historical',
        });
        const users = [...facts.values()]
          .flatMap((fact): LibrarySeasonWatchedUser[] => {
            const watchedEpisodeCount = [...fact.completedEpisodeIds].filter(
              (episodeId) => seasonEpisodeIds.has(episodeId)
            ).length;
            return watchedEpisodeCount > 0
              ? [
                  {
                    key: fact.key,
                    userId: fact.userId,
                    displayName: fact.displayName,
                    avatar: fact.avatar,
                    watchedEpisodeCount,
                    watchedPercentage: percentage(
                      watchedEpisodeCount,
                      seasonEpisodeIds.size
                    ),
                    lastViewedAt: dateString(
                      seasonActivityFacts.get(fact.key)?.watchedAt
                    ),
                  },
                ]
              : [];
          })
          .sort((left, right) =>
            left.displayName.localeCompare(right.displayName)
          );
        return {
          seasonNumber,
          isSpecial: seasonEpisodes.every(
            (episode) => episode.isSpecial || episode.seasonNumber <= 0
          ),
          availableEpisodeCount: seasonEpisodeIds.size,
          resolution:
            fileSummaries.seasons.get(`${canonicalMediaId}:${seasonNumber}`) ??
            null,
          sizeBytes:
            fileSummaries.seasonSizes.get(
              `${canonicalMediaId}:${seasonNumber}`
            ) ?? null,
          removedAt: seasonRemovalFacts.get(seasonNumber)?.removedAt ?? null,
          removalSource:
            seasonRemovalFacts.get(seasonNumber)?.removalSource ?? null,
          users,
        };
      });
    const removalSchedules = await getRepository(RemovalSchedule).find({
      where: {
        canonicalMediaId,
        status: In([
          RemovalScheduleStatus.ACTIVE,
          RemovalScheduleStatus.DEFERRED,
        ]),
      },
      order: { removeAt: 'ASC', id: 'ASC' },
    });
    return {
      canonicalMediaId,
      seasons,
      removalSchedules: removalSchedules.map((schedule) => ({
        id: schedule.id,
        canonicalMediaId: schedule.canonicalMediaId,
        targetType: schedule.targetType,
        seasonNumber: schedule.seasonNumber ?? null,
        origin: schedule.origin,
        status: schedule.status as 'active' | 'deferred',
        scheduledAt: schedule.scheduledAt.toISOString(),
        removeAt: schedule.removeAt.toISOString(),
        revision: schedule.revision,
      })),
    };
  }
}

export default new LibraryService();
