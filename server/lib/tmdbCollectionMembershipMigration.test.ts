import { AddTmdbCollectionMembership1790000000047 } from '@server/migration/postgres/1790000000047-AddTmdbCollectionMembership';
import { AddLibraryHistoryFoundation1790000000018 } from '@server/migration/sqlite/1790000000018-AddLibraryHistoryFoundation';
import { AddTmdbCollectionMembership1790000000046 } from '@server/migration/sqlite/1790000000046-AddTmdbCollectionMembership';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource, type QueryRunner, type TableColumn } from 'typeorm';

describe('TMDB collection membership migration', () => {
  it('adds and rolls back the SQLite projection without changing canonical media', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(`CREATE TABLE "media" ("id" integer PRIMARY KEY)`);
      await runner.query(`CREATE TABLE "user" ("id" integer PRIMARY KEY)`);
      await new AddLibraryHistoryFoundation1790000000018().up(runner);
      await runner.query(
        `INSERT INTO "canonical_media" ("id", "mediaType", "titleSnapshot") ` +
          `VALUES (1, 'movie', 'Preserved Movie'), (2, 'series', 'Preserved Series')`
      );

      const migration = new AddTmdbCollectionMembership1790000000046();
      await migration.up(runner);
      assert.equal(
        await runner.hasColumn('canonical_media', 'tmdbCollectionId'),
        true
      );
      assert.equal(
        await runner.hasColumn(
          'canonical_media',
          'collectionMembershipHydratedAt'
        ),
        true
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "id", "mediaType", "titleSnapshot", "tmdbCollectionId", ` +
            `"collectionMembershipHydratedAt" FROM "canonical_media" ORDER BY "id"`
        ),
        [
          {
            id: 1,
            mediaType: 'movie',
            titleSnapshot: 'Preserved Movie',
            tmdbCollectionId: null,
            collectionMembershipHydratedAt: null,
          },
          {
            id: 2,
            mediaType: 'series',
            titleSnapshot: 'Preserved Series',
            tmdbCollectionId: null,
            collectionMembershipHydratedAt: null,
          },
        ]
      );
      const table = await runner.getTable('canonical_media');
      assert.equal(
        table?.indices.some(
          ({ name, columnNames }) =>
            name === 'IDX_canonical_media_type_tmdb_collection' &&
            columnNames.join(',') === 'mediaType,tmdbCollectionId'
        ),
        true
      );
      assert.deepEqual(await runner.query('PRAGMA foreign_key_check'), []);

      await migration.down(runner);
      assert.equal(
        await runner.hasColumn('canonical_media', 'tmdbCollectionId'),
        false
      );
      assert.equal(
        await runner.hasColumn(
          'canonical_media',
          'collectionMembershipHydratedAt'
        ),
        false
      );
      assert.deepEqual(
        await runner.query(
          `SELECT "id", "mediaType", "titleSnapshot" FROM "canonical_media" ORDER BY "id"`
        ),
        [
          { id: 1, mediaType: 'movie', titleSnapshot: 'Preserved Movie' },
          { id: 2, mediaType: 'series', titleSnapshot: 'Preserved Series' },
        ]
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('keeps PostgreSQL column and index definitions schema-equivalent', async () => {
    const added: TableColumn[] = [];
    const dropped: string[] = [];
    const droppedIndexes: string[] = [];
    const statements: string[] = [];
    const runner = {
      addColumns: async (_table: string, columns: TableColumn[]) => {
        added.push(...columns);
      },
      dropColumns: async (_table: string, columns: string[]) => {
        dropped.push(...columns);
      },
      dropIndex: async (_table: string, index: string) => {
        droppedIndexes.push(index);
      },
      query: async (statement: string) => {
        statements.push(statement);
      },
    } as unknown as QueryRunner;
    const migration = new AddTmdbCollectionMembership1790000000047();

    await migration.up(runner);
    assert.deepEqual(
      added.map(({ name, type, isNullable }) => ({ name, type, isNullable })),
      [
        { name: 'tmdbCollectionId', type: 'integer', isNullable: true },
        {
          name: 'collectionMembershipHydratedAt',
          type: 'timestamptz',
          isNullable: true,
        },
      ]
    );
    assert.deepEqual(statements, [
      'CREATE INDEX "IDX_canonical_media_type_tmdb_collection" ON "canonical_media" ("mediaType", "tmdbCollectionId")',
    ]);

    statements.length = 0;
    await migration.down(runner);
    assert.deepEqual(droppedIndexes, [
      'IDX_canonical_media_type_tmdb_collection',
    ]);
    assert.deepEqual(statements, []);
    assert.deepEqual(dropped, [
      'collectionMembershipHydratedAt',
      'tmdbCollectionId',
    ]);
  });
});
