import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AddRemovalExecutions1790000000037 } from '@server/migration/postgres/1790000000037-AddRemovalExecutions';
import { AddLibraryHydrationEpoch1790000000039 } from '@server/migration/postgres/1790000000039-AddLibraryHydrationEpoch';
import { DataSource, type QueryRunner } from 'typeorm';

describe('removal execution migration', () => {
  it('creates and rolls back the paired execution and claim schema', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'seerr-removal-schema-'));
    const databasePath = path.join(directory, 'db.sqlite3');
    const database = new DataSource({
      type: 'sqlite',
      database: databasePath,
      migrations: ['server/migration/sqlite/*.ts'],
      synchronize: false,
    });
    try {
      await database.initialize();
      const applied = await database.runMigrations();
      assert.equal(applied.at(-1)?.name, 'AddHydrationRunLeases1790000000040');
      const runner = database.createQueryRunner();
      const execution = await runner.getTable('removal_execution');
      const claim = await runner.getTable('removal_execution_claim');
      assert.ok(execution);
      assert.ok(claim);
      assert.deepEqual(execution.foreignKeys.map(({ name }) => name).sort(), [
        'FK_removal_execution_media',
        'FK_removal_execution_presence',
      ]);
      assert.deepEqual(claim.foreignKeys.map(({ name }) => name).sort(), [
        'FK_removal_execution_claim_execution',
        'FK_removal_execution_claim_media',
      ]);
      assert.deepEqual(execution.indices.map(({ name }) => name).sort(), [
        'IDX_removal_execution_media_created',
        'IDX_removal_execution_schedule',
        'IDX_removal_execution_state_updated',
      ]);
      assert.deepEqual(
        claim.indices.map(({ name }) => name),
        ['IDX_removal_execution_claim_lease']
      );
      assert.deepEqual(await runner.query('PRAGMA foreign_key_check'), []);
      await runner.release();

      await database.undoLastMigration();
      assert.equal(
        await database
          .createQueryRunner()
          .hasColumn('hydration_run', 'leaseExpiresAt'),
        false
      );
      await database.undoLastMigration();
      assert.equal(
        await database.createQueryRunner().hasTable('library_hydration_epoch'),
        false
      );
      await database.undoLastMigration();
      const rollback = database.createQueryRunner();
      assert.equal(await rollback.hasTable('removal_execution_claim'), false);
      assert.equal(await rollback.hasTable('removal_execution'), false);
      assert.equal(await rollback.hasTable('removal_schedule'), true);
      await rollback.release();
    } finally {
      if (database.isInitialized) await database.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('upgrades the R1 schema additively without changing existing schedules', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'seerr-removal-upgrade-')
    );
    const databasePath = path.join(directory, 'db.sqlite3');
    const database = new DataSource({
      type: 'sqlite',
      database: databasePath,
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
        `INSERT INTO "canonical_media" ("id", "mediaType", "titleSnapshot") VALUES (7001, 'movie', 'Preserved schedule')`
      );
      await database.query(
        `INSERT INTO "removal_schedule" ("id", "canonicalMediaId", "targetType", "sourceSystem", "sourceScope", "origin", "status", "activeKey", "scheduledAt", "removeAt", "revision") VALUES (8001, 7001, 'movie', 'radarr', 'service:0', 'manual', 'active', 'service:0:7001:movie:-', '2026-10-01 00:00:00', '2026-12-01 00:00:00', 4)`
      );

      const applied = await database.runMigrations();
      assert.deepEqual(
        applied.map(({ name }) => name),
        [
          'AddRemovalExecutions1790000000036',
          'AddLibraryHydrationEpoch1790000000038',
          'AddHydrationRunLeases1790000000040',
        ]
      );
      assert.deepEqual(
        await database.query(
          `SELECT "id", "canonicalMediaId", "status", "activeKey", "revision" FROM "removal_schedule" WHERE "id" = 8001`
        ),
        [
          {
            id: 8001,
            canonicalMediaId: 7001,
            status: 'active',
            activeKey: 'service:0:7001:movie:-',
            revision: 4,
          },
        ]
      );
      assert.equal(
        Number(
          (
            await database.query(
              `SELECT COUNT(*) AS "count" FROM "removal_execution"`
            )
          )[0].count
        ),
        0
      );
      assert.equal(
        Number(
          (
            await database.query(
              `SELECT COUNT(*) AS "count" FROM "removal_execution_claim"`
            )
          )[0].count
        ),
        0
      );
      assert.deepEqual(await database.query('PRAGMA foreign_key_check'), []);
    } finally {
      if (database.isInitialized) await database.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the shared schema with timezone-neutral PostgreSQL timestamps', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: async (statement: string) => {
        statements.push(statement);
      },
    } as QueryRunner;
    const migration = new AddRemovalExecutions1790000000037();

    await migration.up(queryRunner);
    const schema = statements.join('\n');
    assert.match(schema, /CREATE TABLE "removal_execution"/);
    assert.match(schema, /CREATE TABLE "removal_execution_claim"/);
    assert.match(schema, /timestamp without time zone/);
    assert.match(schema, /FK_removal_execution_claim_execution/);
    assert.match(schema, /IDX_removal_execution_claim_lease/);

    statements.length = 0;
    await migration.down(queryRunner);
    assert.deepEqual(statements, [
      'DROP TABLE "removal_execution_claim"',
      'DROP TABLE "removal_execution"',
    ]);
  });

  it('defines the paired PostgreSQL hydration epoch barrier additively', async () => {
    const statements: string[] = [];
    const queryRunner = {
      query: async (statement: string) => {
        statements.push(statement);
      },
    } as QueryRunner;
    const migration = new AddLibraryHydrationEpoch1790000000039();

    await migration.up(queryRunner);
    assert.match(statements[0], /CREATE TABLE "library_hydration_epoch"/);
    assert.match(
      statements[0],
      /PRIMARY KEY \("sourceSystem", "sourceScope"\)/
    );
    assert.match(statements[0], /"epoch" integer NOT NULL DEFAULT 0/);

    statements.length = 0;
    await migration.down(queryRunner);
    assert.deepEqual(statements, ['DROP TABLE "library_hydration_epoch"']);
  });
});
