import {
  LibraryMediaType,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import {
  UserMediaIntentEndReason,
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
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { Watchlist } from '@server/entity/Watchlist';
import { getSeasonViewingProjection } from '@server/lib/libraryViewingProjection';
import { In } from 'typeorm';

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

interface ConfirmedMovieCompletion {
  evidenceId: number;
  userId: number;
  tmdbId: number;
  completedAt: Date;
}

const confirmedMovieCompletions = async (
  active: UserMediaIntentOccurrence[],
  manager = dataSource.manager
): Promise<ConfirmedMovieCompletion[]> => {
  const activeTmdbIds = [...new Set(active.map((row) => String(row.tmdbId)))];
  const identities = await manager
    .getRepository(CanonicalMediaIdentity)
    .findBy({
      provider: 'tmdb',
      sourceScope: '',
      mediaType: LibraryMediaType.MOVIE,
      value: In(activeTmdbIds),
    });
  if (identities.length === 0) return [];
  const tmdbByCanonical = new Map(
    identities.map((identity) => [
      identity.canonicalMediaId,
      Number(identity.value),
    ])
  );
  const evidence = await manager.getRepository(ViewingEvidence).find({
    where: {
      completionClassification: ViewingCompletionClassification.CONFIRMED,
      canonicalMediaId: In([...tmdbByCanonical.keys()]),
    },
    relations: { viewer: true },
    order: { observedAt: 'ASC', id: 'ASC' },
  });
  const activeUsers = new Set(active.map((row) => row.userId));
  return evidence.flatMap((row) => {
    const tmdbId = Number(tmdbByCanonical.get(row.canonicalMediaId ?? -1));
    const userId = Number(row.viewer?.userId);
    const evidenceId = row.id;
    const completedAt = row.observedEndAt ?? row.observedAt;
    return Number.isSafeInteger(tmdbId) &&
      tmdbId > 0 &&
      Number.isSafeInteger(userId) &&
      userId > 0 &&
      activeUsers.has(userId) &&
      Number.isSafeInteger(evidenceId) &&
      completedAt &&
      !Number.isNaN(completedAt.getTime())
      ? [{ evidenceId, userId, tmdbId, completedAt }]
      : [];
  });
};

/**
 * Closes only active Movie intent occurrences backed by exact CONFIRMED
 * completion evidence observed after that occurrence began.
 */
export const satisfyConfirmedMovieWatchlistIntents =
  async (): Promise<number> =>
    dataSource.transaction(async (manager) => {
      const occurrenceRepository = manager.getRepository(
        UserMediaIntentOccurrence
      );
      const active = await occurrenceRepository.findBy({
        intentType: UserMediaIntentType.WATCHLIST,
        state: UserMediaIntentState.ACTIVE,
        mediaType: MediaType.MOVIE,
      });
      if (active.length === 0) return 0;
      const completions = await confirmedMovieCompletions(active, manager);
      const byIdentity = new Map<string, ConfirmedMovieCompletion[]>();
      for (const completion of completions) {
        const key = `${completion.userId}:${completion.tmdbId}`;
        const values = byIdentity.get(key) ?? [];
        values.push(completion);
        byIdentity.set(key, values);
      }

      let satisfied = 0;
      for (const occurrence of active) {
        const completion = byIdentity
          .get(`${occurrence.userId}:${occurrence.tmdbId}`)
          ?.find((item) => item.completedAt >= occurrence.startedAt);
        if (!completion) continue;
        const update = await occurrenceRepository.update(
          { id: occurrence.id, state: UserMediaIntentState.ACTIVE },
          {
            state: UserMediaIntentState.SATISFIED,
            endedAt: completion.completedAt,
            endReason: UserMediaIntentEndReason.CONFIRMED_COMPLETION,
            completionEvidenceId: completion.evidenceId,
          }
        );
        if (!update.affected) continue;
        await manager.getRepository(Watchlist).delete({
          requestedBy: { id: occurrence.userId },
          mediaType: occurrence.mediaType,
          tmdbId: occurrence.tmdbId,
        });
        satisfied++;
      }
      return satisfied;
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
