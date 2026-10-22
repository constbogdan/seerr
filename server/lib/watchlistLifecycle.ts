import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import {
  UserMediaIntentState,
  UserMediaIntentType,
} from '@server/constants/watchlist';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalMediaIdentity,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { UserMediaIntentOccurrence } from '@server/entity/UserMediaIntentOccurrence';
import { Viewer } from '@server/entity/Viewer';
import { Watchlist } from '@server/entity/Watchlist';
import { getSeasonViewingProjection } from '@server/lib/libraryViewingProjection';

export const WATCHLIST_HISTORY_PAGE_SIZE = 20;

export interface WatchlistHistoryQuery {
  userId: number;
  page: number;
  state?: UserMediaIntentState;
}

export interface WatchlistHistoryResponse {
  page: number;
  totalPages: number;
  totalResults: number;
  results: {
    id: number;
    mediaType: MediaType;
    tmdbId: number;
    state: UserMediaIntentState;
    startedAt: string;
    endedAt?: string;
    endReason?: string;
    completionEvidenceId?: number;
  }[];
}

/**
 * Keeps the active compatibility projection and durable lifecycle projection
 * aligned. Production migrations perform the same exact-identity backfill;
 * this idempotent startup reconciliation also covers development databases,
 * where TypeORM schema synchronization creates new tables without running
 * migrations.
 */
export const ensureActiveWatchlistIntentOccurrences =
  async (): Promise<number> =>
    dataSource.transaction(async (manager) => {
      const missing = await manager
        .getRepository(Watchlist)
        .createQueryBuilder('watchlist')
        .innerJoinAndSelect('watchlist.requestedBy', 'owner')
        .leftJoin(
          UserMediaIntentOccurrence,
          'occurrence',
          'occurrence.userId = watchlist.requestedById AND occurrence.intentType = :intentType AND occurrence.mediaType = watchlist.mediaType AND occurrence.tmdbId = watchlist.tmdbId AND occurrence.state = :state',
          {
            intentType: UserMediaIntentType.WATCHLIST,
            state: UserMediaIntentState.ACTIVE,
          }
        )
        .where('occurrence.id IS NULL')
        .getMany();
      if (missing.length === 0) return 0;
      await manager.getRepository(UserMediaIntentOccurrence).save(
        missing.map(
          (watchlist) =>
            new UserMediaIntentOccurrence({
              userId: watchlist.requestedBy.id,
              user: watchlist.requestedBy,
              intentType: UserMediaIntentType.WATCHLIST,
              mediaType: watchlist.mediaType,
              tmdbId: watchlist.tmdbId,
              state: UserMediaIntentState.ACTIVE,
              startedAt: watchlist.createdAt,
              createdAt: watchlist.createdAt,
              updatedAt: watchlist.updatedAt,
            })
        )
      );
      return missing.length;
    });

export const getWatchlistHistory = async ({
  userId,
  page,
  state,
}: WatchlistHistoryQuery): Promise<WatchlistHistoryResponse> => {
  const query = getRepository(UserMediaIntentOccurrence)
    .createQueryBuilder('occurrence')
    .where('occurrence.userId = :userId', { userId })
    .andWhere('occurrence.intentType = :intentType', {
      intentType: UserMediaIntentType.WATCHLIST,
    });
  if (state) query.andWhere('occurrence.state = :state', { state });
  query
    .orderBy('occurrence.startedAt', 'DESC')
    .addOrderBy('occurrence.id', 'DESC')
    .skip((page - 1) * WATCHLIST_HISTORY_PAGE_SIZE)
    .take(WATCHLIST_HISTORY_PAGE_SIZE);
  const [rows, totalResults] = await query.getManyAndCount();
  return {
    page,
    totalPages: Math.max(
      1,
      Math.ceil(totalResults / WATCHLIST_HISTORY_PAGE_SIZE)
    ),
    totalResults,
    results: rows.map((row) => ({
      id: row.id,
      mediaType: row.mediaType,
      tmdbId: row.tmdbId,
      state: row.state,
      startedAt: row.startedAt.toISOString(),
      ...(row.endedAt && { endedAt: row.endedAt.toISOString() }),
      ...(row.endReason && { endReason: row.endReason }),
      ...(row.completionEvidenceId && {
        completionEvidenceId: row.completionEvidenceId,
      }),
    })),
  };
};

export const getSeriesSeasonWatchlistScope = async ({
  userId,
  tmdbId,
  seasonNumber,
}: {
  userId: number;
  tmdbId: number;
  seasonNumber: number;
}): Promise<{
  activeSeriesIntent: boolean;
  availableComplete: boolean;
  airedCaughtUp: boolean;
}> => {
  const activeSeriesIntent = await getRepository(
    UserMediaIntentOccurrence
  ).exist({
    where: {
      userId,
      intentType: UserMediaIntentType.WATCHLIST,
      mediaType: MediaType.TV,
      tmdbId,
      state: UserMediaIntentState.ACTIVE,
    },
  });
  const identity = await getRepository(CanonicalMediaIdentity).findOneBy({
    provider: 'tmdb',
    sourceScope: '',
    mediaType: LibraryMediaType.SERIES,
    value: String(tmdbId),
  });
  if (!identity) {
    return {
      activeSeriesIntent,
      availableComplete: false,
      airedCaughtUp: false,
    };
  }
  const season = await getRepository(CanonicalSeason).findOneBy({
    seriesId: identity.canonicalMediaId,
    seasonNumber,
  });
  if (!season) {
    return {
      activeSeriesIntent,
      availableComplete: false,
      airedCaughtUp: false,
    };
  }
  const viewers = await getRepository(Viewer).findBy({ userId });
  const viewerIds = new Set(viewers.map((viewer) => viewer.id));
  const projection = await getSeasonViewingProjection(season.id);
  return {
    activeSeriesIntent,
    availableComplete: projection.completedByAvailable.some((id) =>
      viewerIds.has(id)
    ),
    airedCaughtUp: projection.caughtUpByAired.some((id) => viewerIds.has(id)),
  };
};
