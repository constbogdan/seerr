import { AddMovieCollectionObservation1790000000052 as AddPostgresMovieCollectionObservation } from '@server/migration/postgres/1790000000052-AddMovieCollectionObservation';
import { AddMovieCollectionObservation1790000000052 } from '@server/migration/sqlite/1790000000052-AddMovieCollectionObservation';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource, type QueryRunner, type Table } from 'typeorm';

describe('movie collection observation migration', () => {
  it('uses PostgreSQL timestamp-with-zone metadata and the same typed identity constraint', async () => {
    let captured: Table | undefined;
    const runner = {
      createTable: async (table: Table) => {
        captured = table;
      },
    } as unknown as QueryRunner;
    await new AddPostgresMovieCollectionObservation().up(runner);
    assert.equal(captured?.findColumnByName('observedAt')?.type, 'timestamptz');
    assert.deepEqual(captured?.uniques[0].columnNames, ['mediaType', 'tmdbId']);
    assert.equal(captured?.checks.length, 3);
  });
  it('adds a typed, unique, nullable-membership table without touching canonical rows', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    const migration = new AddMovieCollectionObservation1790000000052();
    try {
      await migration.up(runner);
      await runner.query(
        'INSERT INTO movie_collection_observation ("mediaType", "tmdbId", "tmdbCollectionId", "observedAt") VALUES (?, ?, ?, ?)',
        ['movie', 42, null, '2026-11-14 00:00:00']
      );
      await assert.rejects(() =>
        runner.query(
          'INSERT INTO movie_collection_observation ("mediaType", "tmdbId", "tmdbCollectionId", "observedAt") VALUES (?, ?, ?, ?)',
          ['movie', 42, 123, '2026-11-14 00:00:00']
        )
      );
      await assert.rejects(() =>
        runner.query(
          'INSERT INTO movie_collection_observation ("mediaType", "tmdbId", "tmdbCollectionId", "observedAt") VALUES (?, ?, ?, ?)',
          ['tv', 43, null, '2026-11-14 00:00:00']
        )
      );
      await migration.down(runner);
      assert.equal(
        await runner.hasTable('movie_collection_observation'),
        false
      );
    } finally {
      await runner.release();
      await database.destroy();
    }
  });
});
