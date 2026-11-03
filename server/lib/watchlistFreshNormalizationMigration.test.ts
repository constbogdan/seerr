import { NormalizeWatchlistAndFresh1790000000022 } from '@server/migration/sqlite/1790000000022-NormalizeWatchlistAndFresh';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Watchlist and Fresh normalization migration', () => {
  it('backfills exact active intent and removes only Fresh presentation columns', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(
        `CREATE TABLE "user" ("id" integer PRIMARY KEY NOT NULL)`
      );
      await runner.query(`INSERT INTO "user" ("id") VALUES (1)`);
      await runner.query(
        `CREATE TABLE "viewing_evidence" ("id" integer PRIMARY KEY NOT NULL)`
      );
      await runner.query(
        `CREATE TABLE "watchlist" (` +
          `"id" integer PRIMARY KEY NOT NULL, "requestedById" integer NOT NULL, ` +
          `"mediaType" varchar(8) NOT NULL, "tmdbId" integer NOT NULL, ` +
          `"createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL)`
      );
      await runner.query(
        `INSERT INTO "watchlist" VALUES (1, 1, 'movie', 42, '2026-01-02 03:04:05', '2026-01-03 03:04:05')`
      );
      await runner.query(
        `CREATE TABLE "fresh_media" (` +
          `"id" integer PRIMARY KEY NOT NULL, "mediaType" varchar(8) NOT NULL, ` +
          `"tmdbId" integer NOT NULL, "displayTitle" varchar(300) NOT NULL, ` +
          `"sortTitle" varchar(300) NOT NULL, "mediaDate" varchar(10), ` +
          `"originalLanguage" varchar(20) NOT NULL, "voteAverage" float NOT NULL, ` +
          `"voteCount" integer NOT NULL, "genreIds" text NOT NULL, ` +
          `"contentRating" varchar(32) NOT NULL, "contentRatingRegion" varchar(8) NOT NULL, ` +
          `"originalTitle" varchar(300), "posterPath" varchar(500), ` +
          `"backdropPath" varchar(500), "overview" text, "popularity" float, ` +
          `"adult" boolean, "video" boolean, "originCountries" text)`
      );
      await runner.query(
        `INSERT INTO "fresh_media" VALUES (` +
          `1, 'movie', 99, 'Display', 'display', '2026-01-01', 'en', 8, 100, ` +
          `'[18]', 'R', 'US', 'Original', '/poster', '/backdrop', 'Overview', 10, 0, 0, '[]')`
      );

      await new NormalizeWatchlistAndFresh1790000000022().up(runner);

      const occurrences = (await runner.query(
        `SELECT "userId", "intentType", "mediaType", "tmdbId", "state", "startedAt" FROM "user_media_intent_occurrence"`
      )) as Record<string, unknown>[];
      assert.deepEqual(occurrences, [
        {
          userId: 1,
          intentType: 'WATCHLIST',
          mediaType: 'movie',
          tmdbId: 42,
          state: 'ACTIVE',
          startedAt: '2026-01-02 03:04:05',
        },
      ]);
      const columns = (await runner.getTable('fresh_media'))!.columns.map(
        (column) => column.name
      );
      for (const removed of [
        'originalTitle',
        'posterPath',
        'backdropPath',
        'overview',
        'popularity',
        'adult',
        'video',
        'originCountries',
      ]) {
        assert.equal(columns.includes(removed), false);
      }
      assert.equal(columns.includes('displayTitle'), true);
      assert.equal(columns.includes('mediaDate'), true);
      assert.equal(
        (await runner.query(`SELECT COUNT(*) AS count FROM "fresh_media"`))[0]
          .count,
        1
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps PostgreSQL parity and a partial unique ACTIVE constraint', () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        'server/migration/postgres/1790000000023-NormalizeWatchlistAndFresh.ts'
      ),
      'utf8'
    );
    const utility = readFileSync(
      path.join(
        process.cwd(),
        'server/utils/watchlistFreshNormalizationMigration.ts'
      ),
      'utf8'
    );
    assert.match(source, /timestampType: 'timestamptz'/);
    assert.match(source, /idDefinition: 'SERIAL PRIMARY KEY'/);
    assert.match(utility, /UQ_user_media_intent_active/);
    assert.match(utility, /WHERE "state" = 'ACTIVE'/);
  });
});
