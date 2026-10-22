import { ViewingCompletionClassification } from '@server/constants/libraryHistory';
import type { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { normalizeJellyfinActivityDate } from '@server/lib/jellyfinViewingSource';

export const physicalLibraryPresenceSql = (
  alias: string,
  trueExpression = ':current'
) =>
  `((` +
  `${alias}."sourceSystem" IN ('radarr', 'sonarr') AND ` +
  `${alias}."servarrHasFile" = ${trueExpression}) OR (` +
  `${alias}."sourceSystem" = 'jellyfin' AND ` +
  `${alias}."jellyfinVisible" = ${trueExpression}))`;

export const currentLibraryPresenceSql = (
  alias: string,
  currentExpression = ':current'
) =>
  `(${alias}."isCurrent" = ${currentExpression} AND ${physicalLibraryPresenceSql(
    alias,
    currentExpression
  )})`;

export const everPhysicalLibraryMembershipSql = (
  canonicalMediaIdExpression: string,
  trueExpression = ':current'
) =>
  `(EXISTS (SELECT 1 FROM "library_presence" library_physical_history WHERE ` +
  `library_physical_history."canonicalMediaId" = ${canonicalMediaIdExpression} AND ` +
  `${physicalLibraryPresenceSql(
    'library_physical_history',
    trueExpression
  )}) OR EXISTS (SELECT 1 FROM "library_file" library_physical_file ` +
  `INNER JOIN "library_presence" library_physical_file_presence ON ` +
  `library_physical_file_presence.id = library_physical_file."libraryPresenceId" WHERE ` +
  `library_physical_file_presence."canonicalMediaId" = ${canonicalMediaIdExpression}))`;

export const qualifyingLibraryEvidenceSql = (alias: string) =>
  `(${alias}."completionClassification" IN (` +
  `${ViewingCompletionClassification.CONFIRMED}, ` +
  `${ViewingCompletionClassification.LIKELY}, ` +
  `${ViewingCompletionClassification.PARTIAL}) OR (` +
  `${alias}."completionClassification" = ${ViewingCompletionClassification.UNKNOWN} AND (` +
  `COALESCE(${alias}."progressBasisPoints", 0) > 0 OR ` +
  `COALESCE(${alias}."playbackDurationSeconds", 0) > 0 OR ` +
  `${alias}."sourceClass" = 'historical-manual-activity')))`;

export const nonSentinelLibraryActivitySql = (expression: string) =>
  `(${expression} IS NOT NULL AND ${expression} NOT IN (` +
  `'1970-01-01 00:00:00', '1970-01-01 00:00:00.000', ` +
  `'1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z'))`;

export const isQualifyingLibraryEvidence = (
  evidence: Pick<
    ViewingEvidence,
    | 'completionClassification'
    | 'progressBasisPoints'
    | 'playbackDurationSeconds'
    | 'sourceClass'
  >
): boolean =>
  [
    ViewingCompletionClassification.CONFIRMED,
    ViewingCompletionClassification.LIKELY,
    ViewingCompletionClassification.PARTIAL,
  ].includes(evidence.completionClassification) ||
  (evidence.completionClassification ===
    ViewingCompletionClassification.UNKNOWN &&
    ((evidence.progressBasisPoints ?? 0) > 0 ||
      (evidence.playbackDurationSeconds ?? 0) > 0 ||
      evidence.sourceClass === 'historical-manual-activity'));

export const normalizeLibraryDatabaseDate = (
  value: string | Date | null | undefined
): Date | null => {
  if (!value) return null;
  const normalized =
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
  return normalizeJellyfinActivityDate(normalized);
};

export const currentLibraryAddedSql = ({
  canonicalAlias = 'canonical',
  currentExpression = ':current',
}: {
  canonicalAlias?: string;
  currentExpression?: string;
} = {}) =>
  `COALESCE(` +
  `(SELECT MIN(library_file."importedAt") FROM "library_file" library_file ` +
  `INNER JOIN "library_presence" library_file_presence ON library_file_presence.id = library_file."libraryPresenceId" ` +
  `WHERE library_file_presence."canonicalMediaId" = ${canonicalAlias}.id AND library_file."isCurrent" = ${currentExpression} ` +
  `AND library_file_presence."isCurrent" = ${currentExpression} AND library_file_presence."sourceSystem" IN ('radarr', 'sonarr') ` +
  `AND library_file_presence."servarrHasFile" = ${currentExpression}), ` +
  `(SELECT MIN(library_presence."addedAt") FROM "library_presence" library_presence WHERE ` +
  `library_presence."canonicalMediaId" = ${canonicalAlias}.id AND ${currentLibraryPresenceSql(
    'library_presence',
    currentExpression
  )}), ` +
  `(SELECT MIN(library_observed."firstObservedAt") FROM "library_presence" library_observed WHERE ` +
  `library_observed."canonicalMediaId" = ${canonicalAlias}.id AND ${currentLibraryPresenceSql(
    'library_observed',
    currentExpression
  )}))`;

const currentAvailableEpisodeScopeSql = (
  activityAlias: string,
  canonicalAlias: string,
  currentExpression: string
) =>
  `(${canonicalAlias}."mediaType" = 'movie' OR EXISTS (` +
  `SELECT 1 FROM "library_file_episode" activity_link ` +
  `INNER JOIN "library_file" activity_file ON activity_file.id = activity_link."libraryFileId" ` +
  `INNER JOIN "library_presence" activity_presence ON activity_presence.id = activity_file."libraryPresenceId" ` +
  `WHERE activity_link."canonicalEpisodeId" = ${activityAlias}."canonicalEpisodeId" ` +
  `AND activity_presence."canonicalMediaId" = ${canonicalAlias}.id ` +
  `AND activity_file."isCurrent" = ${currentExpression} ` +
  `AND activity_presence."isCurrent" = ${currentExpression} ` +
  `AND activity_presence."sourceSystem" IN ('radarr', 'sonarr') ` +
  `AND activity_presence."servarrHasFile" = ${currentExpression}))`;

const activeCurrentStateSql = (
  activityAlias: string,
  canonicalAlias: string,
  currentExpression: string
) =>
  `((` +
  `${activityAlias}."mediaType" = 'movie' AND EXISTS (SELECT 1 FROM "library_presence" active_movie WHERE ` +
  `active_movie."canonicalMediaId" = ${activityAlias}."canonicalMediaId" AND active_movie."sourceSystem" = 'jellyfin' ` +
  `AND active_movie."sourceScope" = ${activityAlias}."sourceScope" AND active_movie."sourceItemId" = 'movie:' || ${activityAlias}."sourceItemId" ` +
  `AND active_movie."isCurrent" = ${currentExpression} AND active_movie."jellyfinVisible" = ${currentExpression})) OR (` +
  `${activityAlias}."mediaType" = 'episode' AND EXISTS (SELECT 1 FROM "canonical_episode_identity" active_episode WHERE ` +
  `active_episode."canonicalEpisodeId" = ${activityAlias}."canonicalEpisodeId" AND active_episode."provider" = 'jellyfin' ` +
  `AND active_episode."sourceScope" = ${activityAlias}."sourceScope" AND active_episode."value" = ${activityAlias}."sourceItemId") ` +
  `AND EXISTS (SELECT 1 FROM "library_presence" active_series WHERE active_series."canonicalMediaId" = ${activityAlias}."canonicalMediaId" ` +
  `AND active_series."sourceSystem" = 'jellyfin' AND active_series."sourceScope" = ${activityAlias}."sourceScope" ` +
  `AND active_series."isCurrent" = ${currentExpression} AND active_series."jellyfinVisible" = ${currentExpression})))`;

const seasonScopeSql = (
  activityAlias: string,
  canonicalAlias: string,
  seasonNumber?: number
) => {
  if (seasonNumber === undefined) return '';
  if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
    throw new Error('Invalid Season activity scope');
  }
  return (
    ` AND EXISTS (SELECT 1 FROM "canonical_episode" scoped_episode ` +
    `INNER JOIN "canonical_season" scoped_season ON scoped_season.id = scoped_episode."seasonId" ` +
    `WHERE scoped_episode.id = ${activityAlias}."canonicalEpisodeId" ` +
    `AND scoped_season."seriesId" = ${canonicalAlias}.id ` +
    `AND scoped_season."seasonNumber" = ${seasonNumber})`
  );
};

export const currentLibraryLastActiveSql = ({
  canonicalAlias = 'canonical',
  currentExpression = ':current',
  seasonNumber,
}: {
  canonicalAlias?: string;
  currentExpression?: string;
  seasonNumber?: number;
} = {}) => {
  const stateSeason = seasonScopeSql(
    'active_state',
    canonicalAlias,
    seasonNumber
  );
  const evidenceSeason = seasonScopeSql(
    'active_evidence',
    canonicalAlias,
    seasonNumber
  );
  return (
    `(SELECT MAX(library_activity.activity_at) FROM (` +
    `SELECT active_state."lastPlayedAt" AS activity_at FROM "current_viewing_state" active_state WHERE ` +
    `active_state."canonicalMediaId" = ${canonicalAlias}.id AND ` +
    `(active_state."played" = ${currentExpression} OR COALESCE(active_state."progressBasisPoints", 0) > 0) ` +
    `AND ${activeCurrentStateSql(
      'active_state',
      canonicalAlias,
      currentExpression
    )} AND ${currentAvailableEpisodeScopeSql(
      'active_state',
      canonicalAlias,
      currentExpression
    )} ` +
    `AND ${nonSentinelLibraryActivitySql(
      'active_state."lastPlayedAt"'
    )}${stateSeason} ` +
    `UNION ALL SELECT COALESCE(active_evidence."observedEndAt", active_evidence."observedAt") AS activity_at ` +
    `FROM "viewing_evidence" active_evidence WHERE active_evidence."canonicalMediaId" = ${canonicalAlias}.id ` +
    `AND ${qualifyingLibraryEvidenceSql(
      'active_evidence'
    )} AND ${currentAvailableEpisodeScopeSql(
      'active_evidence',
      canonicalAlias,
      currentExpression
    )} ` +
    `AND ${nonSentinelLibraryActivitySql(
      'COALESCE(active_evidence."observedEndAt", active_evidence."observedAt")'
    )}${evidenceSeason}` +
    `) library_activity)`
  );
};
