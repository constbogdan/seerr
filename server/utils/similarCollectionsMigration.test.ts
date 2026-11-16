import { AddSimilarCollections1790000000053 as PostgresMigration } from '@server/migration/postgres/1790000000053-AddSimilarCollections';
import { AddSimilarCollections1790000000053 as SqliteMigration } from '@server/migration/sqlite/1790000000053-AddSimilarCollections';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource, type QueryRunner, type Table } from 'typeorm';

describe('Similar Collections paired migrations', () => {
  it('creates and drops both SQLite tables with enforced identity and origin checks', async () => {
    const db = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [],
    });
    await db.initialize();
    try {
      const runner = db.createQueryRunner();
      const migration = new SqliteMigration();
      await migration.up(runner);
      const tables = await Promise.all([
        runner.getTable('similar_collection_relation'),
        runner.getTable('similar_collection_seed_progress'),
      ]);
      assert.ok(tables.every(Boolean));
      assert.deepEqual(
        tables[0]?.primaryColumns.map((column) => column.name),
        ['originCollectionId', 'seedMovieId', 'relatedCollectionId']
      );
      assert.deepEqual(
        tables[1]?.primaryColumns.map((column) => column.name),
        ['originCollectionId', 'seedMovieId']
      );
      await runner.query(
        'INSERT INTO similar_collection_relation (originCollectionId, seedMovieId, relatedCollectionId, discoveredAt) VALUES (100, 1, 200, ?) ',
        [new Date().toISOString()]
      );
      await assert.rejects(() =>
        runner.query(
          'INSERT INTO similar_collection_relation (originCollectionId, seedMovieId, relatedCollectionId, discoveredAt) VALUES (100, 1, 200, ?) ',
          [new Date().toISOString()]
        )
      );
      await assert.rejects(() =>
        runner.query(
          'INSERT INTO similar_collection_relation (originCollectionId, seedMovieId, relatedCollectionId, discoveredAt) VALUES (100, 1, 100, ?) ',
          [new Date().toISOString()]
        )
      );
      await migration.down(runner);
      assert.equal(await runner.hasTable('similar_collection_relation'), false);
      assert.equal(
        await runner.hasTable('similar_collection_seed_progress'),
        false
      );
      await runner.release();
    } finally {
      await db.destroy();
    }
  });

  it('keeps PostgreSQL and SQLite table shape and indexes aligned except timestamp type', async () => {
    const capture = async (migration: SqliteMigration | PostgresMigration) => {
      const tables: Table[] = [];
      const runner = {
        createTable: async (table: Table) => {
          tables.push(table);
        },
        dropTable: async () => undefined,
      } as unknown as QueryRunner;
      await migration.up(runner);
      return tables.map((table) => ({
        name: table.name,
        columns: table.columns.map((column) => ({
          name: column.name,
          type:
            column.type === 'datetime' || column.type === 'timestamptz'
              ? 'timestamp'
              : column.type,
          primary: column.isPrimary,
          nullable: column.isNullable,
        })),
        checks: table.checks.map((check) => check.expression),
        indices: table.indices.map((index) => index.columnNames),
      }));
    };
    assert.deepEqual(
      await capture(new SqliteMigration()),
      await capture(new PostgresMigration())
    );
  });
});
