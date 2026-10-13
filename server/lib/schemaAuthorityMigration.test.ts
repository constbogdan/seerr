import dataSource from '@server/datasource';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { MigrationInterface } from 'typeorm';
import { DataSource } from 'typeorm';

type MigrationConstructor = new () => MigrationInterface;

const migrationTimestamp = (migration: MigrationInterface): number => {
  const name = migration.name ?? migration.constructor.name;
  return Number(name.match(/(\d+)$/)?.[1]);
};

describe('migration/entity schema authority', () => {
  it('upgrades the released SQLite schema without changing data or metadata', async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'seerr-schema-authority-')
    );
    const databasePath = path.join(directory, 'db.sqlite3');
    const catalog = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      migrations: ['server/migration/sqlite/*.ts'],
      synchronize: false,
    });
    let released: DataSource | undefined;
    let current: DataSource | undefined;
    let entityDatabase: DataSource | undefined;
    try {
      await catalog.initialize();
      const releasedMigrations = catalog.migrations
        .filter((migration) => migrationTimestamp(migration) <= 1789257612345)
        .map(
          (migration) =>
            migration.constructor as unknown as MigrationConstructor
        );
      await catalog.destroy();

      released = new DataSource({
        type: 'sqlite',
        database: databasePath,
        migrations: releasedMigrations,
        synchronize: false,
      });
      await released.initialize();
      const releasedApplied = await released.runMigrations();
      assert.equal(
        releasedApplied.at(-1)?.name,
        'RemapOverseerrDeletedStatus1789257612345'
      );
      await released.query(
        `INSERT INTO "user" ("id", "email", "permissions", "avatar", "userType") VALUES (101, 'r1@example.com', 32, '/avatar.png', 3)`
      );
      await released.query(
        `INSERT INTO "media" ("id", "mediaType", "tmdbId") VALUES (201, 'movie', 301)`
      );
      await released.query(
        `INSERT INTO "watchlist" ("id", "ratingKey", "mediaType", "title", "tmdbId", "requestedById", "mediaId") VALUES (401, 'rating-key', 'movie', 'Preserved Movie', 301, 101, 201)`
      );
      await released.destroy();

      current = new DataSource({
        type: 'sqlite',
        database: databasePath,
        migrations: ['server/migration/sqlite/*.ts'],
        synchronize: false,
      });
      await current.initialize();
      const currentApplied = await current.runMigrations();
      assert.equal(
        currentApplied.at(-1)?.name,
        'AddHydrationRunLeases1790000000040'
      );

      assert.deepEqual(
        await current.query(
          `SELECT "id", "email", "permissions", "avatar", "userType", "includeInUserMetrics" FROM "user" WHERE "id" = 101`
        ),
        [
          {
            id: 101,
            email: 'r1@example.com',
            permissions: 32,
            avatar: '/avatar.png',
            userType: 3,
            includeInUserMetrics: 1,
          },
        ]
      );
      assert.deepEqual(
        await current.query(
          `SELECT "id", "mediaType", "tmdbId" FROM "media" WHERE "id" = 201`
        ),
        [{ id: 201, mediaType: 'movie', tmdbId: 301 }]
      );
      assert.deepEqual(
        await current.query(
          `SELECT "id", "title", "tmdbId", "requestedById", "mediaId" FROM "watchlist" WHERE "id" = 401`
        ),
        [
          {
            id: 401,
            title: 'Preserved Movie',
            tmdbId: 301,
            requestedById: 101,
            mediaId: 201,
          },
        ]
      );
      assert.deepEqual(
        await current.query(
          `SELECT "userId", "mediaType", "tmdbId", "mediaId" FROM "user_media_state"`
        ),
        [{ userId: 101, mediaType: 'movie', tmdbId: 301, mediaId: 201 }]
      );
      assert.deepEqual(
        await current.query(
          `SELECT "userId", "intentType", "mediaType", "tmdbId", "state" FROM "user_media_intent_occurrence"`
        ),
        [
          {
            userId: 101,
            intentType: 'WATCHLIST',
            mediaType: 'movie',
            tmdbId: 301,
            state: 'ACTIVE',
          },
        ]
      );
      assert.deepEqual(await current.query(`PRAGMA foreign_key_check`), []);

      const runner = current.createQueryRunner();
      const userMediaState = await runner.getTable('user_media_state');
      assert.equal(
        userMediaState?.findColumnByName('userId')?.isNullable,
        false
      );
      assert.deepEqual(
        userMediaState?.foreignKeys.map(({ name }) => name).sort(),
        ['FK_user_media_state_media', 'FK_user_media_state_user']
      );
      assert.deepEqual(userMediaState?.indices.map(({ name }) => name).sort(), [
        'IDX_user_media_state_mediaId',
        'IDX_user_media_state_tmdbId',
        'IDX_user_media_state_userId',
        'IDX_user_media_state_user_played',
      ]);
      assert.deepEqual(
        (await runner.getTable('fresh_candidate'))?.foreignKeys.map(
          ({ name }) => name
        ),
        ['FK_fresh_candidate_media']
      );
      assert.deepEqual(
        (await runner.getTable('fresh_observation'))?.foreignKeys.map(
          ({ name }) => name
        ),
        ['FK_fresh_observation_candidate']
      );
      assert.match(
        String(
          (await runner.getTable('fresh_discovery_history'))?.findColumnByName(
            'automaticReasons'
          )?.default
        ),
        /\[\]/
      );
      assert.equal(
        (await runner.getTable('fresh_sync_state'))?.findColumnByName('id')
          ?.default,
        undefined
      );
      await runner.release();

      const normalizedJellyfinIndex = (await current.query(
        `SELECT "sql" FROM "sqlite_master" WHERE "type" = 'index' AND "name" = 'UQ_user_jellyfin_id_normalized'`
      )) as { sql: string }[];
      assert.equal(normalizedJellyfinIndex.length, 1);
      assert.match(normalizedJellyfinIndex[0].sql, /WHERE "jellyfinUserId"/);
      await current.destroy();

      entityDatabase = new DataSource({
        type: 'sqlite',
        database: databasePath,
        entities: dataSource.options.entities,
        synchronize: false,
      });
      await entityDatabase.initialize();
      const schemaLog = await entityDatabase.driver.createSchemaBuilder().log();
      assert.deepEqual(
        schemaLog.upQueries.map(({ query }) => query),
        []
      );
    } finally {
      if (catalog.isInitialized) await catalog.destroy();
      if (released?.isInitialized) await released.destroy();
      if (current?.isInitialized) await current.destroy();
      if (entityDatabase?.isInitialized) await entityDatabase.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
