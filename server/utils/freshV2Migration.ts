import type { QueryRunner } from 'typeorm';
import { Table } from 'typeorm';

/** Additive only: never reads, transforms, or deletes legacy Fresh records. */
export const addFreshV2 = async (
  runner: QueryRunner,
  time: 'datetime' | 'timestamptz'
) => {
  const integer = (name: string, defaultValue?: number) => ({
    name,
    type: 'integer',
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  });
  const text = (name: string, length: string, nullable = false) => ({
    name,
    type: 'varchar',
    length,
    isNullable: nullable,
  });
  const date = (name: string, nullable = false) => ({
    name,
    type: time,
    isNullable: nullable,
  });
  const id = {
    name: 'id',
    type: 'integer',
    isPrimary: true,
    isGenerated: true,
    generationStrategy: 'increment' as const,
  };
  await runner.createTable(
    new Table({
      name: 'fresh_source_state',
      columns: [
        { name: 'id', type: 'integer', isPrimary: true },
        text('sourceKey', '64'),
        text('checkpoint', '20', true),
        text('scanHead', '20', true),
        text('scanCursor', '20', true),
        text('approvalCursor', '20', true),
        {
          name: 'backfillComplete',
          type: 'boolean',
          default: time === 'datetime' ? 0 : false,
        },
        {
          name: 'recovering',
          type: 'boolean',
          default: time === 'datetime' ? 0 : false,
        },
        integer('attempts', 0),
        date('nextAttemptAt', true),
        date('lastIngestedAt', true),
        text('lastError', '32', true),
        { name: 'filterYears', type: 'text', default: "'[]'" },
      ],
    })
  );
  await runner.createTable(
    new Table({
      name: 'fresh_work',
      columns: [
        id,
        text('sourceKey', '64'),
        text('groupKey', '64'),
        text('mediaType', '8'),
        text('title', '300'),
        text('sourceTitle', '300'),
        integer('year', 0),
        integer('season', -1),
        { ...integer('externalTmdbId'), isNullable: true },
        { ...integer('externalTvdbId'), isNullable: true },
        text('externalImdbId', '16', true),
        date('firstObservedAt'),
        { ...text('outcome', '16'), default: "'pending'" },
        integer('attempts', 0),
        date('nextAttemptAt', true),
        text('lastError', '32', true),
        { ...integer('tmdbId'), isNullable: true },
        text('canonicalTitle', '300', true),
      ],
      uniques: [
        {
          name: 'UQ_fresh_work_source_group',
          columnNames: ['sourceKey', 'groupKey'],
        },
      ],
      indices: [
        {
          name: 'IDX_fresh_work_due',
          columnNames: ['sourceKey', 'outcome', 'nextAttemptAt', 'id'],
        },
      ],
    })
  );
  await runner.createTable(
    new Table({
      name: 'fresh_discovery',
      columns: [
        id,
        text('sourceKey', '64'),
        text('mediaType', '8'),
        integer('tmdbId'),
        text('eventKey', '32'),
        date('discoveredAt'),
        date('visibleUntil'),
        text('title', '300'),
      ],
      uniques: [
        {
          name: 'UQ_fresh_discovery_event',
          columnNames: ['sourceKey', 'mediaType', 'tmdbId', 'eventKey'],
        },
      ],
      indices: [
        {
          name: 'IDX_fresh_discovery_feed',
          columnNames: ['sourceKey', 'discoveredAt', 'mediaType', 'tmdbId'],
        },
      ],
    })
  );
};

export const dropFreshV2 = async (runner: QueryRunner) => {
  for (const table of ['fresh_discovery', 'fresh_work', 'fresh_source_state'])
    await runner.dropTable(table);
};
