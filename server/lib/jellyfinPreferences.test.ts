import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { UserMediaState } from '@server/entity/UserMediaState';
import { Watchlist } from '@server/entity/Watchlist';
import {
  deriveJellyfinPreference,
  loadLibraryPreferenceTargets,
  logicalJellyfinPreference,
  persistJellyfinPreference,
  type JellyfinPreferenceTarget,
} from '@server/lib/jellyfinPreferences';
import { getSettings } from '@server/lib/settings';
import {
  WatchlistPlayStateSync,
  deriveWatchlistPlayState,
} from '@server/lib/watchlistPlayState';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const SOURCE = 'preference-fixture';
const USER = '11111111111111111111111111111111';
const OTHER_USER = '22222222222222222222222222222222';
const ITEM = '33333333333333333333333333333333';
const FOUR_K = '44444444444444444444444444444444';
const target: JellyfinPreferenceTarget = {
  mediaType: MediaType.MOVIE,
  tmdbId: 10,
  ids: [ITEM],
};
const makeItem = (rating: boolean | null = null, id = ITEM, type = 'Movie') =>
  ({
    Id: id,
    Type: type,
    ProviderIds: { Tmdb: '10' },
    RecursiveItemCount: 2,
    UserData: {
      Played: true,
      Likes: rating,
      PlayCount: 1,
      LastPlayedDate: '2026-10-29T10:00:00Z',
    },
  }) as JellyfinLibraryItemExtended;
const observed = (item: JellyfinLibraryItemExtended) =>
  new Map([[item.Id, item]]);

setupTestDb();
beforeEach(async () => {
  getSettings().jellyfin.serverId = SOURCE;
  await getRepository(User).update(1, { jellyfinUserId: USER });
  await getRepository(User).update(2, { jellyfinUserId: OTHER_USER });
});
const store = async (
  rating: boolean | null,
  date = '2026-10-29T12:00:00Z',
  userId = 1,
  sourceUserId = USER
) =>
  dataSource.transaction((manager) =>
    persistJellyfinPreference({
      manager,
      target,
      items: observed(makeItem(rating)),
      userId,
      sourceUserId,
      sourceScope: SOURCE,
      observedAt: new Date(date),
    })
  );
const load = async (userId = 1) =>
  getRepository(UserMediaState)
    .createQueryBuilder('state')
    .addSelect([
      'state.jellyfinPreferenceSourceScope',
      'state.jellyfinPreferenceUserId',
      'state.jellyfinPreferenceItemIds',
    ])
    .where('state.userId = :userId', { userId })
    .getOneOrFail();

describe('Jellyfin preference V1', () => {
  for (const rating of [true, false, null])
    it(`persists ${rating} and derives noncontradictory logical fields`, async () => {
      assert.equal(await store(rating), true);
      const state = await load();
      assert.equal(state.jellyfinLikes, rating);
      assert.deepEqual(logicalJellyfinPreference(state, USER), {
        liked: rating === true,
        disliked: rating === false,
      });
      assert.equal(state.jellyfinPlayed, null);
      assert.equal(await getRepository(Watchlist).count(), 0);
      assert.deepEqual(logicalJellyfinPreference(state, OTHER_USER), {
        liked: null,
        disliked: null,
      });
      assert.deepEqual(logicalJellyfinPreference(state, USER, 'other-server'), {
        liked: null,
        disliked: null,
      });
    });
  it('treats omitted nullable Likes as Neutral only on a complete returned UserData DTO', () => {
    const item = makeItem();
    delete item.UserData!.Likes;
    assert.equal(deriveJellyfinPreference(target, observed(item)), null);
    delete item.UserData;
    assert.equal(deriveJellyfinPreference(target, observed(item)), undefined);
    assert.equal(deriveJellyfinPreference(target, new Map()), undefined);
  });
  it('rejects wrong type, ID, provider identity and malformed rating', () => {
    for (const item of [
      makeItem(true, ITEM, 'Episode'),
      { ...makeItem(true), ProviderIds: { Tmdb: '11' } },
      { ...makeItem(true), Id: FOUR_K },
    ]) {
      assert.equal(
        deriveJellyfinPreference(target, new Map([[ITEM, item]])),
        undefined
      );
    }
    const malformed = makeItem();
    Object.assign(malformed.UserData!, { Likes: 'false' });
    assert.equal(
      deriveJellyfinPreference(target, observed(malformed)),
      undefined
    );
  });
  it('leaves conflicting or incomplete standard/4K preferences unresolved', () => {
    const multi = { ...target, ids: [ITEM, FOUR_K] };
    assert.equal(
      deriveJellyfinPreference(multi, observed(makeItem(true))),
      undefined
    );
    const items = new Map([
      [ITEM, makeItem(true)],
      [FOUR_K, makeItem(false, FOUR_K)],
    ]);
    assert.equal(deriveJellyfinPreference(multi, items), undefined);
    items.set(FOUR_K, makeItem(true, FOUR_K));
    assert.equal(deriveJellyfinPreference(multi, items), true);
  });
  it('isolates users with the same canonical typed-media identity', async () => {
    await store(true);
    await store(false, undefined, 2, OTHER_USER);
    assert.equal((await load(1)).jellyfinLikes, true);
    assert.equal((await load(2)).jellyfinLikes, false);
  });
  it('does not let a late or repeated older observation overwrite a newer rating', async () => {
    await store(false);
    assert.equal(await store(true, '2026-10-29T11:00:00Z'), false);
    assert.equal(await store(null), false);
    assert.equal((await load()).jellyfinLikes, false);
    assert.equal(await store(null, '2026-10-29T13:00:00Z'), true);
    assert.equal((await load()).jellyfinLikes, null);
  });
  it('preserves last good preference on missing data and rejects changed source/account mappings', async () => {
    await store(false);
    assert.equal(
      await dataSource.transaction((manager) =>
        persistJellyfinPreference({
          manager,
          target,
          items: new Map(),
          userId: 1,
          sourceUserId: USER,
          sourceScope: SOURCE,
          observedAt: new Date('2026-10-29T13:00:00Z'),
        })
      ),
      false
    );
    getSettings().jellyfin.serverId = 'changed';
    assert.equal(await store(true, '2026-10-29T14:00:00Z'), false);
    getSettings().jellyfin.serverId = SOURCE;
    await getRepository(User).update(1, { jellyfinUserId: OTHER_USER });
    assert.equal(await store(true, '2026-10-29T14:00:00Z'), false);
    assert.equal((await load()).jellyfinLikes, false);
  });
  it('rejects ambiguous Jellyfin user mapping', async () => {
    await getRepository(User).update(2, { jellyfinUserId: USER });
    assert.equal(await store(true), false);
    assert.equal(await getRepository(UserMediaState).count(), 0);
  });
  it('rejects a replaced media identity captured before the provider read', async () => {
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 10,
        mediaType: MediaType.MOVIE,
        jellyfinMediaId: FOUR_K,
      })
    );
    assert.equal(
      await dataSource.transaction((manager) =>
        persistJellyfinPreference({
          manager,
          target: { ...target, mediaId: media.id },
          items: observed(makeItem(true)),
          userId: 1,
          sourceUserId: USER,
          sourceScope: SOURCE,
          observedAt: new Date(),
        })
      ),
      false
    );
  });
  it('does not recreate a Watchlist state deleted while its provider read was in flight', async () => {
    await store(true);
    const state = await load();
    await getRepository(UserMediaState).delete(state.id);
    assert.equal(
      await dataSource.transaction((manager) =>
        persistJellyfinPreference({
          manager,
          target: { ...target, stateId: state.id },
          items: observed(makeItem(false)),
          userId: 1,
          sourceUserId: USER,
          sourceScope: SOURCE,
          observedAt: new Date(),
        })
      ),
      false
    );
    assert.equal(await getRepository(UserMediaState).count(), 0);
  });
  it('loads Movie and Series preferences through exact existing Library identities', async () => {
    for (const mediaType of [LibraryMediaType.MOVIE, LibraryMediaType.SERIES]) {
      const canonical = await getRepository(CanonicalMedia).save(
        new CanonicalMedia({ mediaType })
      );
      await getRepository(CanonicalMediaIdentity).save(
        new CanonicalMediaIdentity({
          canonicalMediaId: canonical.id,
          mediaType,
          provider: 'tmdb',
          sourceScope: '',
          value: '10',
        })
      );
      await getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId: canonical.id,
          sourceSystem: 'jellyfin',
          sourceScope: SOURCE,
          sourceItemId: `${mediaType}:${mediaType === 'movie' ? ITEM : FOUR_K}`,
          isCurrent: true,
          jellyfinVisible: true,
          firstObservedAt: new Date(),
        })
      );
    }
    const targets = await loadLibraryPreferenceTargets(
      dataSource.manager,
      SOURCE
    );
    assert.deepEqual(targets.map((t) => t.mediaType).sort(), [
      MediaType.MOVIE,
      MediaType.TV,
    ]);
    assert.deepEqual(
      await loadLibraryPreferenceTargets(dataSource.manager, 'other'),
      []
    );
  });
  it('adds preference persistence to the real Watchlist sync without changing played behavior', async () => {
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 10,
        mediaType: MediaType.MOVIE,
        jellyfinMediaId: ITEM,
      })
    );
    await getRepository(Watchlist).save(
      new Watchlist({
        tmdbId: 10,
        mediaType: MediaType.MOVIE,
        media,
        requestedBy: user,
        title: 'Fixture',
        ratingKey: '',
      })
    );
    let response = [makeItem(false)];
    let failure = false;
    const sync = new WatchlistPlayStateSync(async () => ({
      getUserItems: async () => {
        if (failure) throw new Error('isolated provider failure');
        return response;
      },
    }));
    await sync.run();
    assert.equal((await load()).jellyfinLikes, false);
    assert.equal((await load()).jellyfinPlayed, true);
    response = [];
    await sync.run();
    assert.equal((await load()).jellyfinLikes, false);
    failure = true;
    await sync.run();
    assert.equal((await load()).jellyfinLikes, false);
    assert.deepEqual(
      deriveWatchlistPlayState({
        mediaType: MediaType.MOVIE,
        items: [makeItem(false)],
      }),
      deriveWatchlistPlayState({
        mediaType: MediaType.MOVIE,
        items: [makeItem(true)],
      })
    );
  });
});
