import { AddLibraryHistoryFoundation1790000000018 } from '@server/migration/sqlite/1790000000018-AddLibraryHistoryFoundation';
import { AddCurrentEpisodeIdentityGeneration1790000000042 } from '@server/migration/sqlite/1790000000042-AddCurrentEpisodeIdentityGeneration';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('current Jellyfin Episode identity generation migration', () => {
  it('adds generation metadata without changing existing aliases', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(`CREATE TABLE "media" ("id" integer PRIMARY KEY)`);
      await runner.query(`CREATE TABLE "user" ("id" integer PRIMARY KEY)`);
      await new AddLibraryHistoryFoundation1790000000018().up(runner);
      await runner.query(
        `INSERT INTO "canonical_media" ("id", "mediaType", "titleSnapshot") ` +
          `VALUES (1, 'series', 'Preserved Series')`
      );
      await runner.query(
        `INSERT INTO "canonical_season" ("id", "seriesId", "seasonNumber") ` +
          `VALUES (2, 1, 1)`
      );
      await runner.query(
        `INSERT INTO "canonical_episode" ("id", "seasonId", "episodeNumber") ` +
          `VALUES (3, 2, 1)`
      );
      await runner.query(
        `INSERT INTO "canonical_episode_identity" ` +
          `("id", "canonicalEpisodeId", "provider", "sourceScope", "value") ` +
          `VALUES (4, 3, 'jellyfin', 'server', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`
      );
      await runner.query(
        `INSERT INTO "source_checkpoint" ` +
          `("id", "source", "sourceScope", "stage", "sourceGeneration", "status", "lastSuccessfulAt") VALUES ` +
          `(5, 'jellyfin', 'server', 'current-library', 'before-upgrade', 1, '2026-10-01 00:00:00.000'), ` +
          `(6, 'radarr', 'service:1', 'current-library', 'unchanged', 1, '2026-10-01 00:00:00.000'), ` +
          `(7, 'jellyfin', 'other-server', 'current-library', 'already-failed', 3, NULL)`
      );

      const migration = new AddCurrentEpisodeIdentityGeneration1790000000042();
      await migration.up(runner);
      assert.equal(
        await runner.hasColumn(
          'canonical_episode_identity',
          'lastSeenSourceGeneration'
        ),
        true
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "id", "canonicalEpisodeId", "provider", "sourceScope", "value", ` +
            `"lastSeenSourceGeneration" FROM "canonical_episode_identity"`
        ),
        [
          {
            id: 4,
            canonicalEpisodeId: 3,
            provider: 'jellyfin',
            sourceScope: 'server',
            value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            lastSeenSourceGeneration: null,
          },
        ]
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "id", "sourceGeneration", "status", "lastSuccessfulAt" ` +
            `FROM "source_checkpoint" WHERE "id" IN (5, 6, 7) ORDER BY "id"`
        ),
        [
          {
            id: 5,
            sourceGeneration: 'before-upgrade',
            status: 2,
            lastSuccessfulAt: '2026-10-01 00:00:00.000',
          },
          {
            id: 6,
            sourceGeneration: 'unchanged',
            status: 1,
            lastSuccessfulAt: '2026-10-01 00:00:00.000',
          },
          {
            id: 7,
            sourceGeneration: 'already-failed',
            status: 3,
            lastSuccessfulAt: null,
          },
        ]
      );
      const table = await runner.getTable('canonical_episode_identity');
      assert.ok(table);
      assert.equal(
        table.indices.some(
          ({ name }) =>
            name === 'IDX_canonical_episode_identity_current_generation'
        ),
        true
      );
      await runner.query(
        `UPDATE "canonical_episode_identity" ` +
          `SET "lastSeenSourceGeneration" = '42' WHERE "id" = 4`
      );
      assert.deepEqual(await runner.query('PRAGMA foreign_key_check'), []);

      await migration.down(runner);
      assert.equal(
        await runner.hasColumn(
          'canonical_episode_identity',
          'lastSeenSourceGeneration'
        ),
        false
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "id", "canonicalEpisodeId", "provider", "sourceScope", "value" ` +
            `FROM "canonical_episode_identity"`
        ),
        [
          {
            id: 4,
            canonicalEpisodeId: 3,
            provider: 'jellyfin',
            sourceScope: 'server',
            value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ]
      );
      assert.equal(
        (
          await runner.query(
            `SELECT "status" FROM "source_checkpoint" WHERE "id" = 5`
          )
        )[0].status,
        2
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps SQLite and PostgreSQL migrations on the shared implementation', () => {
    const root = process.cwd();
    for (const migrationPath of [
      'server/migration/sqlite/1790000000042-AddCurrentEpisodeIdentityGeneration.ts',
      'server/migration/postgres/1790000000043-AddCurrentEpisodeIdentityGeneration.ts',
    ]) {
      const migration = readFileSync(path.join(root, migrationPath), 'utf8');
      assert.match(migration, /addCurrentEpisodeIdentityGeneration/);
      assert.match(migration, /dropCurrentEpisodeIdentityGeneration/);
    }
  });
});
