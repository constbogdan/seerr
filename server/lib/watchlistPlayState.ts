import JellyfinAPI, {
  MAX_JELLYFIN_ITEM_IDS,
  type JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import dataSource, { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';

const USER_CONCURRENCY = 2;
const STARTUP_RETRY_DELAY_MS = 5_000;
const STARTUP_RETRY_LIMIT = 12;

export const isRetryableWatchlistStartupError = (error: unknown): boolean =>
  error instanceof Error &&
  /transaction is not started|cannot start a transaction within a transaction|SQLITE_BUSY/i.test(
    error.message
  );

export interface WatchlistPlayStateProjection {
  played: boolean | null;
  lastPlayedAt: Date | null;
}

export const normalizeExactJellyfinId = (
  value?: string | null
): string | null => {
  const normalized = value?.replaceAll('-', '').trim().toLowerCase();
  return normalized && /^[0-9a-f]{32}$/.test(normalized) ? normalized : null;
};

export const deriveWatchlistPlayState = ({
  mediaType,
  items,
}: {
  mediaType: MediaType;
  items: JellyfinLibraryItemExtended[];
}): WatchlistPlayStateProjection => {
  const withUserData = items.filter((item) => item.UserData);
  if (withUserData.length === 0) {
    return { played: null, lastPlayedAt: null };
  }

  const eligible =
    mediaType === MediaType.TV
      ? withUserData.filter(
          (item) => item.Type === 'Series' && (item.RecursiveItemCount ?? 0) > 0
        )
      : withUserData.filter((item) => item.Type === 'Movie');
  if (eligible.length === 0) {
    return { played: null, lastPlayedAt: null };
  }

  const playedItems = eligible.filter((item) => item.UserData?.Played === true);
  const played = playedItems.length > 0;
  const lastPlayedAt = played
    ? (playedItems
        .map((item) => item.UserData?.LastPlayedDate)
        .filter((date): date is string => Boolean(date))
        .map((date) => new Date(date))
        .filter((date) => !Number.isNaN(date.getTime()))
        .sort((left, right) => right.getTime() - left.getTime())[0] ?? null)
    : null;

  return { played, lastPlayedAt };
};

const chunks = <T>(values: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
};

const runBounded = async <T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<void> => {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (index < values.length) {
        const current = values[index++];
        await worker(current);
      }
    })
  );
};

interface WatchlistPlayStateClient {
  getUserItems: JellyfinAPI['getUserItems'];
}

interface PendingUpdate extends WatchlistPlayStateProjection {
  id: number;
  syncedAt: Date | null;
  userId: string | null;
}

export class WatchlistPlayStateSync {
  private inFlight?: Promise<number>;
  private cancelled = false;

  constructor(
    private readonly clientFactory: () => Promise<WatchlistPlayStateClient> = async () => {
      const settings = getSettings();
      const admin = await getRepository(User).findOne({
        where: { id: 1 },
        select: ['id', 'jellyfinDeviceId'],
      });
      return new JellyfinAPI(
        getHostname(),
        settings.jellyfin.apiKey,
        admin?.jellyfinDeviceId ?? ''
      );
    }
  ) {}

  public running(): boolean {
    return Boolean(this.inFlight);
  }

  public cancel(): void {
    this.cancelled = true;
  }

  public async run(): Promise<number> {
    if (this.inFlight) {
      return this.inFlight;
    }
    this.cancelled = false;
    this.inFlight = this.reconcile().finally(() => {
      this.inFlight = undefined;
      this.cancelled = false;
    });
    return this.inFlight;
  }

  public startCatchUp(): void {
    const mediaServerType = getSettings().main.mediaServerType;
    if (
      mediaServerType !== MediaServerType.JELLYFIN &&
      mediaServerType !== MediaServerType.EMBY
    ) {
      return;
    }
    const attempt = (remainingRetries: number) => {
      void this.run().catch((error) => {
        if (remainingRetries > 0 && isRetryableWatchlistStartupError(error)) {
          logger.warn(
            'Watchlist play-state startup sync was deferred by database activity',
            {
              label: 'Watchlist Play State',
              retryDelayMs: STARTUP_RETRY_DELAY_MS,
              remainingRetries,
            }
          );
          setTimeout(
            () => attempt(remainingRetries - 1),
            STARTUP_RETRY_DELAY_MS
          );
          return;
        }
        logger.error('Watchlist play-state startup sync failed', {
          label: 'Watchlist Play State',
          errorMessage:
            error instanceof Error ? error.message : 'Unknown sync error',
        });
      });
    };
    setImmediate(() => attempt(STARTUP_RETRY_LIMIT));
  }

  private async reconcile(): Promise<number> {
    const rows = await getRepository(Watchlist)
      .createQueryBuilder('watchlist')
      .leftJoinAndSelect('watchlist.requestedBy', 'requestedBy')
      .leftJoinAndSelect('watchlist.media', 'media')
      .addSelect('watchlist.jellyfinPlayStateUserId')
      .orderBy('requestedBy.id', 'ASC')
      .addOrderBy('watchlist.id', 'ASC')
      .getMany();
    if (rows.length === 0) {
      return 0;
    }

    const byUser = new Map<
      string,
      { userIds: Set<number>; rows: Watchlist[] }
    >();
    const unknownUpdates: PendingUpdate[] = [];
    for (const row of rows) {
      const jellyfinUserId = normalizeExactJellyfinId(
        row.requestedBy.jellyfinUserId
      );
      if (!jellyfinUserId) {
        unknownUpdates.push({
          id: row.id,
          played: null,
          lastPlayedAt: null,
          syncedAt: null,
          userId: null,
        });
        continue;
      }
      const group = byUser.get(jellyfinUserId) ?? {
        userIds: new Set<number>(),
        rows: [],
      };
      group.userIds.add(row.requestedBy.id);
      group.rows.push(row);
      byUser.set(jellyfinUserId, group);
    }

    const updates = [...unknownUpdates];
    const groups = [...byUser.entries()];
    const client = groups.length > 0 ? await this.clientFactory() : undefined;
    await runBounded(groups, USER_CONCURRENCY, async ([userId, group]) => {
      if (this.cancelled) return;
      if (group.userIds.size !== 1) {
        logger.error('Ambiguous Jellyfin user mapping blocks Watchlist sync', {
          label: 'Watchlist Play State',
          mappedSeerrUsers: group.userIds.size,
        });
        updates.push(
          ...group.rows.map((row) => ({
            id: row.id,
            played: null,
            lastPlayedAt: null,
            syncedAt: null,
            userId: null,
          }))
        );
        return;
      }

      const rowsWithIds = group.rows.map((row) => ({
        row,
        ids: [
          ...new Set(
            [row.media?.jellyfinMediaId, row.media?.jellyfinMediaId4k]
              .map(normalizeExactJellyfinId)
              .filter((id): id is string => Boolean(id))
          ),
        ],
      }));
      const allIds = [...new Set(rowsWithIds.flatMap(({ ids }) => ids))];
      const itemsById = new Map<string, JellyfinLibraryItemExtended>();
      try {
        for (const batch of chunks(allIds, MAX_JELLYFIN_ITEM_IDS)) {
          if (this.cancelled) return;
          if (batch.length === 0) continue;
          const items = await client!.getUserItems({
            ids: batch,
            userId,
            fields: ['ProviderIds', 'RecursiveItemCount'],
          });
          for (const item of items) {
            const id = normalizeExactJellyfinId(item.Id);
            if (id) itemsById.set(id, item);
          }
        }
      } catch (error) {
        logger.warn('Unable to reconcile Watchlist play state for a user', {
          label: 'Watchlist Play State',
          errorMessage:
            error instanceof Error ? error.message : 'Unknown provider error',
        });
        updates.push(
          ...group.rows
            .filter(
              (row) =>
                row.jellyfinPlayStateUserId !== null &&
                row.jellyfinPlayStateUserId !== undefined &&
                row.jellyfinPlayStateUserId !== userId
            )
            .map((row) => ({
              id: row.id,
              played: null,
              lastPlayedAt: null,
              syncedAt: null,
              userId: null,
            }))
        );
        return;
      }

      const syncedAt = new Date();
      for (const { row, ids } of rowsWithIds) {
        if (ids.length === 0) {
          updates.push({
            id: row.id,
            played: null,
            lastPlayedAt: null,
            syncedAt,
            userId,
          });
          continue;
        }
        const matched = ids
          .map((id) => itemsById.get(id))
          .filter((item): item is JellyfinLibraryItemExtended => Boolean(item));
        const projection = deriveWatchlistPlayState({
          mediaType: row.mediaType,
          items: matched,
        });
        if (
          matched.some((item) => item.UserData?.Played === true) &&
          matched.some((item) => item.UserData?.Played === false)
        ) {
          logger.info('Jellyfin versions disagree on Watchlist play state', {
            label: 'Watchlist Play State',
            mediaType: row.mediaType,
            tmdbId: row.tmdbId,
          });
        }
        updates.push({ id: row.id, ...projection, syncedAt, userId });
      }
    });

    if (this.cancelled || updates.length === 0) {
      return 0;
    }
    await dataSource.transaction(async (manager) => {
      for (const update of updates) {
        await manager.update(
          Watchlist,
          { id: update.id },
          {
            jellyfinPlayed: update.played,
            jellyfinLastPlayedAt: update.lastPlayedAt,
            jellyfinPlayStateSyncedAt: update.syncedAt,
            jellyfinPlayStateUserId: update.userId,
          }
        );
      }
    });
    return updates.length;
  }
}

const watchlistPlayStateSync = new WatchlistPlayStateSync();

export default watchlistPlayStateSync;
