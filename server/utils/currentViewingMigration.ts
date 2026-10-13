import type { QueryRunner, TableColumnOptions } from 'typeorm';
import { Table, TableForeignKey, TableIndex, TableUnique } from 'typeorm';

interface CurrentViewingMigrationOptions {
  timestampType: 'datetime' | 'timestamptz';
  falseDefault: string;
}

const timestamp = (
  name: string,
  type: CurrentViewingMigrationOptions['timestampType'],
  nullable = false,
  withDefault = false
): TableColumnOptions => ({
  name,
  type,
  isNullable: nullable,
  ...(withDefault ? { default: 'CURRENT_TIMESTAMP' } : {}),
});

export const createCurrentViewingTable = async (
  queryRunner: QueryRunner,
  { timestampType, falseDefault }: CurrentViewingMigrationOptions
): Promise<void> => {
  await queryRunner.createTable(
    new Table({
      name: 'current_viewing_state',
      columns: [
        {
          name: 'id',
          type: 'integer',
          isPrimary: true,
          isGenerated: true,
          generationStrategy: 'increment',
        },
        { name: 'viewerId', type: 'integer' },
        { name: 'sourceScope', type: 'varchar', length: '128' },
        { name: 'sourceItemId', type: 'varchar', length: '128' },
        { name: 'mediaType', type: 'varchar', length: '8' },
        { name: 'canonicalMediaId', type: 'integer' },
        { name: 'canonicalEpisodeId', type: 'integer', isNullable: true },
        { name: 'played', type: 'boolean', default: falseDefault },
        { name: 'playCount', type: 'integer', default: '0' },
        timestamp('lastPlayedAt', timestampType, true),
        { name: 'playbackPositionTicks', type: 'bigint', isNullable: true },
        { name: 'runtimeTicks', type: 'bigint', isNullable: true },
        { name: 'progressBasisPoints', type: 'integer', isNullable: true },
        timestamp('observedAt', timestampType),
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      uniques: [
        new TableUnique({
          name: 'UQ_current_viewing_state_source_item',
          columnNames: ['viewerId', 'sourceScope', 'sourceItemId'],
        }),
      ],
      indices: [
        new TableIndex({
          name: 'IDX_current_viewing_state_viewer',
          columnNames: ['viewerId', 'observedAt'],
        }),
        new TableIndex({
          name: 'IDX_current_viewing_state_media',
          columnNames: ['canonicalMediaId', 'played'],
        }),
        new TableIndex({
          name: 'IDX_current_viewing_state_episode',
          columnNames: ['canonicalEpisodeId', 'played'],
        }),
      ],
      foreignKeys: [
        new TableForeignKey({
          name: 'FK_current_viewing_state_viewer',
          columnNames: ['viewerId'],
          referencedTableName: 'viewer',
          referencedColumnNames: ['id'],
          onDelete: 'RESTRICT',
        }),
        new TableForeignKey({
          name: 'FK_current_viewing_state_media',
          columnNames: ['canonicalMediaId'],
          referencedTableName: 'canonical_media',
          referencedColumnNames: ['id'],
          onDelete: 'RESTRICT',
        }),
        new TableForeignKey({
          name: 'FK_current_viewing_state_episode',
          columnNames: ['canonicalEpisodeId'],
          referencedTableName: 'canonical_episode',
          referencedColumnNames: ['id'],
          onDelete: 'RESTRICT',
        }),
      ],
    })
  );
};

export const dropCurrentViewingTable = async (
  queryRunner: QueryRunner
): Promise<void> => {
  await queryRunner.dropTable('current_viewing_state', true, true, true);
};
