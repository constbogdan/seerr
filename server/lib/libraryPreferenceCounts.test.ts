import type { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import { User } from '@server/entity/User';
import { UserMediaState } from '@server/entity/UserMediaState';
import { loadLibraryPreferenceCounts } from '@server/lib/libraryPreferenceCounts';
import { libraryPreferenceExistsSql } from '@server/lib/libraryPreferenceFilter';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const SOURCE = 'counts-fixture';
const USERS = ['1'.repeat(32), '2'.repeat(32)];
const ITEM = '3'.repeat(32);
const OTHER_ITEM = '4'.repeat(32);
setupTestDb();
beforeEach(async () => {
  getSettings().jellyfin.serverId = SOURCE;
  for (const [index, jellyfinUserId] of USERS.entries())
    await getRepository(User).update(index + 1, {
      jellyfinUserId,
      includeInUserMetrics: true,
    });
});
async function target(mediaType: 'movie' | 'series' = 'movie', tmdbId = 10) {
  const media = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({ mediaType: mediaType as LibraryMediaType })
  );
  return { canonicalMediaId: media.id, mediaType, tmdbId };
}
async function vote(
  userId = 1,
  jellyfinLikes: boolean | null = true,
  mediaType = MediaType.MOVIE,
  tmdbId = 10,
  override: Partial<UserMediaState> = {}
) {
  return getRepository(UserMediaState).save(
    new UserMediaState({
      user: new User({ id: userId }),
      mediaType,
      tmdbId,
      jellyfinLikes,
      jellyfinPreferenceObservedAt: new Date('2026-10-29T12:00:00Z'),
      jellyfinPreferenceSourceScope: SOURCE,
      jellyfinPreferenceUserId: USERS[userId - 1],
      jellyfinPreferenceItemIds: ITEM,
      ...override,
    })
  );
}
async function presence(
  canonicalMediaId: number,
  sourceItemId = `movie:${ITEM}`,
  generation = ''
) {
  await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId,
      sourceItemId,
      sourceSystem: 'jellyfin',
      sourceScope: SOURCE,
      sourceGeneration: generation,
      isCurrent: true,
      jellyfinVisible: true,
    })
  );
}
const zero = { likedUserCount: 0, dislikedUserCount: 0 };

async function filtered(
  targets: Awaited<ReturnType<typeof target>>[],
  liked: boolean,
  userIds: number[] = [],
  userIdExpression?: string
) {
  return getRepository(CanonicalMedia)
    .createQueryBuilder('canonical')
    .where('canonical.id IN (:...targetIds)', {
      targetIds: targets.map((row) => row.canonicalMediaId),
    })
    .andWhere(
      libraryPreferenceExistsSql(':filterTmdb', userIds, userIdExpression)
    )
    .setParameters({
      filterTmdb: 10,
      preferenceSourceScope: SOURCE,
      preferenceLiked: liked,
      current: true,
      userIds,
    })
    .getMany();
}

describe('Library explicit preference SQL filter', () => {
  it('matches opposite users independently, retaining canonical Movie/Series isolation', async () => {
    const movie = await target();
    const series = await target('series');
    await vote();
    await vote(2, false);
    await vote(1, false, MediaType.TV);
    assert.deepEqual(
      (await filtered([movie, series], true)).map((r) => r.id),
      [movie.canonicalMediaId]
    );
    assert.deepEqual(
      (await filtered([movie, series], false)).map((r) => r.id),
      [movie.canonicalMediaId, series.canonicalMediaId]
    );
    assert.equal((await filtered([movie], false, [1])).length, 0);
    assert.equal((await filtered([movie], false, [2])).length, 1);
    assert.equal((await filtered([movie], true, [1, 2])).length, 1);
    assert.equal((await filtered([movie], false, [1, 2])).length, 1);
    assert.equal((await filtered([movie], false, [], '1')).length, 0);
    assert.equal((await filtered([movie], false, [], '2')).length, 1);
  });
  for (const [label, rating, overrides] of [
    ['Neutral', null, {}],
    ['Unknown', true, { jellyfinPreferenceObservedAt: null }],
    ['wrong source', true, { jellyfinPreferenceSourceScope: 'other' }],
    ['relinked user', true, { jellyfinPreferenceUserId: USERS[1] }],
    ['missing binding', true, { jellyfinPreferenceItemIds: null }],
    ['malformed binding', true, { jellyfinPreferenceItemIds: 'invalid' }],
    [
      'noncanonical binding',
      true,
      { jellyfinPreferenceItemIds: `${ITEM},${ITEM}` },
    ],
    [
      'JSON-like malformed binding',
      true,
      { jellyfinPreferenceItemIds: '"]broken' },
    ],
  ] as const)
    it(`matches neither Yes nor No for ${label}, in agreement with the count projection`, async () => {
      const movie = await target();
      await vote(1, rating, MediaType.MOVIE, 10, overrides);
      assert.equal((await filtered([movie], true)).length, 0);
      assert.equal((await filtered([movie], false)).length, 0);
      assert.deepEqual(
        (await loadLibraryPreferenceCounts([movie])).get(
          movie.canonicalMediaId
        ),
        zero
      );
    });
  it('rejects missing votes, excluded users, duplicate account mappings and invalid linked IDs', async () => {
    const movie = await target();
    assert.equal((await filtered([movie], false)).length, 0);
    await vote();
    await getRepository(User).update(1, { includeInUserMetrics: false });
    assert.equal((await filtered([movie], true, [1])).length, 0);
    await getRepository(User).update(1, { includeInUserMetrics: true });
    await getRepository(User).update(2, {
      jellyfinUserId: ` ${USERS[0].toUpperCase()} `,
    });
    assert.equal((await filtered([movie], true)).length, 0);
    await getRepository(User).update(1, { jellyfinUserId: 'invalid' });
    assert.equal((await filtered([movie], true)).length, 0);
  });
  it('fences replacements and incomplete current bindings, retaining valid archived observations', async () => {
    const movie = await target();
    await vote();
    assert.equal((await filtered([movie], true)).length, 1);
    await presence(movie.canonicalMediaId, `movie:${OTHER_ITEM}`);
    assert.equal((await filtered([movie], true)).length, 0);
    await getRepository(UserMediaState).update(
      { tmdbId: 10 },
      { jellyfinPreferenceItemIds: [ITEM, OTHER_ITEM].sort().join(',') }
    );
    assert.equal((await filtered([movie], true)).length, 0);
    await presence(movie.canonicalMediaId, `movie:${ITEM}`, 'one');
    await presence(movie.canonicalMediaId, `movie:${ITEM}`, 'two');
    assert.equal((await filtered([movie], true)).length, 1);
  });
  it('requires exact typed presence prefixes, matching the count projection even on SQLite', async () => {
    const movie = await target();
    await vote();
    await presence(movie.canonicalMediaId, `MOVIE:${ITEM}`);
    assert.equal((await filtered([movie], true)).length, 0);
    assert.deepEqual(
      (await loadLibraryPreferenceCounts([movie])).get(movie.canonicalMediaId),
      zero
    );
  });
  it('uses one SELECT for any page size, without changing votes or calling providers', async (context) => {
    const movie = await target();
    const series = await target('series');
    await vote();
    const before = await dataSource.query('SELECT * FROM user_media_state');
    const spy = context.mock.method(
      dataSource.logger,
      'logQuery',
      () => undefined
    );
    await filtered([movie], true);
    assert.equal(spy.mock.callCount(), 1);
    spy.mock.resetCalls();
    await filtered([movie, series], true);
    assert.equal(spy.mock.callCount(), 1);
    spy.mock.restore();
    assert.deepEqual(
      await dataSource.query('SELECT * FROM user_media_state'),
      before
    );
  });
  it('generates native PostgreSQL aggregation and splitting without SQLite functions', () => {
    const sql = libraryPreferenceExistsSql('canonical.id', [], undefined, true);
    assert.match(sql, /STRING_AGG/);
    assert.match(sql, /regexp_split_to_table/);
    assert.doesNotMatch(sql, /GLOB|json_each|GROUP_CONCAT/);
  });
});

describe('Library preference count page projection', () => {
  it('isolates Movie and Series identities and opposite users', async () => {
    const movie = await target();
    const series = await target('series');
    await vote();
    await vote(2, false);
    await vote(1, false, MediaType.TV);
    const result = await loadLibraryPreferenceCounts([movie, series]);
    assert.deepEqual(result.get(movie.canonicalMediaId), {
      likedUserCount: 1,
      dislikedUserCount: 1,
    });
    assert.deepEqual(result.get(series.canonicalMediaId), {
      likedUserCount: 0,
      dislikedUserCount: 1,
    });
  });
  it('counts distinct users, not repeated page targets or presence generations', async () => {
    const movie = await target();
    await vote();
    await vote(2);
    await presence(movie.canonicalMediaId);
    await presence(movie.canonicalMediaId, `movie:${ITEM}`, 'second');
    const result = await loadLibraryPreferenceCounts([movie, movie]);
    assert.equal(result.size, 1);
    assert.deepEqual(result.get(movie.canonicalMediaId), {
      likedUserCount: 2,
      dislikedUserCount: 0,
    });
  });
  for (const [label, rating, overrides] of [
    ['Neutral', null, {}],
    ['unknown', true, { jellyfinPreferenceObservedAt: null }],
    ['wrong source', true, { jellyfinPreferenceSourceScope: 'another' }],
    ['relinked user', true, { jellyfinPreferenceUserId: USERS[1] }],
    ['missing binding', true, { jellyfinPreferenceItemIds: null }],
    ['malformed binding', true, { jellyfinPreferenceItemIds: 'invalid' }],
  ] as const)
    it(`excludes ${label} without changing persisted observations`, async () => {
      const movie = await target();
      await vote(1, rating, MediaType.MOVIE, 10, overrides);
      const before = await dataSource.query('SELECT * FROM user_media_state');
      assert.deepEqual(
        (await loadLibraryPreferenceCounts([movie])).get(
          movie.canonicalMediaId
        ),
        zero
      );
      assert.deepEqual(
        await dataSource.query('SELECT * FROM user_media_state'),
        before
      );
    });
  it('excludes opted-out users and ambiguous normalized linked-user mappings', async () => {
    const movie = await target();
    await vote();
    await getRepository(User).update(1, { includeInUserMetrics: false });
    assert.deepEqual(
      (await loadLibraryPreferenceCounts([movie])).get(movie.canonicalMediaId),
      zero
    );
    await getRepository(User).update(1, { includeInUserMetrics: true });
    await getRepository(User).update(2, {
      jellyfinUserId: ` ${USERS[0].slice(0, 8)}-${USERS[0].slice(8)} `,
      includeInUserMetrics: false,
    });
    assert.deepEqual(
      (await loadLibraryPreferenceCounts([movie])).get(movie.canonicalMediaId),
      zero
    );
  });
  it('fences replaced or incomplete current item bindings, preserving archived observations', async () => {
    const movie = await target();
    await vote();
    assert.deepEqual(
      (await loadLibraryPreferenceCounts([movie])).get(movie.canonicalMediaId),
      { likedUserCount: 1, dislikedUserCount: 0 }
    );
    await presence(movie.canonicalMediaId, `movie:${OTHER_ITEM}`);
    assert.deepEqual(
      (await loadLibraryPreferenceCounts([movie])).get(movie.canonicalMediaId),
      zero
    );
    await getRepository(UserMediaState).update(
      { tmdbId: 10 },
      { jellyfinPreferenceItemIds: [ITEM, OTHER_ITEM].sort().join(',') }
    );
    await presence(movie.canonicalMediaId);
    assert.deepEqual(
      (await loadLibraryPreferenceCounts([movie])).get(movie.canonicalMediaId),
      { likedUserCount: 1, dislikedUserCount: 0 }
    );
  });
  it('does not bypass visibility/source checks for the second typed OR branch', async () => {
    const movie = await target();
    const series = await target('series');
    await vote(1, true, MediaType.TV, 10, {
      jellyfinPreferenceSourceScope: 'wrong',
    });
    assert.deepEqual(
      [...(await loadLibraryPreferenceCounts([movie, series])).values()],
      [zero, zero]
    );
  });
  it('uses exactly two SELECTs for one or many targets, without hydrating private User fields', async (context) => {
    const movie = await target();
    const series = await target('series');
    await vote(1, true, MediaType.MOVIE, 10, {
      jellyfinPlayed: true,
      jellyfinLastPlayedAt: new Date('2026-10-28T12:00:00Z'),
    });
    const before = await dataSource.query('SELECT * FROM user_media_state');
    const spy = context.mock.method(
      dataSource.logger,
      'logQuery',
      () => undefined
    );
    await loadLibraryPreferenceCounts([movie]);
    assert.equal(spy.mock.callCount(), 2);
    spy.mock.resetCalls();
    await loadLibraryPreferenceCounts([movie, series]);
    assert.equal(spy.mock.callCount(), 2);
    for (const call of spy.mock.calls) {
      assert.match(String(call.arguments[0]), /^SELECT /);
      assert.doesNotMatch(
        String(call.arguments[0]),
        /password|accessToken|email/i
      );
    }
    spy.mock.restore();
    assert.deepEqual(
      await dataSource.query('SELECT * FROM user_media_state'),
      before
    );
  });
  it('skips all queries for empty pages or an unconfigured source', async (context) => {
    const movie = await target();
    const spy = context.mock.method(
      dataSource.logger,
      'logQuery',
      () => undefined
    );
    assert.equal((await loadLibraryPreferenceCounts([])).size, 0);
    assert.equal(
      (await loadLibraryPreferenceCounts([movie], dataSource.manager, '')).size,
      0
    );
    assert.equal(spy.mock.callCount(), 0);
  });
});
