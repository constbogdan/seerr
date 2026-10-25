import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource, type QueryRunner } from 'typeorm';

import { AddSeriesRelocation1790000000045 } from '@server/migration/postgres/1790000000045-AddSeriesRelocation';

describe('Series relocation migration', () => {
  it('creates the additive SQLite authority table and reverses cleanly', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'seerr-relocation-'));
    const database = new DataSource({
      type: 'sqlite',
      database: path.join(directory, 'db.sqlite3'),
      migrations: ['server/migration/sqlite/*.ts'],
      synchronize: false,
    });
    try {
      await database.initialize();
      const applied = await database.runMigrations();
      assert.equal(applied.at(-1)?.name, 'AddFreshV21790000000048');
      const runner = database.createQueryRunner();
      assert.equal(await runner.hasTable('series_relocation_execution'), true);
      const table = await runner.getTable('series_relocation_execution');
      assert.ok(table?.findColumnByName('expectedEpisodeFileIds'));
      assert.ok(table?.findColumnByName('providerAcceptedAt'));
      assert.ok(
        table?.indices.some(
          (index) => index.name === 'IDX_series_relocation_state_updated'
        )
      );
      assert.deepEqual(await database.query('PRAGMA foreign_key_check'), []);

      await database.undoLastMigration();
      assert.equal(await runner.hasTable('fresh_discovery'), false);
      await database.undoLastMigration();
      assert.equal(
        await runner.hasColumn('canonical_media', 'tmdbCollectionId'),
        false
      );
      await database.undoLastMigration();
      assert.equal(await runner.hasTable('series_relocation_execution'), false);
      await runner.release();
    } finally {
      if (database.isInitialized) await database.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses PostgreSQL timestamps and deterministic table SQL', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (statement: string) => statements.push(statement),
    } as unknown as QueryRunner;
    const migration = new AddSeriesRelocation1790000000045();

    await migration.up(runner);
    assert.match(statements[0], /series_relocation_execution/);
    assert.match(statements[0], /timestamp without time zone/);
    assert.match(statements[0], /UQ_series_relocation_active/);
    assert.match(statements[0], /ON DELETE RESTRICT/);
    statements.length = 0;
    await migration.down(runner);
    assert.deepEqual(statements, ['DROP TABLE "series_relocation_execution"']);
  });
});
