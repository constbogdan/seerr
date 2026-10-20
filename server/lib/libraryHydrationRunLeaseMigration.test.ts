import { AddHydrationRunLeases1790000000041 } from '@server/migration/postgres/1790000000041-AddHydrationRunLeases';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource, type QueryRunner, type TableColumn } from 'typeorm';

describe('hydration run lease migration', () => {
  it('upgrades SQLite additively and preserves existing hydration runs', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'seerr-run-leases-'));
    const database = new DataSource({
      type: 'sqlite',
      database: path.join(directory, 'db.sqlite3'),
      migrations: ['server/migration/sqlite/*.ts'],
      synchronize: false,
    });
    try {
      await database.initialize();
      await database.runMigrations();
      await database.undoLastMigration();
      await database.undoLastMigration();
      await database.undoLastMigration();
      await database.query(
        `INSERT INTO "hydration_run" ("id", "source", "sourceScope", "stage", "status", "startedAt") VALUES (9001, 'radarr', 'service:1', 'current-library', 2, '2026-10-01 00:00:00')`
      );

      const applied = await database.runMigrations();
      assert.equal(applied.at(-1)?.name, 'AddSeriesRelocation1790000000044');
      assert.deepEqual(
        await database.query(
          `SELECT "id", "source", "status", "heartbeatAt", "leaseExpiresAt" FROM "hydration_run" WHERE "id" = 9001`
        ),
        [
          {
            id: 9001,
            source: 'radarr',
            status: 2,
            heartbeatAt: null,
            leaseExpiresAt: null,
          },
        ]
      );
      const index = await database.query(
        `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'IDX_hydration_run_status_lease'`
      );
      assert.equal(index.length, 1);
      assert.match(index[0].sql, /"status", "leaseExpiresAt"/);
      assert.deepEqual(await database.query('PRAGMA foreign_key_check'), []);
    } finally {
      if (database.isInitialized) await database.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses timezone-neutral PostgreSQL lease timestamps and reversible columns', async () => {
    const added: TableColumn[] = [];
    const dropped: string[] = [];
    const statements: string[] = [];
    const runner = {
      addColumns: async (_table: string, columns: TableColumn[]) => {
        added.push(...columns);
      },
      dropColumns: async (_table: string, columns: string[]) => {
        dropped.push(...columns);
      },
      query: async (statement: string) => {
        statements.push(statement);
      },
    } as unknown as QueryRunner;
    const migration = new AddHydrationRunLeases1790000000041();

    await migration.up(runner);
    assert.deepEqual(
      added.map(({ name, type, isNullable }) => ({ name, type, isNullable })),
      [
        {
          name: 'heartbeatAt',
          type: 'timestamp without time zone',
          isNullable: true,
        },
        {
          name: 'leaseExpiresAt',
          type: 'timestamp without time zone',
          isNullable: true,
        },
      ]
    );
    assert.match(statements[0], /IDX_hydration_run_status_lease/);

    statements.length = 0;
    await migration.down(runner);
    assert.deepEqual(statements, [
      'DROP INDEX "IDX_hydration_run_status_lease"',
    ]);
    assert.deepEqual(dropped, ['leaseExpiresAt', 'heartbeatAt']);
  });
});
