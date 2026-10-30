import dataSource from '@server/datasource';

// Mirrors logicalJellyfinPreference and the Library count projection guards.
// This is a correlated predicate, not another provider read or a page filter.
export const libraryPreferenceExistsSql = (
  identity: string,
  userIds: number[] = [],
  userIdExpression?: string,
  postgres = dataSource.options.type === 'postgres'
): string => {
  const normalized = (value: string) =>
    `LOWER(TRIM(REPLACE(${value}, '-', '')))`;
  const validId = (value: string) =>
    postgres
      ? `${value} ~ '^[0-9a-f]{32}$'`
      : `(LENGTH(${value}) = 32 AND ${value} NOT GLOB '*[^0-9a-f]*')`;
  const stored = 'preference."jellyfinPreferenceItemIds"';
  const split = postgres
    ? `regexp_split_to_table(${stored}, ',') AS stored_id(value)`
    : `json_each(CASE WHEN json_valid('["' || REPLACE(${stored}, ',', '","') || '"]') THEN '["' || REPLACE(${stored}, ',', '","') || '"]' ELSE '[]' END) AS stored_id`;
  const aggregate = (rows: string) =>
    postgres
      ? `(SELECT STRING_AGG(binding_id, ',' ORDER BY binding_id) FROM (${rows}) preference_ids)`
      : `(SELECT GROUP_CONCAT(binding_id, ',') FROM (${rows} ORDER BY binding_id) preference_ids)`;
  const storedIds = aggregate(
    `SELECT DISTINCT stored_id.value AS binding_id FROM ${split} WHERE ${validId('stored_id.value')}`
  );
  const presence =
    `binding_presence."canonicalMediaId" = canonical.id ` +
    `AND binding_presence."sourceSystem" = 'jellyfin' ` +
    `AND binding_presence."sourceScope" = :preferenceSourceScope ` +
    `AND binding_presence."isCurrent" = :current ` +
    `AND binding_presence."jellyfinVisible" = :current`;
  const itemId = normalized(
    `SUBSTR(binding_presence."sourceItemId", LENGTH(canonical."mediaType") + 2)`
  );
  const currentIds = aggregate(
    `SELECT DISTINCT ${itemId} AS binding_id FROM "library_presence" binding_presence ` +
      `WHERE ${presence} AND SUBSTR(binding_presence."sourceItemId", 1, LENGTH(canonical."mediaType") + 1) = canonical."mediaType" || ':' AND ${validId(itemId)}`
  );
  const user = userIdExpression
    ? ` AND preference."userId" = ${userIdExpression}`
    : userIds.length
      ? ' AND preference."userId" IN (:...userIds)'
      : '';
  return (
    `EXISTS (SELECT 1 FROM "user_media_state" preference ` +
    `INNER JOIN "user" preference_user ON preference_user.id = preference."userId" ` +
    `WHERE preference."tmdbId" = ${identity} ` +
    `AND preference."mediaType" = CASE WHEN canonical."mediaType" = 'series' THEN 'tv' ELSE 'movie' END ` +
    `AND preference."jellyfinLikes" = :preferenceLiked ` +
    `AND preference."jellyfinPreferenceObservedAt" IS NOT NULL ` +
    `AND preference."jellyfinPreferenceSourceScope" = :preferenceSourceScope ` +
    `AND preference_user."includeInUserMetrics" = :current ` +
    `AND ${validId(normalized('preference_user."jellyfinUserId"'))} ` +
    `AND preference."jellyfinPreferenceUserId" = ${normalized('preference_user."jellyfinUserId"')} ` +
    `AND NOT EXISTS (SELECT 1 FROM "user" duplicate_user WHERE duplicate_user.id <> preference_user.id ` +
    `AND ${normalized('duplicate_user."jellyfinUserId"')} = ${normalized('preference_user."jellyfinUserId"')}) ` +
    `AND ${stored} <> '' AND ${stored} = ${storedIds} ` +
    `AND (NOT EXISTS (SELECT 1 FROM "library_presence" binding_presence WHERE ${presence}) ` +
    `OR ${stored} = ${currentIds})${user})`
  );
};
