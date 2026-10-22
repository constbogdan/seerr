import type { WatchlistLibraryStatusFilter } from '@server/constants/watchlist';
import type { Watchlist } from '@server/entity/Watchlist';
import {
  currentLibraryPresenceSql,
  everPhysicalLibraryMembershipSql,
} from '@server/lib/libraryActivity';
import type { SelectQueryBuilder } from 'typeorm';

const physicalTrueParameter = ':watchlistPhysicalTrue';

export const watchlistCanonicalMediaIdSql = (watchlistAlias: string): string =>
  `COALESCE(` +
  `(SELECT library_status_identity."canonicalMediaId" FROM "canonical_media_identity" library_status_identity WHERE ` +
  `library_status_identity."provider" = 'tmdb' AND library_status_identity."sourceScope" = '' AND ` +
  `library_status_identity."mediaType" = CASE WHEN ${watchlistAlias}."mediaType" = 'tv' THEN 'series' ELSE 'movie' END AND ` +
  `library_status_identity."value" = CAST(${watchlistAlias}."tmdbId" AS VARCHAR) LIMIT 1), ` +
  `(SELECT library_status_canonical.id FROM "canonical_media" library_status_canonical ` +
  `INNER JOIN "media" library_status_media ON library_status_media.id = library_status_canonical."currentMediaId" WHERE ` +
  `library_status_canonical."mediaType" = CASE WHEN ${watchlistAlias}."mediaType" = 'tv' THEN 'series' ELSE 'movie' END AND ` +
  `library_status_media."mediaType" = ${watchlistAlias}."mediaType" AND ` +
  `library_status_media."tmdbId" = ${watchlistAlias}."tmdbId" LIMIT 1))`;

export const watchlistLibraryStatusSql = (
  watchlistAlias: string,
  libraryStatus: Exclude<WatchlistLibraryStatusFilter, 'any'>
): string => {
  const canonicalMediaId = watchlistCanonicalMediaIdSql(watchlistAlias);
  const currentPhysical =
    `EXISTS (SELECT 1 FROM "library_presence" library_status_current WHERE ` +
    `library_status_current."canonicalMediaId" = (${canonicalMediaId}) AND ` +
    `${currentLibraryPresenceSql(
      'library_status_current',
      physicalTrueParameter
    )})`;
  const everPhysical = everPhysicalLibraryMembershipSql(
    `(${canonicalMediaId})`,
    physicalTrueParameter
  );

  if (libraryStatus === 'active') return currentPhysical;
  if (libraryStatus === 'archived')
    return `(NOT (${currentPhysical}) AND ${everPhysical})`;
  return `NOT (${everPhysical})`;
};

export const applyWatchlistLibraryStatusFilter = (
  queryBuilder: SelectQueryBuilder<Watchlist>,
  libraryStatus: WatchlistLibraryStatusFilter,
  watchlistAlias = 'watchlist'
): SelectQueryBuilder<Watchlist> => {
  if (libraryStatus === 'any') return queryBuilder;
  return queryBuilder
    .andWhere(watchlistLibraryStatusSql(watchlistAlias, libraryStatus))
    .setParameter('watchlistPhysicalTrue', true);
};
