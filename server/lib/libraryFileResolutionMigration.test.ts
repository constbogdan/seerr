import { AddLibraryHistoryFoundation1790000000018 } from '@server/migration/sqlite/1790000000018-AddLibraryHistoryFoundation';
import { AddLibraryFileResolution1790000000034 } from '@server/migration/sqlite/1790000000034-AddLibraryFileResolution';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Library file resolution migration', () => {
  it('adds and removes the optional resolution without changing file identity', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(`CREATE TABLE "media" ("id" integer PRIMARY KEY)`);
      await runner.query(`CREATE TABLE "user" ("id" integer PRIMARY KEY)`);
      await new AddLibraryHistoryFoundation1790000000018().up(runner);
      await runner.query(
        `INSERT INTO "canonical_media" ("mediaType") VALUES ('movie')`
      );
      await runner.query(
        `INSERT INTO "library_presence" (` +
          `"canonicalMediaId", "sourceSystem", "sourceScope", "sourceItemId", "sourceGeneration") ` +
          `VALUES (1, 'radarr', 'service:1', 'movie:10', '1')`
      );
      await runner.query(
        `INSERT INTO "library_file" (` +
          `"libraryPresenceId", "sourceSystem", "sourceScope", "sourceFileId", "sourceGeneration") ` +
          `VALUES (1, 'radarr', 'service:1', 'movie-file:20', '1')`
      );

      const migration = new AddLibraryFileResolution1790000000034();
      await migration.up(runner);
      assert.equal(await runner.hasColumn('library_file', 'resolution'), true);
      assert.deepEqual(
        await runner.query(
          `SELECT "sourceFileId", "resolution" FROM "library_file"`
        ),
        [{ sourceFileId: 'movie-file:20', resolution: null }]
      );
      await runner.query(
        `UPDATE "library_file" SET "resolution" = 2160 WHERE "sourceFileId" = 'movie-file:20'`
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "resolution" FROM "library_file" WHERE "sourceFileId" = 'movie-file:20'`
        ),
        [{ resolution: 2160 }]
      );
      await migration.down(runner);
      assert.equal(await runner.hasColumn('library_file', 'resolution'), false);
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps SQLite and PostgreSQL migrations on the shared implementation', () => {
    const root = process.cwd();
    for (const migrationPath of [
      'server/migration/sqlite/1790000000034-AddLibraryFileResolution.ts',
      'server/migration/postgres/1790000000035-AddLibraryFileResolution.ts',
    ]) {
      const migration = readFileSync(path.join(root, migrationPath), 'utf8');
      assert.match(migration, /addLibraryFileResolution/);
      assert.match(migration, /removeLibraryFileResolution/);
    }
  });
});
