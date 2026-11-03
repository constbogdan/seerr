import { AddLibraryHistoryFoundation1790000000018 } from '@server/migration/sqlite/1790000000018-AddLibraryHistoryFoundation';
import { AddStorageRootColor1790000000032 } from '@server/migration/sqlite/1790000000032-AddStorageRootColor';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Storage root color migration', () => {
  it('adds and removes the optional color without changing root identity', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(`CREATE TABLE "media" ("id" integer PRIMARY KEY)`);
      await runner.query(`CREATE TABLE "user" ("id" integer PRIMARY KEY)`);
      await new AddLibraryHistoryFoundation1790000000018().up(runner);
      await runner.query(
        `INSERT INTO "storage_root" ("servarrType", "serviceId", "sourceRootId", "pathSnapshot") ` +
          `VALUES ('radarr', 2, 9, '/media/movies')`
      );

      const migration = new AddStorageRootColor1790000000032();
      await migration.up(runner);
      assert.equal(await runner.hasColumn('storage_root', 'color'), true);
      assert.deepEqual(
        await runner.query(
          `SELECT "servarrType", "serviceId", "sourceRootId", "color" FROM "storage_root"`
        ),
        [
          {
            servarrType: 'radarr',
            serviceId: 2,
            sourceRootId: 9,
            color: null,
          },
        ]
      );
      await runner.query(
        `UPDATE "storage_root" SET "color" = '#60a5fa' WHERE "sourceRootId" = 9`
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "color" FROM "storage_root" WHERE "sourceRootId" = 9`
        ),
        [{ color: '#60a5fa' }]
      );
      await migration.down(runner);
      assert.equal(await runner.hasColumn('storage_root', 'color'), false);
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps SQLite and PostgreSQL migrations on the shared implementation', () => {
    const root = process.cwd();
    for (const migrationPath of [
      'server/migration/sqlite/1790000000032-AddStorageRootColor.ts',
      'server/migration/postgres/1790000000033-AddStorageRootColor.ts',
    ]) {
      const migration = readFileSync(path.join(root, migrationPath), 'utf8');
      assert.match(migration, /addStorageRootColor/);
      assert.match(migration, /removeStorageRootColor/);
    }
  });
});
