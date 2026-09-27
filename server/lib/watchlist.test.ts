import PlexTvAPI from '@server/api/plextv';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import {
  getLocalWatchlist,
  getWatchlistForUser,
  parseWatchlistQuery,
} from '@server/lib/watchlist';
import { WatchlistMetadataBackfill } from '@server/lib/watchlistMetadata';
import { AddWatchlistGenres1790000000008 } from '@server/migration/sqlite/1790000000008-AddWatchlistGenres';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';

type TmdbFixture = {
  id: number;
  external_ids: { tvdb_id?: number };
  genres: { id: number; name: string }[];
};

let tmdbFixtures = new Map<number, TmdbFixture>();
let failingTmdbIds = new Set<number>();
let providerCalls = 0;

const getTmdbFixture = async (id: number): Promise<TmdbFixture> => {
  providerCalls += 1;
  if (failingTmdbIds.has(id)) {
    throw new Error('provider unavailable');
  }
  const fixture = tmdbFixtures.get(id);
  if (!fixture) {
    throw new Error(`missing fixture ${id}`);
  }
  return fixture;
};

const tmdb = {
  getMovie: async ({ movieId }: { movieId: number }) =>
    getTmdbFixture(movieId) as never,
  getTvShow: async ({ tvId }: { tvId: number }) =>
    getTmdbFixture(tvId) as never,
};

let plexCalls = 0;
Object.defineProperty(PlexTvAPI.prototype, 'getWatchlist', {
  get() {
    return async ({ offset }: { offset: number }) => {
      plexCalls += 1;
      return {
        offset,
        size: 20,
        totalSize: 1,
        items: [
          {
            ratingKey: 'plex-9000',
            tmdbId: 9000,
            title: 'Plex Canonical',
            type: 'movie' as const,
          },
        ],
      };
    };
  },
  configurable: true,
});

setupTestDb();

const admin = async (): Promise<User> =>
  getRepository(User).findOneOrFail({ where: { id: 1 } });

const addRow = async ({
  user,
  tmdbId,
  mediaType,
  title,
  genreIds,
  createdAt,
}: {
  user: User;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  genreIds: number[] | null;
  createdAt: Date;
}): Promise<Watchlist> => {
  const media = await getRepository(Media).save(
    new Media({ tmdbId, mediaType })
  );
  return getRepository(Watchlist).save(
    new Watchlist({
      ratingKey: `local-${tmdbId}`,
      tmdbId,
      mediaType,
      title,
      genreIds,
      requestedBy: user,
      media,
      createdAt,
    })
  );
};

describe('local Watchlist query and ownership', () => {
  beforeEach(() => {
    tmdbFixtures = new Map();
    failingTmdbIds = new Set();
    providerCalls = 0;
    plexCalls = 0;
  });

  it('parses only supported presentation values', () => {
    assert.deepEqual(parseWatchlistQuery({}), {
      page: 1,
      category: 'all',
      sort: 'added_desc',
    });
    assert.deepEqual(
      parseWatchlistQuery({
        page: '2',
        category: 'animation',
        sort: 'title_asc',
      }),
      { page: 2, category: 'animation', sort: 'title_asc' }
    );
    assert.deepEqual(
      parseWatchlistQuery({ page: '-1', category: 'anime', sort: 'year' }),
      { page: 1, category: 'all', sort: 'added_desc' }
    );
  });

  it('filters before pagination, isolates users, and reports filtered totals', async () => {
    const user = await admin();
    const other = await getRepository(User).save(
      new User({ email: 'other@example.test', avatar: '' })
    );
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let index = 0; index < 25; index++) {
      await addRow({
        user,
        tmdbId: 1000 + index,
        mediaType: MediaType.MOVIE,
        title: `Movie ${String(index).padStart(2, '0')}`,
        genreIds: [18],
        createdAt: new Date(start + index * 1000),
      });
    }
    await addRow({
      user,
      tmdbId: 2000,
      mediaType: MediaType.MOVIE,
      title: 'Animated Movie',
      genreIds: [16, 10751],
      createdAt: new Date(start + 30_000),
    });
    await addRow({
      user,
      tmdbId: 2001,
      mediaType: MediaType.TV,
      title: 'Animated Series',
      genreIds: [16],
      createdAt: new Date(start + 31_000),
    });
    await addRow({
      user,
      tmdbId: 2002,
      mediaType: MediaType.TV,
      title: 'Drama Series',
      genreIds: [18],
      createdAt: new Date(start + 32_000),
    });
    await addRow({
      user,
      tmdbId: 2003,
      mediaType: MediaType.MOVIE,
      title: 'Unknown Metadata',
      genreIds: null,
      createdAt: new Date(start + 33_000),
    });
    await addRow({
      user: other,
      tmdbId: 3000,
      mediaType: MediaType.MOVIE,
      title: 'Other User Movie',
      genreIds: [18],
      createdAt: new Date(start + 34_000),
    });

    const all = await getLocalWatchlist({
      userId: user.id,
      query: { page: 1, category: 'all', sort: 'added_desc' },
    });
    assert.equal(all.totalResults, 29);
    assert.equal(all.totalPages, 2);
    assert.equal(all.results.length, 20);
    assert.equal(all.results[0].title, 'Unknown Metadata');

    const movies = await getLocalWatchlist({
      userId: user.id,
      query: { page: 2, category: 'movies', sort: 'added_desc' },
    });
    assert.equal(movies.totalResults, 25);
    assert.equal(movies.totalPages, 2);
    assert.equal(movies.results.length, 5);
    assert.ok(movies.results.every((row) => row.genreIds !== null));
    assert.ok(movies.results.every((row) => !row.genreIds?.includes(16)));

    const series = await getLocalWatchlist({
      userId: user.id,
      query: { page: 1, category: 'series', sort: 'added_desc' },
    });
    assert.deepEqual(
      series.results.map((row) => row.title),
      ['Drama Series']
    );

    const animation = await getLocalWatchlist({
      userId: user.id,
      query: { page: 1, category: 'animation', sort: 'added_desc' },
    });
    assert.deepEqual(
      animation.results.map((row) => row.title),
      ['Animated Series', 'Animated Movie']
    );
  });

  it('applies stable date and title ordering before pagination', async () => {
    const user = await admin();
    const sameDate = new Date('2026-02-01T00:00:00Z');
    await addRow({
      user,
      tmdbId: 3,
      mediaType: MediaType.TV,
      title: 'Beta',
      genreIds: [],
      createdAt: sameDate,
    });
    await addRow({
      user,
      tmdbId: 2,
      mediaType: MediaType.MOVIE,
      title: 'alpha',
      genreIds: [],
      createdAt: sameDate,
    });
    await addRow({
      user,
      tmdbId: 1,
      mediaType: MediaType.MOVIE,
      title: 'Zulu',
      genreIds: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const newest = await getLocalWatchlist({
      userId: user.id,
      query: { page: 1, category: 'all', sort: 'added_desc' },
    });
    assert.deepEqual(
      newest.results.map((row) => row.title),
      ['alpha', 'Beta', 'Zulu']
    );
    const oldest = await getLocalWatchlist({
      userId: user.id,
      query: { page: 1, category: 'all', sort: 'added_asc' },
    });
    assert.deepEqual(
      oldest.results.map((row) => row.title),
      ['Zulu', 'alpha', 'Beta']
    );
    const az = await getLocalWatchlist({
      userId: user.id,
      query: { page: 1, category: 'all', sort: 'title_asc' },
    });
    assert.deepEqual(
      az.results.map((row) => row.title),
      ['alpha', 'Beta', 'Zulu']
    );
    const za = await getLocalWatchlist({
      userId: user.id,
      query: { page: 1, category: 'all', sort: 'title_desc' },
    });
    assert.deepEqual(
      za.results.map((row) => row.title),
      ['Zulu', 'Beta', 'alpha']
    );
  });

  it('always selects Plex for a Plex user even when legacy local rows exist', async () => {
    const user = await admin();
    user.plexToken = ' usable-token ';
    await getRepository(User).save(user);
    await addRow({
      user,
      tmdbId: 42,
      mediaType: MediaType.MOVIE,
      title: 'Legacy Local',
      genreIds: [18],
      createdAt: new Date(),
    });

    const result = await getWatchlistForUser({
      user,
      query: { page: 1, category: 'animation', sort: 'title_desc' },
    });
    assert.equal(plexCalls, 1);
    assert.equal(result.source, 'plex');
    assert.equal(result.supportsPresentation, false);
    assert.deepEqual(
      result.results.map((row) => row.title),
      ['Plex Canonical']
    );
  });
});

describe('Watchlist metadata capture and backfill', () => {
  beforeEach(() => {
    tmdbFixtures = new Map();
    failingTmdbIds = new Set();
    providerCalls = 0;
  });

  it('captures TMDB genre IDs during the existing add lookup', async () => {
    const user = await admin();
    tmdbFixtures.set(4000, {
      id: 4000,
      external_ids: {},
      genres: [
        { id: 16, name: 'Animation' },
        { id: 10751, name: 'Family' },
      ],
    });
    const created = await Watchlist.createWatchlist({
      user,
      tmdb,
      watchlistRequest: {
        tmdbId: 4000,
        mediaType: MediaType.MOVIE,
        title: 'Animated',
      },
    });
    assert.deepEqual(created.genreIds, [16, 10751]);
    assert.equal(providerCalls, 1);
    assert.equal(
      (await getRepository(Watchlist).findOneByOrFail({ id: created.id }))
        .createdAt instanceof Date,
      true
    );
    await Watchlist.deleteWatchlist(4000, MediaType.MOVIE, user);
    assert.equal(await getRepository(Watchlist).count(), 0);
  });

  it('does not create membership when the provider lookup fails', async () => {
    const user = await admin();
    failingTmdbIds.add(4001);
    await assert.rejects(() =>
      Watchlist.createWatchlist({
        user,
        tmdb,
        watchlistRequest: {
          tmdbId: 4001,
          mediaType: MediaType.MOVIE,
          title: 'Unavailable',
        },
      })
    );
    assert.equal(await getRepository(Watchlist).count(), 0);
  });

  it('hydrates a bounded batch idempotently and preserves failed rows', async () => {
    const user = await admin();
    const createdAt = new Date('2025-01-01T00:00:00Z');
    await addRow({
      user,
      tmdbId: 5000,
      mediaType: MediaType.MOVIE,
      title: 'Hydrate',
      genreIds: null,
      createdAt,
    });
    await addRow({
      user,
      tmdbId: 5001,
      mediaType: MediaType.TV,
      title: 'Retry',
      genreIds: null,
      createdAt,
    });
    tmdbFixtures.set(5000, {
      id: 5000,
      external_ids: {},
      genres: [{ id: 16, name: 'Animation' }],
    });
    failingTmdbIds.add(5001);

    const backfill = new WatchlistMetadataBackfill(() => tmdb);
    assert.equal(await backfill.run(10), 1);
    const hydrated = await getRepository(Watchlist).findOneByOrFail({
      tmdbId: 5000,
    });
    const retryable = await getRepository(Watchlist).findOneByOrFail({
      tmdbId: 5001,
    });
    assert.deepEqual(hydrated.genreIds, [16]);
    assert.equal(hydrated.createdAt.toISOString(), createdAt.toISOString());
    assert.equal(retryable.genreIds, null);

    failingTmdbIds.delete(5001);
    tmdbFixtures.set(5001, {
      id: 5001,
      external_ids: {},
      genres: [{ id: 18, name: 'Drama' }],
    });
    assert.equal(await backfill.run(10), 1);
    assert.equal(await backfill.run(10), 0);
    assert.equal(providerCalls, 3);
  });
});

describe('Watchlist route source policy', () => {
  it('routes both canonical surfaces through the shared selector', () => {
    const discoverRoute = readFileSync(
      path.join(__dirname, '../routes/discover.ts'),
      'utf8'
    );
    const userRoute = readFileSync(
      path.join(__dirname, '../routes/user/index.ts'),
      'utf8'
    );
    assert.match(discoverRoute, /await getWatchlistForUser\(/);
    assert.match(userRoute, /await getWatchlistForUser\(/);
    assert.doesNotMatch(
      discoverRoute.slice(discoverRoute.indexOf("'/watchlist'")),
      /findAndCount/
    );
    assert.doesNotMatch(
      userRoute.slice(userRoute.indexOf("'/:id/watchlist'")),
      /findAndCount/
    );
  });
});

describe('Watchlist genre migration', () => {
  it('is idempotent and preserves existing membership evidence', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(
        `CREATE TABLE "watchlist" (
          "id" integer PRIMARY KEY,
          "requestedById" integer NOT NULL,
          "mediaType" varchar NOT NULL,
          "title" varchar NOT NULL,
          "createdAt" datetime NOT NULL
        )`
      );
      await runner.query(
        `INSERT INTO "watchlist" ("id", "requestedById", "mediaType", "title", "createdAt")
         VALUES (1, 7, 'movie', 'Legacy Membership', '2025-01-01 00:00:00')`
      );
      const migration = new AddWatchlistGenres1790000000008();
      await migration.up(runner);
      await migration.up(runner);

      const [row] = (await runner.query(
        `SELECT "requestedById", "mediaType", "title", "createdAt", "genreIds" FROM "watchlist" WHERE "id" = 1`
      )) as {
        requestedById: number;
        mediaType: string;
        title: string;
        createdAt: string;
        genreIds: string | null;
      }[];
      assert.equal(row.requestedById, 7);
      assert.equal(row.mediaType, 'movie');
      assert.equal(row.title, 'Legacy Membership');
      assert.match(row.createdAt, /2025-01-01/);
      assert.equal(row.genreIds, null);
      const indexes = (await runner.query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'watchlist'`
      )) as { name: string }[];
      assert.ok(
        indexes.some(({ name }) => name === 'IDX_watchlist_user_created')
      );
      assert.ok(
        indexes.some(({ name }) => name === 'IDX_watchlist_user_type_title')
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });
});
