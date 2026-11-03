import { AddLibraryHistoryFoundation1790000000018 } from '@server/migration/sqlite/1790000000018-AddLibraryHistoryFoundation';
import { AddStorageRootDisplayName1790000000028 } from '@server/migration/sqlite/1790000000028-AddStorageRootDisplayName';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Storage root display-name migration', () => {
  it('adds and removes the optional column without changing root identity', async () => {
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

      const migration = new AddStorageRootDisplayName1790000000028();
      await migration.up(runner);
      assert.equal(await runner.hasColumn('storage_root', 'displayName'), true);
      await runner.query(
        `UPDATE "storage_root" SET "displayName" = 'Movies' WHERE "sourceRootId" = 9`
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "servarrType", "serviceId", "sourceRootId", "displayName" FROM "storage_root"`
        ),
        [
          {
            servarrType: 'radarr',
            serviceId: 2,
            sourceRootId: 9,
            displayName: 'Movies',
          },
        ]
      );
      await migration.down(runner);
      assert.equal(
        await runner.hasColumn('storage_root', 'displayName'),
        false
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps SQLite and PostgreSQL migrations on the shared implementation', () => {
    const root = process.cwd();
    const sqlite = readFileSync(
      path.join(
        root,
        'server/migration/sqlite/1790000000028-AddStorageRootDisplayName.ts'
      ),
      'utf8'
    );
    const postgres = readFileSync(
      path.join(
        root,
        'server/migration/postgres/1790000000029-AddStorageRootDisplayName.ts'
      ),
      'utf8'
    );
    for (const migration of [sqlite, postgres]) {
      assert.match(migration, /addStorageRootDisplayName/);
      assert.match(migration, /removeStorageRootDisplayName/);
    }
  });
});
