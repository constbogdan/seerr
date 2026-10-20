import dataSource from '@server/datasource';
import { AddLibraryHistoryFoundation1790000000018 } from '@server/migration/sqlite/1790000000018-AddLibraryHistoryFoundation';
import { AddLibraryRemovalSource1790000000026 } from '@server/migration/sqlite/1790000000026-AddLibraryRemovalSource';
import { libraryHistoryTableNames } from '@server/utils/libraryHistoryMigration';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Library History Foundation migration', () => {
  it('applies additively to the released table boundary and rolls back cleanly', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(
        `CREATE TABLE "media" ("id" integer PRIMARY KEY, "marker" varchar)`
      );
      await runner.query(
        `CREATE TABLE "user" ("id" integer PRIMARY KEY, "marker" varchar)`
      );
      await runner.query(`INSERT INTO "media" VALUES (1, 'unchanged')`);
      await runner.query(`INSERT INTO "user" VALUES (1, 'unchanged')`);

      const migration = new AddLibraryHistoryFoundation1790000000018();
      await migration.up(runner);
      for (const tableName of libraryHistoryTableNames) {
        assert.equal(await runner.hasTable(tableName), true, tableName);
      }
      assert.deepEqual(await runner.query(`SELECT * FROM "media"`), [
        { id: 1, marker: 'unchanged' },
      ]);
      assert.deepEqual(await runner.query(`SELECT * FROM "user"`), [
        { id: 1, marker: 'unchanged' },
      ]);

      const viewer = await runner.getTable('viewer');
      assert.equal(
        viewer?.foreignKeys.find((key) => key.name === 'FK_viewer_user')
          ?.onDelete,
        'SET NULL'
      );
      const evidence = await runner.getTable('viewing_evidence');
      assert.equal(
        evidence?.foreignKeys.find(
          (key) => key.name === 'FK_viewing_evidence_media'
        )?.onDelete,
        'RESTRICT'
      );
      assert.ok(
        evidence?.uniques.some(
          (constraint) =>
            constraint.name === 'UQ_viewing_evidence_source_activity'
        )
      );
      for (const removed of [
        'mediaTypeSnapshot',
        'titleSnapshot',
        'seriesTitleSnapshot',
        'seasonNumberSnapshot',
        'episodeNumberSnapshot',
      ]) {
        assert.equal(evidence?.findColumnByName(removed), undefined, removed);
      }
      const season = await runner.getTable('canonical_season');
      assert.equal(season?.findColumnByName('titleSnapshot'), undefined);
      assert.equal(season?.findColumnByName('airDate'), undefined);
      const episode = await runner.getTable('canonical_episode');
      assert.equal(episode?.findColumnByName('titleSnapshot'), undefined);
      assert.ok(episode?.findColumnByName('airDate'));
      const viewerColumns = await runner.getTable('viewer');
      assert.equal(
        viewerColumns?.findColumnByName('displayNameSnapshot'),
        undefined
      );
      const file = await runner.getTable('library_file');
      assert.equal(file?.findColumnByName('sizeBytes')?.type, 'bigint');
      const expectedForeignKeys = [
        ['canonical_media', 'FK_canonical_media_current_media', 'SET NULL'],
        [
          'canonical_media_identity',
          'FK_canonical_media_identity_media',
          'CASCADE',
        ],
        ['canonical_season', 'FK_canonical_season_series', 'RESTRICT'],
        [
          'canonical_season_identity',
          'FK_canonical_season_identity_season',
          'CASCADE',
        ],
        ['canonical_episode', 'FK_canonical_episode_season', 'RESTRICT'],
        [
          'canonical_episode_identity',
          'FK_canonical_episode_identity_episode',
          'CASCADE',
        ],
        ['viewer', 'FK_viewer_user', 'SET NULL'],
        ['library_presence', 'FK_library_presence_media', 'RESTRICT'],
        ['library_presence', 'FK_library_presence_root', 'RESTRICT'],
        ['library_file', 'FK_library_file_presence', 'RESTRICT'],
        ['library_file', 'FK_library_file_root', 'RESTRICT'],
        ['library_file_episode', 'FK_library_file_episode_file', 'RESTRICT'],
        ['library_file_episode', 'FK_library_file_episode_episode', 'RESTRICT'],
        ['source_checkpoint', 'FK_source_checkpoint_run', 'SET NULL'],
        [
          'library_source_observation',
          'FK_library_source_observation_presence',
          'RESTRICT',
        ],
        [
          'library_source_observation',
          'FK_library_source_observation_run',
          'SET NULL',
        ],
        [
          'library_source_observation',
          'FK_library_source_observation_root',
          'RESTRICT',
        ],
        ['viewing_evidence', 'FK_viewing_evidence_viewer', 'RESTRICT'],
        ['viewing_evidence', 'FK_viewing_evidence_media', 'RESTRICT'],
        ['viewing_evidence', 'FK_viewing_evidence_episode', 'RESTRICT'],
      ] as const;
      const actualForeignKeys: [string, string, string | undefined][] = [];
      for (const tableName of libraryHistoryTableNames) {
        const table = await runner.getTable(tableName);
        for (const key of table?.foreignKeys ?? []) {
          actualForeignKeys.push([tableName, key.name ?? '', key.onDelete]);
        }
      }
      assert.deepEqual(
        actualForeignKeys.sort(),
        [...expectedForeignKeys].sort()
      );

      await migration.down(runner);
      for (const tableName of libraryHistoryTableNames) {
        assert.equal(await runner.hasTable(tableName), false, tableName);
      }
      assert.deepEqual(await runner.query(`SELECT * FROM "media"`), [
        { id: 1, marker: 'unchanged' },
      ]);
      assert.deepEqual(await runner.query(`SELECT * FROM "user"`), [
        { id: 1, marker: 'unchanged' },
      ]);
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('runs at the end of the complete SQLite migration chain', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'seerr-library-history-')
    );
    const databasePath = path.join(directory, 'db.sqlite3');
    const database = new DataSource({
      type: 'sqlite',
      database: databasePath,
      migrations: ['server/migration/sqlite/*.ts'],
      synchronize: false,
    });
    const entityDatabase = new DataSource({
      type: 'sqlite',
      database: databasePath,
      entities: dataSource.options.entities,
      synchronize: false,
    });
    try {
      await database.initialize();
      await database.runMigrations();
      const runner = database.createQueryRunner();
      for (const tableName of libraryHistoryTableNames) {
        assert.equal(await runner.hasTable(tableName), true);
      }
      assert.equal(await runner.hasTable('current_viewing_state'), true);
      const applied = await database.query(
        `SELECT "name" FROM "migrations" ORDER BY "id" DESC LIMIT 1`
      );
      assert.equal(applied[0].name, 'AddSeriesRelocation1790000000044');
      const normalizedJellyfinIndex = (await database.query(
        `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'UQ_user_jellyfin_id_normalized'`
      )) as { sql: string }[];
      assert.equal(normalizedJellyfinIndex.length, 1);
      assert.match(
        normalizedJellyfinIndex[0].sql,
        /lower\(replace\(trim\("jellyfinUserId"\), '-', ''\)\)/
      );
      await runner.release();
      await database.destroy();

      await entityDatabase.initialize();
      const schemaLog = await entityDatabase.driver.createSchemaBuilder().log();
      assert.deepEqual(
        schemaLog.upQueries.map(({ query }) => query),
        []
      );
      await entityDatabase.destroy();

      await database.initialize();
      await database.undoLastMigration();
      assert.equal(
        await database
          .createQueryRunner()
          .hasTable('series_relocation_execution'),
        false
      );
      await database.undoLastMigration();
      const identityGenerationRollbackRunner = database.createQueryRunner();
      assert.equal(
        await identityGenerationRollbackRunner.hasColumn(
          'canonical_episode_identity',
          'lastSeenSourceGeneration'
        ),
        false
      );
      assert.equal(
        await identityGenerationRollbackRunner.hasColumn(
          'hydration_run',
          'leaseExpiresAt'
        ),
        true
      );
      await identityGenerationRollbackRunner.release();
      await database.undoLastMigration();
      const leaseRollbackRunner = database.createQueryRunner();
      assert.equal(
        await leaseRollbackRunner.hasColumn('hydration_run', 'leaseExpiresAt'),
        false
      );
      assert.equal(
        await leaseRollbackRunner.hasTable('library_hydration_epoch'),
        true
      );
      await leaseRollbackRunner.release();
      await database.undoLastMigration();
      const epochRollbackRunner = database.createQueryRunner();
      assert.equal(
        await epochRollbackRunner.hasTable('library_hydration_epoch'),
        false
      );
      assert.equal(
        await epochRollbackRunner.hasTable('removal_execution'),
        true
      );
      await epochRollbackRunner.release();
      await database.undoLastMigration();
      const executionRollbackRunner = database.createQueryRunner();
      assert.equal(
        await executionRollbackRunner.hasTable('removal_execution'),
        false
      );
      assert.equal(
        await executionRollbackRunner.hasColumn('library_file', 'resolution'),
        true
      );
      await executionRollbackRunner.release();
      await database.undoLastMigration();
      const resolutionRollbackRunner = database.createQueryRunner();
      assert.equal(
        await resolutionRollbackRunner.hasColumn('library_file', 'resolution'),
        false
      );
      assert.equal(
        await resolutionRollbackRunner.hasColumn('storage_root', 'color'),
        true
      );
      await resolutionRollbackRunner.release();
      await database.undoLastMigration();
      const colorRollbackRunner = database.createQueryRunner();
      assert.equal(
        await colorRollbackRunner.hasColumn('storage_root', 'color'),
        false
      );
      assert.equal(
        await colorRollbackRunner.hasColumn('storage_root', 'isAnimation'),
        true
      );
      await colorRollbackRunner.release();
      await database.undoLastMigration();
      const animationRollbackRunner = database.createQueryRunner();
      assert.equal(
        await animationRollbackRunner.hasColumn('storage_root', 'isAnimation'),
        false
      );
      assert.equal(
        await animationRollbackRunner.hasColumn('storage_root', 'displayName'),
        true
      );
      await animationRollbackRunner.release();
      await database.undoLastMigration();
      const displayNameRollbackRunner = database.createQueryRunner();
      assert.equal(
        await displayNameRollbackRunner.hasColumn(
          'storage_root',
          'displayName'
        ),
        false
      );
      assert.equal(
        await displayNameRollbackRunner.hasColumn(
          'library_presence',
          'removalSource'
        ),
        true
      );
      await displayNameRollbackRunner.release();
      await database.undoLastMigration();
      const rollbackRunner = database.createQueryRunner();
      assert.equal(
        await rollbackRunner.hasColumn('library_presence', 'removalSource'),
        false
      );
      assert.equal(
        await rollbackRunner.hasColumn('library_file', 'removalSource'),
        false
      );
      assert.equal(await rollbackRunner.hasTable('removal_schedule'), true);
      await rollbackRunner.release();
      await database.undoLastMigration();
      const scheduleRollbackRunner = database.createQueryRunner();
      assert.equal(
        await scheduleRollbackRunner.hasTable('removal_schedule'),
        false
      );
      assert.equal(
        await scheduleRollbackRunner.hasTable('user_media_intent_occurrence'),
        true
      );
      assert.equal(
        await scheduleRollbackRunner.hasTable('current_viewing_state'),
        true
      );
      await scheduleRollbackRunner.release();
      await database.undoLastMigration();
      const normalizationRollbackRunner = database.createQueryRunner();
      assert.equal(
        await normalizationRollbackRunner.hasTable(
          'user_media_intent_occurrence'
        ),
        false
      );
      assert.equal(
        await normalizationRollbackRunner.hasTable('current_viewing_state'),
        true
      );
      await normalizationRollbackRunner.release();
      await database.undoLastMigration();
      const currentViewingRollbackRunner = database.createQueryRunner();
      assert.equal(
        await currentViewingRollbackRunner.hasTable('current_viewing_state'),
        false
      );
      assert.equal(
        await currentViewingRollbackRunner.hasTable('canonical_media'),
        true
      );
      assert.equal(await currentViewingRollbackRunner.hasTable('media'), true);
      await currentViewingRollbackRunner.release();
      await database.undoLastMigration();
      assert.equal(
        await database.createQueryRunner().hasTable('canonical_media'),
        false
      );
    } finally {
      if (database.isInitialized) await database.destroy();
      if (entityDatabase.isInitialized) await entityDatabase.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('backfills legacy ended generations as Unknown without marking current generations', async () => {
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
          `"canonicalMediaId", "sourceSystem", "sourceScope", "sourceItemId", "firstObservedAt", "removedAt", "isCurrent") VALUES ` +
          `(1, 'radarr', 'service:0', 'movie:1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0), ` +
          `(1, 'radarr', 'service:0', 'movie:2', CURRENT_TIMESTAMP, NULL, 1)`
      );
      await runner.query(
        `INSERT INTO "library_file" (` +
          `"libraryPresenceId", "sourceSystem", "sourceScope", "sourceFileId", "firstObservedAt", "removedAt", "isCurrent") VALUES ` +
          `(1, 'radarr', 'service:0', 'movie-file:1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 0), ` +
          `(2, 'radarr', 'service:0', 'movie-file:2', CURRENT_TIMESTAMP, NULL, 1)`
      );

      const migration = new AddLibraryRemovalSource1790000000026();
      await migration.up(runner);
      assert.deepEqual(
        await runner.query(
          `SELECT "removalSource" FROM "library_presence" ORDER BY "id"`
        ),
        [{ removalSource: 'unknown' }, { removalSource: null }]
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "removalSource" FROM "library_file" ORDER BY "id"`
        ),
        [{ removalSource: 'unknown' }, { removalSource: null }]
      );
      await migration.down(runner);
      assert.equal(
        await runner.hasColumn('library_presence', 'removalSource'),
        false
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps the paired PostgreSQL migration timezone-aware and schema-shared', () => {
    const root = process.cwd();
    const sqlite = readFileSync(
      path.join(
        root,
        'server/migration/sqlite/1790000000018-AddLibraryHistoryFoundation.ts'
      ),
      'utf8'
    );
    const postgres = readFileSync(
      path.join(
        root,
        'server/migration/postgres/1790000000019-AddLibraryHistoryFoundation.ts'
      ),
      'utf8'
    );
    const shared = readFileSync(
      path.join(root, 'server/utils/libraryHistoryMigration.ts'),
      'utf8'
    );
    const currentSqlite = readFileSync(
      path.join(
        root,
        'server/migration/sqlite/1790000000020-AddCurrentViewingState.ts'
      ),
      'utf8'
    );
    const currentPostgres = readFileSync(
      path.join(
        root,
        'server/migration/postgres/1790000000021-AddCurrentViewingState.ts'
      ),
      'utf8'
    );
    const currentShared = readFileSync(
      path.join(root, 'server/utils/currentViewingMigration.ts'),
      'utf8'
    );
    const removalSourceSqlite = readFileSync(
      path.join(
        root,
        'server/migration/sqlite/1790000000026-AddLibraryRemovalSource.ts'
      ),
      'utf8'
    );
    const removalSourcePostgres = readFileSync(
      path.join(
        root,
        'server/migration/postgres/1790000000027-AddLibraryRemovalSource.ts'
      ),
      'utf8'
    );
    assert.match(sqlite, /createLibraryHistoryTables/);
    assert.match(sqlite, /timestampType: 'datetime'/);
    assert.match(postgres, /createLibraryHistoryTables/);
    assert.match(postgres, /timestampType: 'timestamptz'/);
    assert.match(postgres, /trueDefault: 'true'/);
    assert.match(shared, /type: 'bigint'/);
    assert.match(shared, /UQ_viewing_evidence_source_activity/);
    assert.doesNotMatch(shared, /media_protection/);
    assert.match(currentSqlite, /timestampType: 'datetime'/);
    assert.match(currentPostgres, /timestampType: 'timestamptz'/);
    assert.match(currentShared, /UQ_current_viewing_state_source_item/);
    assert.match(currentShared, /FK_current_viewing_state_episode/);
    assert.match(removalSourceSqlite, /addLibraryRemovalSource/);
    assert.match(removalSourcePostgres, /addLibraryRemovalSource/);
  });
});
