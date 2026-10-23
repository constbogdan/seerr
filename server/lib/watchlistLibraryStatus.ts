import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import type { WatchlistLibraryStatusFilter } from '@server/constants/watchlist';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import Media from '@server/entity/Media';
import type { Watchlist } from '@server/entity/Watchlist';
import {
  currentLibraryPresenceSql,
  everPhysicalLibraryMembershipSql,
} from '@server/lib/libraryActivity';
import type { SelectQueryBuilder } from 'typeorm';

const physicalTrueParameter = ':watchlistPhysicalTrue';
const movieStatusBatchSize = 400;

export type MovieLibraryStatus = Exclude<WatchlistLibraryStatusFilter, 'any'>;

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

const validMovieTmdbIds = (tmdbIds: number[]): number[] =>
  [...new Set(tmdbIds)].filter(
    (tmdbId) => Number.isSafeInteger(tmdbId) && tmdbId > 0
  );

export const movieLibraryStatusCaseSql = (
  canonicalMediaIdExpression: string,
  trueExpression = ':movieStatusTrue'
): string => {
  const currentPhysical =
    `EXISTS (SELECT 1 FROM "library_presence" movie_status_current WHERE ` +
    `movie_status_current."canonicalMediaId" = ${canonicalMediaIdExpression} AND ` +
    `${currentLibraryPresenceSql('movie_status_current', trueExpression)})`;
  const everPhysical = everPhysicalLibraryMembershipSql(
    canonicalMediaIdExpression,
    trueExpression
  );

  return (
    `CASE WHEN ${currentPhysical} THEN 'active' ` +
    `WHEN ${everPhysical} THEN 'archived' ELSE 'absent' END`
  );
};

/**
 * Classifies exact Movie TMDB identities using the same physical-current and
 * retained-history predicates as the Watchlist Library Status filter.
 *
 * Missing canonical evidence is deliberately `absent`. Exact canonical TMDB
 * identities take precedence over the compatibility link through current
 * Seerr Media. Queries are chunked below SQLite's parameter limit and remain
 * portable to PostgreSQL.
 */
export const classifyMovieLibraryStatusByTmdbIds = async (
  tmdbIds: number[]
): Promise<Map<number, MovieLibraryStatus>> => {
  const validIds = validMovieTmdbIds(tmdbIds);
  const result = new Map<number, MovieLibraryStatus>(
    validIds.map((tmdbId) => [tmdbId, 'absent'])
  );

  for (
    let offset = 0;
    offset < validIds.length;
    offset += movieStatusBatchSize
  ) {
    const chunk = validIds.slice(offset, offset + movieStatusBatchSize);
    const values = chunk.map(String);
    const canonicalIdByTmdbId = new Map<number, number>();

    const identityRows = await getRepository(CanonicalMediaIdentity)
      .createQueryBuilder('identity')
      .select('identity.value', 'tmdbId')
      .addSelect('identity.canonicalMediaId', 'canonicalMediaId')
      .where('identity.provider = :provider', { provider: 'tmdb' })
      .andWhere('identity.sourceScope = :sourceScope', { sourceScope: '' })
      .andWhere('identity.mediaType = :mediaType', {
        mediaType: LibraryMediaType.MOVIE,
      })
      .andWhere('identity.value IN (:...values)', { values })
      .getRawMany<{ tmdbId: string; canonicalMediaId: number | string }>();

    for (const row of identityRows) {
      const tmdbId = Number(row.tmdbId);
      const canonicalMediaId = Number(row.canonicalMediaId);
      if (
        result.has(tmdbId) &&
        Number.isSafeInteger(canonicalMediaId) &&
        canonicalMediaId > 0
      ) {
        canonicalIdByTmdbId.set(tmdbId, canonicalMediaId);
      }
    }

    const unresolved = chunk.filter(
      (tmdbId) => !canonicalIdByTmdbId.has(tmdbId)
    );
    if (unresolved.length > 0) {
      const fallbackRows = await getRepository(CanonicalMedia)
        .createQueryBuilder('canonical')
        .innerJoin(Media, 'media', 'media.id = canonical.currentMediaId')
        .select('media.tmdbId', 'tmdbId')
        .addSelect('canonical.id', 'canonicalMediaId')
        .where('canonical.mediaType = :canonicalMediaType', {
          canonicalMediaType: LibraryMediaType.MOVIE,
        })
        .andWhere('media.mediaType = :mediaType', {
          mediaType: MediaType.MOVIE,
        })
        .andWhere('media.tmdbId IN (:...tmdbIds)', { tmdbIds: unresolved })
        .getRawMany<{
          tmdbId: number | string;
          canonicalMediaId: number | string;
        }>();

      for (const row of fallbackRows) {
        const tmdbId = Number(row.tmdbId);
        const canonicalMediaId = Number(row.canonicalMediaId);
        if (
          result.has(tmdbId) &&
          Number.isSafeInteger(canonicalMediaId) &&
          canonicalMediaId > 0
        ) {
          canonicalIdByTmdbId.set(tmdbId, canonicalMediaId);
        }
      }
    }

    const canonicalIds = [...new Set(canonicalIdByTmdbId.values())];
    if (canonicalIds.length === 0) continue;

    const statusRows = await getRepository(CanonicalMedia)
      .createQueryBuilder('canonical')
      .select('canonical.id', 'canonicalMediaId')
      .addSelect(movieLibraryStatusCaseSql('canonical.id'), 'libraryStatus')
      .where('canonical.id IN (:...canonicalIds)', { canonicalIds })
      .andWhere('canonical.mediaType = :mediaType', {
        mediaType: LibraryMediaType.MOVIE,
      })
      .setParameter('movieStatusTrue', true)
      .getRawMany<{
        canonicalMediaId: number | string;
        libraryStatus: MovieLibraryStatus;
      }>();
    const statusByCanonicalId = new Map(
      statusRows.map((row) => [Number(row.canonicalMediaId), row.libraryStatus])
    );

    for (const [tmdbId, canonicalMediaId] of canonicalIdByTmdbId) {
      result.set(tmdbId, statusByCanonicalId.get(canonicalMediaId) ?? 'absent');
    }
  }

  return result;
};
