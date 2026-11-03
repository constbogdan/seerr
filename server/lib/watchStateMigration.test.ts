import { PromoteWatchState1790000000016 } from '@server/migration/sqlite/1790000000016-PromoteWatchState';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('reusable watched-state migration', () => {
  const createEnrichedSchema = async (database: DataSource) => {
    const runner = database.createQueryRunner();
    await runner.query(
      `CREATE TABLE "user" ("id" integer PRIMARY KEY, "jellyfinUserId" varchar)`
    );
    await runner.query(`CREATE TABLE "media" ("id" integer PRIMARY KEY)`);
    await runner.query(`
      CREATE TABLE "watchlist" (
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
        "jellyfinPlayed" boolean,
        "jellyfinLastPlayedAt" datetime,
        "jellyfinPlayStateSyncedAt" datetime,
        "jellyfinPlayStateUserId" varchar(32),
        CONSTRAINT "UNIQUE_USER_DB" UNIQUE ("tmdbId", "mediaType", "requestedById"),
        CONSTRAINT "FK_watchlist_user" FOREIGN KEY ("requestedById") REFERENCES "user" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_watchlist_media" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE SET NULL
      )
    `);
    await runner.query(
      `CREATE INDEX "IDX_watchlist_user_played_created" ON "watchlist" ("requestedById", "jellyfinPlayed", "createdAt")`
    );
    return runner;
  };

  it('moves exact true/false/unknown state and includes existing users in metrics', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = await createEnrichedSchema(database);
    try {
      await runner.query(`
        INSERT INTO "user" ("id", "jellyfinUserId") VALUES
          (1, '11111111111111111111111111111111'),
          (2, '22222222222222222222222222222222'),
          (3, '33333333333333333333333333333333')
      `);
      await runner.query(`INSERT INTO "media" ("id") VALUES (9), (10), (11)`);
      await runner.query(`
        INSERT INTO "watchlist" (
          "ratingKey", "mediaType", "title", "tmdbId", "requestedById",
          "mediaId", "jellyfinPlayed", "jellyfinLastPlayedAt",
          "jellyfinPlayStateSyncedAt", "jellyfinPlayStateUserId"
        ) VALUES
          ('', 'movie', 'Watched', 42, 1, 9, 1,
           '2026-09-01 00:00:00', '2026-09-02 00:00:00',
           '11111111111111111111111111111111'),
          ('', 'movie', 'Not watched', 43, 2, 10, 0,
           NULL, '2026-09-03 00:00:00',
           '22222222222222222222222222222222'),
          ('', 'tv', 'Unknown', 44, 3, 11, NULL,
           NULL, NULL, NULL)
      `);

      const migration = new PromoteWatchState1790000000016();
      await migration.up(runner);
      const states = (await runner.query(
        `SELECT * FROM "user_media_state" ORDER BY "tmdbId"`
      )) as Record<string, unknown>[];
      assert.equal(states.length, 3);
      const [state, notWatched, unknown] = states;
      assert.equal(state.userId, 1);
      assert.equal(state.mediaType, 'movie');
      assert.equal(state.tmdbId, 42);
      assert.equal(state.mediaId, 9);
      assert.equal(state.jellyfinPlayed, 1);
      assert.match(String(state.jellyfinLastPlayedAt), /2026-09-01/);
      assert.equal(notWatched.jellyfinPlayed, 0);
      assert.equal(unknown.jellyfinPlayed, null);
      const users = (await runner.query(
        `SELECT "includeInUserMetrics" FROM "user" ORDER BY "id"`
      )) as { includeInUserMetrics: number }[];
      assert.deepEqual(
        users.map((user) => user.includeInUserMetrics),
        [1, 1, 1]
      );
      const watchlist = await runner.getTable('watchlist');
      assert.equal(watchlist?.findColumnByName('jellyfinPlayed'), undefined);

      await runner.query(`DELETE FROM "watchlist" WHERE "id" = 1`);
      assert.equal(
        Number(
          (
            (await runner.query(
              `SELECT COUNT(*) AS count FROM "user_media_state"`
            )) as { count: number }[]
          )[0].count
        ),
        3
      );

      await migration.down(runner);
      const restored = await runner.getTable('watchlist');
      assert.ok(restored?.findColumnByName('jellyfinPlayed'));
      assert.equal(await runner.hasTable('user_media_state'), false);
      assert.equal(
        (await runner.getTable('user'))?.findColumnByName(
          'includeInUserMetrics'
        ),
        undefined
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('preserves only an explicit prototype Service exclusion', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = await createEnrichedSchema(database);
    try {
      await runner.query(
        `ALTER TABLE "user" ADD COLUMN "classification" integer NOT NULL DEFAULT 1`
      );
      await runner.query(`
        INSERT INTO "user" ("id", "jellyfinUserId", "classification") VALUES
          (1, NULL, 1),
          (2, NULL, 2)
      `);
      const migration = new PromoteWatchState1790000000016();
      await migration.up(runner);
      const users = (await runner.query(
        `SELECT "id", "includeInUserMetrics" FROM "user" ORDER BY "id"`
      )) as { id: number; includeInUserMetrics: number }[];
      assert.deepEqual(users, [
        { id: 1, includeInUserMetrics: 1 },
        { id: 2, includeInUserMetrics: 0 },
      ]);
      assert.equal(
        (await runner.getTable('user'))?.findColumnByName('classification'),
        undefined
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps SQLite and PostgreSQL migration contracts aligned', () => {
    const root = process.cwd();
    const sqlite = readFileSync(
      path.join(
        root,
        'server/migration/sqlite/1790000000016-PromoteWatchState.ts'
      ),
      'utf8'
    );
    const postgres = readFileSync(
      path.join(
        root,
        'server/migration/postgres/1790000000017-PromoteWatchState.ts'
      ),
      'utf8'
    );
    for (const source of [sqlite, postgres]) {
      assert.match(source, /user_media_state/);
      assert.match(source, /UQ_user_media_state_identity/);
      assert.match(source, /includeInUserMetrics/);
      assert.match(source, /classification/);
      assert.match(source, /INSERT INTO "user_media_state"/);
      assert.match(source, /dropColumns\('watchlist'/);
    }
  });
});
