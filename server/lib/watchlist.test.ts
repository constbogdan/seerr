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
import { AddWatchlistEnrichment1790000000014 } from '@server/migration/sqlite/1790000000014-AddWatchlistEnrichment';
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
  jellyfinPlayed,
}: {
  user: User;
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  genreIds: number[] | null;
  createdAt: Date;
  jellyfinPlayed?: boolean | null;
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
      jellyfinPlayed,
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
      watched: 'not_watched',
    });
    assert.deepEqual(
      parseWatchlistQuery({
        page: '2',
        category: 'animation',
        sort: 'title_asc',
      }),
      {
        page: 2,
        category: 'animation',
        sort: 'title_asc',
        watched: 'not_watched',
      }
    );
    assert.deepEqual(
      parseWatchlistQuery({ page: '-1', category: 'anime', sort: 'year' }),
      {
        page: 1,
        category: 'all',
        sort: 'added_desc',
        watched: 'not_watched',
      }
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
    assert.equal(all.hasUnclassifiedItems, true);

    const movies = await getLocalWatchlist({
      userId: user.id,
      query: { page: 2, category: 'movies', sort: 'added_desc' },
    });
    assert.equal(movies.totalResults, 25);
    assert.equal(movies.totalPages, 2);
    assert.equal(movies.results.length, 5);
    assert.ok(movies.results.every((row) => row.genreIds !== null));
    assert.ok(movies.results.every((row) => !row.genreIds?.includes(16)));
    assert.equal(movies.hasUnclassifiedItems, true);

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
    assert.equal(animation.hasUnclassifiedItems, true);
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

  it('filters watched state before pagination and keeps unknown in Not Watched', async () => {
    const user = await admin();
    const createdAt = new Date('2026-02-01T00:00:00Z');
    await addRow({
      user,
      tmdbId: 6100,
      mediaType: MediaType.MOVIE,
      title: 'Watched',
      genreIds: [],
      createdAt,
      jellyfinPlayed: true,
    });
    await addRow({
      user,
      tmdbId: 6101,
      mediaType: MediaType.MOVIE,
      title: 'Not Watched',
      genreIds: [],
      createdAt,
      jellyfinPlayed: false,
    });
    await addRow({
      user,
      tmdbId: 6102,
      mediaType: MediaType.TV,
      title: 'Unknown',
      genreIds: [],
      createdAt,
      jellyfinPlayed: null,
    });

    const notWatched = await getLocalWatchlist({
      userId: user.id,
      query: {
        page: 1,
        category: 'all',
        sort: 'title_asc',
        watched: 'not_watched',
      },
    });
    assert.equal(notWatched.totalResults, 2);
    assert.deepEqual(
      notWatched.results.map((row) => [row.title, row.watchState]),
      [
        ['Not Watched', 'not_watched'],
        ['Unknown', 'unknown'],
      ]
    );

    const watched = await getLocalWatchlist({
      userId: user.id,
      query: {
        page: 1,
        category: 'all',
        sort: 'added_desc',
        watched: 'watched',
      },
    });
    assert.equal(watched.totalResults, 1);
    assert.equal(watched.results[0].watchState, 'watched');

    const all = await getLocalWatchlist({
      userId: user.id,
      query: {
        page: 1,
        category: 'all',
        sort: 'added_desc',
        watched: 'all',
      },
    });
    assert.equal(all.totalResults, 3);
    assert.equal(all.supportsWatchState, true);
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
    assert.equal(result.supportsWatchState, false);
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

describe('Watchlist enrichment migration', () => {
  const createLegacySchema = async (database: DataSource) => {
    const runner = database.createQueryRunner();
    await runner.query(
      `CREATE TABLE "user" ("id" integer PRIMARY KEY, "jellyfinUserId" varchar)`
    );
    await runner.query(`CREATE TABLE "media" ("id" integer PRIMARY KEY)`);
    await runner.query(
      `CREATE TABLE "watchlist" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "ratingKey" varchar NOT NULL,
        "mediaType" varchar NOT NULL,
        "title" varchar NOT NULL,
        "tmdbId" integer NOT NULL,
        "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        "requestedById" integer,
        "mediaId" integer,
        "genreIds" text,
        CONSTRAINT "UNIQUE_USER_DB" UNIQUE ("tmdbId", "mediaType", "requestedById"),
        CONSTRAINT "FK_ae34e6b153a90672eb9dc4857d7" FOREIGN KEY ("requestedById") REFERENCES "user" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_6641da8d831b93dfcb429f8b8bc" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE CASCADE
      )`
    );
    await runner.query(
      `CREATE INDEX "IDX_watchlist_user_created" ON "watchlist" ("requestedById", "createdAt")`
    );
    await runner.query(
      `CREATE INDEX "IDX_watchlist_user_type_title" ON "watchlist" ("requestedById", "mediaType", "title")`
    );
    return runner;
  };

  it('migrates and rolls back an empty legacy SQLite schema', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = await createLegacySchema(database);
    try {
      const migration = new AddWatchlistEnrichment1790000000014();
      await migration.up(runner);
      let table = await runner.getTable('watchlist');
      assert.ok(table?.findColumnByName('jellyfinPlayed'));
      assert.equal(
        table?.foreignKeys.find((key) => key.columnNames[0] === 'mediaId')
          ?.onDelete,
        'SET NULL'
      );

      await migration.down(runner);
      table = await runner.getTable('watchlist');
      assert.equal(table?.findColumnByName('jellyfinPlayed'), undefined);
      assert.equal(
        table?.foreignKeys.find((key) => key.columnNames[0] === 'mediaId')
          ?.onDelete,
        'CASCADE'
      );
      const userIndexes = (await runner.query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user'`
      )) as { name: string }[];
      assert.equal(
        userIndexes.some(
          ({ name }) => name === 'UQ_user_jellyfin_id_normalized'
        ),
        false
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('preserves legacy membership and makes Media deletion non-destructive', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = await createLegacySchema(database);
    try {
      await runner.query(
        `INSERT INTO "user" ("id", "jellyfinUserId") VALUES (1, '11111111111111111111111111111111')`
      );
      await runner.query(`INSERT INTO "media" ("id") VALUES (1)`);
      await runner.query(
        `INSERT INTO "watchlist" ("ratingKey", "mediaType", "title", "tmdbId", "createdAt", "updatedAt", "requestedById", "mediaId", "genreIds")
         VALUES ('', 'movie', 'Legacy', 10, '2025-01-01 00:00:00', '2025-01-01 00:00:00', 1, 1, '[18]')`
      );

      const migration = new AddWatchlistEnrichment1790000000014();
      await migration.up(runner);
      const [migrated] = (await runner.query(
        `SELECT "createdAt", "genreIds", "jellyfinPlayed", "jellyfinLastPlayedAt", "jellyfinPlayStateSyncedAt", "jellyfinPlayStateUserId" FROM "watchlist"`
      )) as Record<string, unknown>[];
      assert.match(String(migrated.createdAt), /2025-01-01/);
      assert.equal(migrated.genreIds, '[18]');
      assert.equal(migrated.jellyfinPlayed, null);
      assert.equal(migrated.jellyfinLastPlayedAt, null);
      assert.equal(migrated.jellyfinPlayStateSyncedAt, null);
      assert.equal(migrated.jellyfinPlayStateUserId, null);

      await runner.query(`DELETE FROM "media" WHERE "id" = 1`);
      const [preserved] = (await runner.query(
        `SELECT "mediaId" FROM "watchlist"`
      )) as { mediaId: number | null }[];
      assert.equal(preserved.mediaId, null);

      await assert.rejects(() =>
        runner.query(
          `INSERT INTO "user" ("id", "jellyfinUserId") VALUES (2, ' 11111111-1111-1111-1111-111111111111 ')`
        )
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('fails closed when legacy users contain normalized duplicate Jellyfin IDs', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = await createLegacySchema(database);
    try {
      await runner.query(
        `INSERT INTO "user" ("id", "jellyfinUserId") VALUES
          (1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
          (2, 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')`
      );
      await assert.rejects(() =>
        new AddWatchlistEnrichment1790000000014().up(runner)
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps the PostgreSQL migration contract aligned', () => {
    const migration = readFileSync(
      path.join(
        __dirname,
        '../migration/postgres/1790000000015-AddWatchlistEnrichment.ts'
      ),
      'utf8'
    );
    assert.match(migration, /type: 'timestamptz'/);
    assert.match(migration, /onDelete: 'SET NULL'/);
    assert.match(migration, /UQ_user_jellyfin_id_normalized/);
    assert.match(migration, /lower\(replace\(btrim\("jellyfinUserId"/);
  });
});
