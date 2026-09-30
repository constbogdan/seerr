import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { UserMediaState } from '@server/entity/UserMediaState';
import { Watchlist } from '@server/entity/Watchlist';
import {
  WatchlistPlayStateSync,
  deriveWatchlistPlayState,
  isRetryableWatchlistStartupError,
  normalizeExactJellyfinId,
} from '@server/lib/watchlistPlayState';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const USER_ID = '11111111111111111111111111111111';
const MOVIE_ID = '22222222222222222222222222222222';

const item = ({
  id = MOVIE_ID,
  type = 'Movie',
  played,
  recursiveItemCount,
  lastPlayedDate,
}: {
  id?: string;
  type?: 'Movie' | 'Series';
  played: boolean;
  recursiveItemCount?: number;
  lastPlayedDate?: string;
}): JellyfinLibraryItemExtended =>
  ({
    Id: id,
    Name: 'Fixture',
    Type: type,
    LocationType: 'FileSystem',
    HasSubtitles: false,
    MediaType: 'Video',
    ProviderIds: { Tmdb: '10' },
    RecursiveItemCount: recursiveItemCount,
    UserData: {
      Played: played,
      LastPlayedDate: lastPlayedDate,
      PlaybackPositionTicks: 0,
      PlayCount: played ? 1 : 0,
      IsFavorite: false,
      Key: id,
      ItemId: id,
    },
  }) as JellyfinLibraryItemExtended;

setupTestDb();

const createRow = async ({
  mediaType = MediaType.MOVIE,
  jellyfinMediaId = MOVIE_ID,
  jellyfinMediaId4k,
  tmdbId = 10,
  requestedBy,
}: {
  mediaType?: MediaType;
  jellyfinMediaId?: string | null;
  jellyfinMediaId4k?: string | null;
  tmdbId?: number;
  requestedBy?: User;
} = {}): Promise<Watchlist> => {
  const user =
    requestedBy ?? (await getRepository(User).findOneByOrFail({ id: 1 }));
  if (!requestedBy) {
    user.jellyfinUserId = USER_ID;
    await getRepository(User).save(user);
  }
  const media = await getRepository(Media).save(
    new Media({
      tmdbId,
      mediaType,
      jellyfinMediaId,
      jellyfinMediaId4k,
    })
  );
  const row = await getRepository(Watchlist).save(
    new Watchlist({
      ratingKey: '',
      tmdbId,
      mediaType,
      title: 'Fixture',
      requestedBy: user,
      media,
    })
  );
  await getRepository(UserMediaState).save(
    new UserMediaState({ user, mediaType, tmdbId, media })
  );
  return row;
};

const stateFor = async (
  row: Watchlist,
  includeBinding = false
): Promise<UserMediaState> => {
  const query = getRepository(UserMediaState)
    .createQueryBuilder('state')
    .leftJoinAndSelect('state.media', 'media')
    .where('state.userId = :userId', { userId: row.requestedBy.id })
    .andWhere('state.mediaType = :mediaType', { mediaType: row.mediaType })
    .andWhere('state.tmdbId = :tmdbId', { tmdbId: row.tmdbId });
  if (includeBinding) query.addSelect('state.jellyfinPlayStateUserId');
  return query.getOneOrFail();
};

describe('Watchlist play-state projection', () => {
  it('normalizes only exact Jellyfin GUID identities', () => {
    assert.equal(
      normalizeExactJellyfinId('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'),
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    );
    assert.equal(normalizeExactJellyfinId('not-an-id'), null);
    assert.equal(normalizeExactJellyfinId(null), null);
  });

  it('retries only recognized startup transaction contention', () => {
    assert.equal(
      isRetryableWatchlistStartupError(
        new Error('Transaction is not started yet, start transaction first')
      ),
      true
    );
    assert.equal(
      isRetryableWatchlistStartupError(
        new Error('cannot start a transaction within a transaction')
      ),
      true
    );
    assert.equal(
      isRetryableWatchlistStartupError(
        new Error('SQLITE_BUSY: database locked')
      ),
      true
    );
    assert.equal(
      isRetryableWatchlistStartupError(new Error('Unauthorized')),
      false
    );
    assert.equal(
      isRetryableWatchlistStartupError('provider unavailable'),
      false
    );
  });

  it('uses exact movie UserData and the newest valid played timestamp', () => {
    const projection = deriveWatchlistPlayState({
      mediaType: MediaType.MOVIE,
      items: [
        item({ played: false }),
        item({
          id: '33333333333333333333333333333333',
          played: true,
          lastPlayedDate: '2026-09-01T10:00:00.000Z',
        }),
      ],
    });
    assert.equal(projection.played, true);
    assert.equal(
      projection.lastPlayedAt?.toISOString(),
      '2026-09-01T10:00:00.000Z'
    );
  });

  it('uses series-level caught-up state and rejects zero-content series', () => {
    assert.deepEqual(
      deriveWatchlistPlayState({
        mediaType: MediaType.TV,
        items: [item({ type: 'Series', played: true, recursiveItemCount: 0 })],
      }),
      { played: null, lastPlayedAt: null }
    );
    assert.equal(
      deriveWatchlistPlayState({
        mediaType: MediaType.TV,
        items: [item({ type: 'Series', played: true, recursiveItemCount: 8 })],
      }).played,
      true
    );
    assert.equal(
      deriveWatchlistPlayState({
        mediaType: MediaType.TV,
        items: [item({ type: 'Series', played: false, recursiveItemCount: 9 })],
      }).played,
      false
    );
  });
});

describe('Watchlist play-state reconciliation', () => {
  beforeEach(async () => {
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    user.jellyfinUserId = null;
    await getRepository(User).save(user);
  });

  it('hydrates already-watched membership and then follows mark-unwatched', async () => {
    const row = await createRow();
    let played = true;
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => [item({ played })],
    }));

    assert.equal(await sync.run(), 1);
    let stored = await stateFor(row);
    assert.equal(stored.jellyfinPlayed, true);
    assert.ok(stored.jellyfinPlayStateSyncedAt);

    played = false;
    assert.equal(await sync.run(), 1);
    stored = await stateFor(row);
    assert.equal(stored.jellyfinPlayed, false);
    assert.equal(stored.jellyfinLastPlayedAt, null);
    assert.equal(await getRepository(Watchlist).count(), 1);
  });

  it('treats either exact normal or 4K movie version as watched', async () => {
    const fourKId = '33333333333333333333333333333333';
    const row = await createRow({ jellyfinMediaId4k: fourKId });
    let requestedIds: string[] = [];
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async ({ ids }) => {
        requestedIds = ids;
        return [item({ played: false }), item({ id: fourKId, played: true })];
      },
    }));

    await sync.run();
    assert.deepEqual(new Set(requestedIds), new Set([MOVIE_ID, fourKId]));
    const stored = await stateFor(row);
    assert.equal(stored.jellyfinPlayed, true);
  });

  it('tracks current series caught-up state without changing membership', async () => {
    const row = await createRow({ mediaType: MediaType.TV });
    let caughtUp = true;
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => [
        item({
          type: 'Series',
          played: caughtUp,
          recursiveItemCount: caughtUp ? 8 : 9,
        }),
      ],
    }));

    await sync.run();
    assert.equal((await stateFor(row)).jellyfinPlayed, true);
    caughtUp = false;
    await sync.run();
    assert.equal((await stateFor(row)).jellyfinPlayed, false);
    assert.equal(await getRepository(Watchlist).count(), 1);
  });

  it('never creates membership from Jellyfin state alone', async () => {
    let clientCreated = false;
    const sync = new WatchlistPlayStateSync(async () => {
      clientCreated = true;
      return { getUserItems: async () => [item({ played: true })] };
    });

    assert.equal(await sync.run(), 0);
    assert.equal(clientCreated, false);
    assert.equal(await getRepository(Watchlist).count(), 0);
  });

  it('keeps a same-title movie unknown when no exact Jellyfin identity maps to its TMDB identity', async () => {
    const row = await createRow({
      tmdbId: 1050035,
      jellyfinMediaId: null,
    });
    let providerCalls = 0;
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => {
        providerCalls += 1;
        return [
          {
            ...item({ played: true }),
            Name: 'Monster',
            ProviderIds: { Tmdb: '1203484', Imdb: 'tt29941084' },
          },
        ];
      },
    }));

    assert.equal(await sync.run(), 1);
    assert.equal(providerCalls, 0);
    assert.equal((await stateFor(row)).jellyfinPlayed, null);
  });

  it('fails closed when more than one Seerr user maps to the same Jellyfin ID', async () => {
    const first = await getRepository(User).findOneByOrFail({ id: 1 });
    first.jellyfinUserId = USER_ID;
    await getRepository(User).save(first);
    await createRow({ requestedBy: first, tmdbId: 10 });
    const second = await getRepository(User).save(
      new User({ email: 'duplicate-jellyfin@example.test', avatar: '' })
    );
    second.jellyfinUserId = '11111111-1111-1111-1111-111111111111';
    await getRepository(User).save(second);
    await createRow({ requestedBy: second, tmdbId: 11 });
    let providerCalls = 0;
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => {
        providerCalls += 1;
        return [item({ played: true })];
      },
    }));

    assert.equal(await sync.run(), 2);
    assert.equal(providerCalls, 0);
    const rows = await getRepository(UserMediaState).find({
      order: { id: 'ASC' },
    });
    assert.deepEqual(
      rows.map((row) => row.jellyfinPlayed),
      [null, null]
    );
  });

  it('preserves last-known state on provider failure', async () => {
    const row = await createRow();
    const state = await stateFor(row);
    state.jellyfinPlayed = true;
    state.jellyfinLastPlayedAt = new Date('2026-08-01T00:00:00.000Z');
    state.jellyfinPlayStateSyncedAt = new Date('2026-08-02T00:00:00.000Z');
    await getRepository(UserMediaState).save(state);
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => {
        throw new Error('provider unavailable');
      },
    }));

    assert.equal(await sync.run(), 0);
    const stored = await stateFor(row);
    assert.equal(stored.jellyfinPlayed, true);
    assert.equal(
      stored.jellyfinPlayStateSyncedAt?.toISOString(),
      '2026-08-02T00:00:00.000Z'
    );
  });

  it('invalidates cached state from a different Jellyfin account on failure', async () => {
    const row = await createRow();
    const state = await stateFor(row, true);
    state.jellyfinPlayed = true;
    state.jellyfinLastPlayedAt = new Date('2026-08-01T00:00:00.000Z');
    state.jellyfinPlayStateSyncedAt = new Date('2026-08-02T00:00:00.000Z');
    state.jellyfinPlayStateUserId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await getRepository(UserMediaState).save(state);
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => {
        throw new Error('provider unavailable');
      },
    }));

    assert.equal(await sync.run(), 1);
    const stored = await stateFor(row, true);
    assert.equal(stored.jellyfinPlayed, null);
    assert.equal(stored.jellyfinLastPlayedAt, null);
    assert.equal(stored.jellyfinPlayStateSyncedAt, null);
    assert.equal(stored.jellyfinPlayStateUserId, null);
  });

  it('does not recreate a row deleted while provider evidence is in flight', async () => {
    const row = await createRow();
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => {
        await getRepository(Watchlist).delete(row.id);
        return [item({ played: true })];
      },
    }));

    await sync.run();
    assert.equal(await getRepository(Watchlist).count(), 0);
    assert.equal(await getRepository(UserMediaState).count(), 1);
    assert.equal((await stateFor(row)).jellyfinPlayed, true);
  });

  it('preserves watched state across Watchlist removal and immediate re-add', async () => {
    const row = await createRow();
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => [item({ played: true })],
    }));
    await sync.run();

    await getRepository(Watchlist).delete(row.id);
    assert.equal(await getRepository(Watchlist).count(), 0);
    assert.equal((await stateFor(row)).jellyfinPlayed, true);

    await getRepository(Watchlist).save(
      new Watchlist({
        ratingKey: '',
        tmdbId: row.tmdbId,
        mediaType: row.mediaType,
        title: row.title,
        requestedBy: row.requestedBy,
        media: row.media,
      })
    );
    assert.equal((await stateFor(row)).jellyfinPlayed, true);
  });

  it('isolates the same typed media identity between users', async () => {
    const first = await getRepository(User).findOneByOrFail({ id: 1 });
    first.jellyfinUserId = USER_ID;
    await getRepository(User).save(first);
    const second = await getRepository(User).save(
      new User({
        email: 'isolated-state@example.test',
        avatar: '',
        jellyfinUserId: '33333333333333333333333333333333',
      })
    );
    const firstRow = await createRow({ requestedBy: first, tmdbId: 44 });
    const secondRow = await createRow({ requestedBy: second, tmdbId: 44 });
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async ({ userId }) => [
        item({ played: userId === USER_ID }),
      ],
    }));

    await sync.run();
    assert.equal((await stateFor(firstRow)).jellyfinPlayed, true);
    assert.equal((await stateFor(secondRow)).jellyfinPlayed, false);
  });

  it('enriches shared media only with the authenticated user state', async () => {
    const first = await getRepository(User).findOneByOrFail({ id: 1 });
    const second = await getRepository(User).save(
      new User({ email: 'private-state@example.test', avatar: '' })
    );
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 45, mediaType: MediaType.MOVIE })
    );
    await getRepository(UserMediaState).save([
      new UserMediaState({
        user: first,
        media,
        mediaType: MediaType.MOVIE,
        tmdbId: 45,
        jellyfinPlayed: true,
      }),
      new UserMediaState({
        user: second,
        media,
        mediaType: MediaType.MOVIE,
        tmdbId: 45,
        jellyfinPlayed: false,
      }),
    ]);

    assert.equal(
      (await Media.getMedia(45, MediaType.MOVIE, first))?.watchState,
      'watched'
    );
    assert.equal(
      (await Media.getMedia(45, MediaType.MOVIE, second))?.watchState,
      'not_watched'
    );
    assert.equal(
      (await Media.getMedia(45, MediaType.MOVIE))?.watchState,
      undefined
    );
  });

  it('relinks preserved state when its Media row is reconstructed', async () => {
    const row = await createRow();
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async ({ ids }) =>
        ids.map((id) => item({ id, played: true })),
    }));
    await sync.run();
    await getRepository(Media).delete(row.media!.id);
    const replacementId = '44444444444444444444444444444444';
    const replacement = await getRepository(Media).save(
      new Media({
        tmdbId: row.tmdbId,
        mediaType: row.mediaType,
        jellyfinMediaId: replacementId,
      })
    );

    await sync.run();
    const state = await stateFor(row);
    assert.equal(state.media?.id, replacement.id);
    assert.equal(state.jellyfinPlayed, true);
  });

  it('logs bounded aggregate results without provider secrets or raw identities', async (t) => {
    await createRow();
    const info = t.mock.method(logger, 'info', () => logger);
    const warn = t.mock.method(logger, 'warn', () => logger);
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => {
        throw new Error(
          'request failed with token=super-secret at https://private.example.test'
        );
      },
    }));

    assert.equal(await sync.run(), 0);
    const infoCalls = info.mock.calls as unknown as {
      arguments: unknown[];
    }[];
    const warnCalls = warn.mock.calls as unknown as {
      arguments: unknown[];
    }[];
    const completion = infoCalls.find(
      (call) => call.arguments[0] === 'Watchlist play-state sync completed'
    );
    assert.ok(completion);
    assert.equal(
      (completion.arguments[1] as Record<string, unknown>).stateRecords,
      1
    );
    assert.equal(
      (completion.arguments[1] as Record<string, unknown>).unknown,
      1
    );
    assert.deepEqual(
      Object.keys(completion.arguments[1] as Record<string, unknown>).sort(),
      [
        'durationMs',
        'failures',
        'idsQueried',
        'label',
        'mappedMedia',
        'notWatched',
        'stateRecords',
        'unknown',
        'unmappedMedia',
        'unmappedUsers',
        'updated',
        'usersConsidered',
        'watched',
      ]
    );
    const emitted = JSON.stringify({
      info: infoCalls.map((call) => call.arguments),
      warn: warnCalls.map((call) => call.arguments),
    });
    assert.doesNotMatch(emitted, /super-secret|private\.example|22222222/);
    assert.match(emitted, /"failures":1/);
  });

  it('coalesces overlapping runs into one provider request', async () => {
    await createRow();
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => {
        calls += 1;
        await gate;
        return [item({ played: false })];
      },
    }));

    const first = sync.run();
    const second = sync.run();
    release?.();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  });

  it('batches exact IDs and bounds concurrent Jellyfin users', async () => {
    const users = [await getRepository(User).findOneByOrFail({ id: 1 })];
    users.push(
      await getRepository(User).save(
        new User({ email: 'batch-two@example.test', avatar: '' })
      ),
      await getRepository(User).save(
        new User({ email: 'batch-three@example.test', avatar: '' })
      )
    );
    for (const [index, user] of users.entries()) {
      user.jellyfinUserId = `${index + 1}`.repeat(32);
      await getRepository(User).save(user);
    }

    const media: Media[] = [];
    const rows: Watchlist[] = [];
    for (let index = 0; index < 103; index += 1) {
      const itemId = (index + 100).toString(16).padStart(32, '0');
      const owner = index < 101 ? users[0] : users[index - 100];
      const mediaRow = new Media({
        tmdbId: 1000 + index,
        mediaType: MediaType.MOVIE,
        jellyfinMediaId: itemId,
      });
      media.push(mediaRow);
      rows.push(
        new Watchlist({
          ratingKey: '',
          tmdbId: 1000 + index,
          mediaType: MediaType.MOVIE,
          title: `Batch ${index}`,
          requestedBy: owner,
          media: mediaRow,
        })
      );
    }
    await getRepository(Media).save(media);
    await getRepository(Watchlist).save(rows);

    const batchSizes: number[] = [];
    let activeUsers = 0;
    let maximumActiveUsers = 0;
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async ({ ids }) => {
        batchSizes.push(ids.length);
        activeUsers += 1;
        maximumActiveUsers = Math.max(maximumActiveUsers, activeUsers);
        await new Promise<void>((resolve) => setImmediate(resolve));
        activeUsers -= 1;
        return ids.map((id) => item({ id, played: false }));
      },
    }));

    assert.equal(await sync.run(), 103);
    assert.deepEqual(
      batchSizes.slice().sort((left, right) => right - left),
      [100, 1, 1, 1]
    );
    assert.equal(maximumActiveUsers, 2);
    assert.equal(await sync.run(), 103);
    assert.equal(await getRepository(UserMediaState).count(), 103);
  });
});
