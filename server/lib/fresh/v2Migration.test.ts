import FreshDiscovery from '@server/entity/FreshDiscovery';
import FreshSourceState from '@server/entity/FreshSourceState';
import FreshWork from '@server/entity/FreshWork';
import { AddFreshV21790000000048 } from '@server/migration/sqlite/1790000000048-AddFreshV2';
import { addFreshV2 } from '@server/utils/freshV2Migration';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource, type QueryRunner, type Table } from 'typeorm';

describe('Fresh V2 additive persistence', () => {
  it('creates empty V2 tables, preserves legacy rows, and matches registered entity metadata', async () => {
    const database = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [FreshSourceState, FreshWork, FreshDiscovery],
    });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(
        'CREATE TABLE fresh_media (id integer PRIMARY KEY, title text)'
      );
      await runner.query(
        "INSERT INTO fresh_media VALUES (1, 'Preserved legacy identity')"
      );
      await new AddFreshV21790000000048().up(runner);
      for (const entity of [FreshSourceState, FreshWork, FreshDiscovery])
        assert.equal(await database.getRepository(entity).count(), 0);
      assert.deepEqual(await runner.query('SELECT * FROM fresh_media'), [
        { id: 1, title: 'Preserved legacy identity' },
      ]);
      const schema = await database.driver.createSchemaBuilder().log();
      assert.deepEqual(schema.upQueries, []);
      const base = {
        sourceKey: 'source',
        mediaType: 'movie' as const,
        tmdbId: 1,
        eventKey: 'movie',
        discoveredAt: new Date('2026-10-01Z'),
        visibleUntil: new Date('2026-10-08Z'),
        title: 'Movie',
      };
      await database
        .getRepository(FreshDiscovery)
        .save(new FreshDiscovery(base));
      await assert.rejects(
        database.getRepository(FreshDiscovery).save(new FreshDiscovery(base))
      );
      await database
        .getRepository(FreshDiscovery)
        .save(
          new FreshDiscovery({ ...base, mediaType: 'tv', eventKey: 'series' })
        );
      assert.equal(await database.getRepository(FreshDiscovery).count(), 2);
      await new AddFreshV21790000000048().down(runner);
      assert.deepEqual(await runner.query('SELECT * FROM fresh_media'), [
        { id: 1, title: 'Preserved legacy identity' },
      ]);
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('uses PostgreSQL timezone-aware dates, booleans and nonnullable portable identity keys', async () => {
    const tables: Table[] = [];
    await addFreshV2(
      {
        createTable: async (table: Table) => {
          tables.push(table);
        },
      } as unknown as QueryRunner,
      'timestamptz'
    );
    assert.equal(tables.length, 3);
    for (const table of tables) {
      assert.ok(
        table.columns
          .filter((column) => /At$|Until$/.test(column.name))
          .every((column) => column.type === 'timestamptz')
      );
      for (const unique of table.uniques)
        assert.ok(
          unique.columnNames.every(
            (name) =>
              table.columns.find((column) => column.name === name)
                ?.isNullable === false
          )
        );
    }
    assert.equal(
      tables[0].columns.find((column) => column.name === 'backfillComplete')
        ?.type,
      'boolean'
    );
    assert.equal(tables[2].uniques[0].name, 'UQ_fresh_discovery_event');
  });
  it('generates PostgreSQL DDL with typed event uniqueness without connecting to a server', async () => {
    const database = new DataSource({
      type: 'postgres',
      host: 'unused.test',
      database: 'fixture',
    });
    const runner = database.createQueryRunner();
    runner.enableSqlMemory();
    await addFreshV2(runner, 'timestamptz');
    const sql = runner
      .getMemorySql()
      .upQueries.map((query) => query.query)
      .join('\n');
    assert.match(sql, /timestamp with time zone|timestamptz/);
    assert.match(sql, /UQ_fresh_discovery_event/);
    assert.match(
      sql,
      /UNIQUE \("sourceKey", "mediaType", "tmdbId", "eventKey"\)/
    );
    assert.doesNotMatch(sql, /DROP TABLE|fresh_media|fresh_observation/);
  });
});
