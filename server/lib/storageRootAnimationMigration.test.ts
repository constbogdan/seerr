import { AddLibraryHistoryFoundation1790000000018 } from '@server/migration/sqlite/1790000000018-AddLibraryHistoryFoundation';
import { AddStorageRootAnimation1790000000030 } from '@server/migration/sqlite/1790000000030-AddStorageRootAnimation';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Storage root Animation migration', () => {
  it('adds a false-by-default designation and removes it cleanly', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(`CREATE TABLE "media" ("id" integer PRIMARY KEY)`);
      await runner.query(`CREATE TABLE "user" ("id" integer PRIMARY KEY)`);
      await new AddLibraryHistoryFoundation1790000000018().up(runner);
      await runner.query(
        `INSERT INTO "storage_root" ("servarrType", "serviceId", "sourceRootId", "pathSnapshot") ` +
          `VALUES ('radarr', 2, 9, '/media/animation')`
      );

      const migration = new AddStorageRootAnimation1790000000030();
      await migration.up(runner);
      assert.equal(await runner.hasColumn('storage_root', 'isAnimation'), true);
      assert.deepEqual(
        await runner.query(
          `SELECT "isAnimation" FROM "storage_root" WHERE "sourceRootId" = 9`
        ),
        [{ isAnimation: 0 }]
      );
      await runner.query(
        `UPDATE "storage_root" SET "isAnimation" = true WHERE "sourceRootId" = 9`
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "isAnimation" FROM "storage_root" WHERE "sourceRootId" = 9`
        ),
        [{ isAnimation: 1 }]
      );
      await migration.down(runner);
      assert.equal(
        await runner.hasColumn('storage_root', 'isAnimation'),
        false
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps SQLite and PostgreSQL migrations on the shared implementation', () => {
    const root = process.cwd();
    for (const migrationPath of [
      'server/migration/sqlite/1790000000030-AddStorageRootAnimation.ts',
      'server/migration/postgres/1790000000031-AddStorageRootAnimation.ts',
    ]) {
      const migration = readFileSync(path.join(root, migrationPath), 'utf8');
      assert.match(migration, /addStorageRootAnimation/);
      assert.match(migration, /removeStorageRootAnimation/);
    }
  });
});
