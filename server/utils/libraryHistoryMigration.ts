import type { QueryRunner, TableColumnOptions } from 'typeorm';
import {
  Table,
  TableCheck,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from 'typeorm';

interface LibraryHistoryMigrationOptions {
  timestampType: 'datetime' | 'timestamptz';
  trueDefault: string;
  falseDefault: string;
}

const primaryKey = (): TableColumnOptions => ({
  name: 'id',
  type: 'integer',
  isPrimary: true,
  isGenerated: true,
  generationStrategy: 'increment',
});

const timestamp = (
  name: string,
  type: LibraryHistoryMigrationOptions['timestampType'],
  nullable = false,
  withDefault = false
): TableColumnOptions => ({
  name,
  type,
  isNullable: nullable,
  ...(withDefault ? { default: 'CURRENT_TIMESTAMP' } : {}),
});

const index = (name: string, columnNames: string[]) =>
  new TableIndex({ name, columnNames });
const unique = (name: string, columnNames: string[]) =>
  new TableUnique({ name, columnNames });
const foreignKey = (
  name: string,
  columnNames: string[],
  referencedTableName: string,
  referencedColumnNames: string[],
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT'
) =>
  new TableForeignKey({
    name,
    columnNames,
    referencedTableName,
    referencedColumnNames,
    onDelete,
  });

export const libraryHistoryTableNames = [
  'canonical_media',
  'canonical_media_identity',
  'canonical_season',
  'canonical_season_identity',
  'canonical_episode',
  'canonical_episode_identity',
  'viewer',
  'storage_root',
  'library_presence',
  'library_file',
  'library_file_episode',
  'hydration_run',
  'source_checkpoint',
  'library_source_observation',
  'viewing_evidence',
] as const;

export const createLibraryHistoryTables = async (
  queryRunner: QueryRunner,
  options: LibraryHistoryMigrationOptions
): Promise<void> => {
  const { timestampType, trueDefault, falseDefault } = options;

  await queryRunner.createTable(
    new Table({
      name: 'canonical_media',
      columns: [
        primaryKey(),
        { name: 'mediaType', type: 'varchar', length: '8' },
        {
          name: 'titleSnapshot',
          type: 'varchar',
          length: '300',
          isNullable: true,
        },
        { name: 'year', type: 'integer', isNullable: true },
        { name: 'currentMediaId', type: 'integer', isNullable: true },
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      checks: [
        new TableCheck({
          name: 'CHK_canonical_media_type',
          expression: `"mediaType" IN ('movie', 'series')`,
        }),
      ],
      uniques: [
        unique('UQ_canonical_media_id_type', ['id', 'mediaType']),
        unique('UQ_canonical_media_current_media', ['currentMediaId']),
      ],
      indices: [
        index('IDX_canonical_media_type_title', ['mediaType', 'titleSnapshot']),
      ],
      foreignKeys: [
        foreignKey(
          'FK_canonical_media_current_media',
          ['currentMediaId'],
          'media',
          ['id'],
          'SET NULL'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'canonical_media_identity',
      columns: [
        primaryKey(),
        { name: 'canonicalMediaId', type: 'integer' },
        { name: 'mediaType', type: 'varchar', length: '8' },
        { name: 'provider', type: 'varchar', length: '32' },
        {
          name: 'sourceScope',
          type: 'varchar',
          length: '128',
          default: "''",
        },
        { name: 'value', type: 'varchar', length: '255' },
        timestamp('createdAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_canonical_media_identity_source', [
          'provider',
          'sourceScope',
          'mediaType',
          'value',
        ]),
      ],
      indices: [
        index('IDX_canonical_media_identity_media', ['canonicalMediaId']),
      ],
      foreignKeys: [
        foreignKey(
          'FK_canonical_media_identity_media',
          ['canonicalMediaId', 'mediaType'],
          'canonical_media',
          ['id', 'mediaType'],
          'CASCADE'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'canonical_season',
      columns: [
        primaryKey(),
        { name: 'seriesId', type: 'integer' },
        {
          name: 'mediaType',
          type: 'varchar',
          length: '8',
          default: "'series'",
        },
        { name: 'seasonNumber', type: 'integer' },
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      checks: [
        new TableCheck({
          name: 'CHK_canonical_season_series_type',
          expression: `"mediaType" = 'series'`,
        }),
      ],
      uniques: [
        unique('UQ_canonical_season_identity', ['seriesId', 'seasonNumber']),
        unique('UQ_canonical_season_id_series', ['id', 'seriesId']),
      ],
      indices: [index('IDX_canonical_season_series', ['seriesId'])],
      foreignKeys: [
        foreignKey(
          'FK_canonical_season_series',
          ['seriesId', 'mediaType'],
          'canonical_media',
          ['id', 'mediaType'],
          'RESTRICT'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'canonical_season_identity',
      columns: [
        primaryKey(),
        { name: 'canonicalSeasonId', type: 'integer' },
        { name: 'provider', type: 'varchar', length: '32' },
        {
          name: 'sourceScope',
          type: 'varchar',
          length: '128',
          default: "''",
        },
        { name: 'value', type: 'varchar', length: '255' },
        timestamp('createdAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_canonical_season_identity_source', [
          'provider',
          'sourceScope',
          'value',
        ]),
      ],
      indices: [
        index('IDX_canonical_season_identity_season', ['canonicalSeasonId']),
      ],
      foreignKeys: [
        foreignKey(
          'FK_canonical_season_identity_season',
          ['canonicalSeasonId'],
          'canonical_season',
          ['id'],
          'CASCADE'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'canonical_episode',
      columns: [
        primaryKey(),
        { name: 'seasonId', type: 'integer' },
        { name: 'episodeNumber', type: 'integer' },
        { name: 'airDate', type: 'date', isNullable: true },
        {
          name: 'isSpecial',
          type: 'boolean',
          default: falseDefault,
        },
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_canonical_episode_identity', ['seasonId', 'episodeNumber']),
      ],
      indices: [index('IDX_canonical_episode_air_date', ['airDate'])],
      foreignKeys: [
        foreignKey(
          'FK_canonical_episode_season',
          ['seasonId'],
          'canonical_season',
          ['id'],
          'RESTRICT'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'canonical_episode_identity',
      columns: [
        primaryKey(),
        { name: 'canonicalEpisodeId', type: 'integer' },
        { name: 'provider', type: 'varchar', length: '32' },
        {
          name: 'sourceScope',
          type: 'varchar',
          length: '128',
          default: "''",
        },
        { name: 'value', type: 'varchar', length: '255' },
        timestamp('createdAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_canonical_episode_identity_source', [
          'provider',
          'sourceScope',
          'value',
        ]),
      ],
      indices: [
        index('IDX_canonical_episode_identity_episode', ['canonicalEpisodeId']),
      ],
      foreignKeys: [
        foreignKey(
          'FK_canonical_episode_identity_episode',
          ['canonicalEpisodeId'],
          'canonical_episode',
          ['id'],
          'CASCADE'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'viewer',
      columns: [
        primaryKey(),
        { name: 'source', type: 'varchar', length: '32' },
        { name: 'sourceScope', type: 'varchar', length: '128' },
        { name: 'sourceUserId', type: 'varchar', length: '128' },
        { name: 'userId', type: 'integer', isNullable: true },
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_viewer_source_identity', [
          'source',
          'sourceScope',
          'sourceUserId',
        ]),
      ],
      indices: [index('IDX_viewer_user', ['userId'])],
      foreignKeys: [
        foreignKey('FK_viewer_user', ['userId'], 'user', ['id'], 'SET NULL'),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'storage_root',
      columns: [
        primaryKey(),
        { name: 'servarrType', type: 'varchar', length: '16' },
        { name: 'serviceId', type: 'integer' },
        { name: 'sourceRootId', type: 'integer' },
        {
          name: 'nameSnapshot',
          type: 'varchar',
          length: '255',
          isNullable: true,
        },
        { name: 'pathSnapshot', type: 'text', isNullable: true },
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_storage_root_source', [
          'servarrType',
          'serviceId',
          'sourceRootId',
        ]),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'library_presence',
      columns: [
        primaryKey(),
        { name: 'canonicalMediaId', type: 'integer' },
        { name: 'sourceSystem', type: 'varchar', length: '32' },
        { name: 'sourceScope', type: 'varchar', length: '128' },
        { name: 'sourceItemId', type: 'varchar', length: '128' },
        {
          name: 'sourceGeneration',
          type: 'varchar',
          length: '64',
          default: "''",
        },
        { name: 'storageRootId', type: 'integer', isNullable: true },
        { name: 'pathSnapshot', type: 'text', isNullable: true },
        { name: 'logicalSizeBytes', type: 'bigint', isNullable: true },
        timestamp('addedAt', timestampType, true),
        {
          name: 'addedAtSource',
          type: 'varchar',
          length: '32',
          isNullable: true,
        },
        {
          name: 'addedAtConfidence',
          type: 'varchar',
          length: '16',
          isNullable: true,
        },
        timestamp('firstObservedAt', timestampType, false, true),
        timestamp('lastSeenAt', timestampType, true),
        timestamp('removedAt', timestampType, true),
        { name: 'servarrManaged', type: 'boolean', isNullable: true },
        { name: 'servarrHasFile', type: 'boolean', isNullable: true },
        { name: 'jellyfinVisible', type: 'boolean', isNullable: true },
        { name: 'isCurrent', type: 'boolean', default: trueDefault },
        { name: 'reconciliationState', type: 'integer', default: '0' },
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_library_presence_source_generation', [
          'sourceSystem',
          'sourceScope',
          'sourceItemId',
          'sourceGeneration',
        ]),
      ],
      indices: [
        index('IDX_library_presence_current', [
          'canonicalMediaId',
          'isCurrent',
        ]),
        index('IDX_library_presence_root_current', [
          'storageRootId',
          'isCurrent',
        ]),
      ],
      foreignKeys: [
        foreignKey(
          'FK_library_presence_media',
          ['canonicalMediaId'],
          'canonical_media',
          ['id'],
          'RESTRICT'
        ),
        foreignKey(
          'FK_library_presence_root',
          ['storageRootId'],
          'storage_root',
          ['id'],
          'RESTRICT'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'library_file',
      columns: [
        primaryKey(),
        { name: 'libraryPresenceId', type: 'integer' },
        { name: 'sourceSystem', type: 'varchar', length: '32' },
        { name: 'sourceScope', type: 'varchar', length: '128' },
        { name: 'sourceFileId', type: 'varchar', length: '128' },
        {
          name: 'sourceGeneration',
          type: 'varchar',
          length: '64',
          default: "''",
        },
        { name: 'storageRootId', type: 'integer', isNullable: true },
        { name: 'pathSnapshot', type: 'text', isNullable: true },
        { name: 'sizeBytes', type: 'bigint', isNullable: true },
        timestamp('importedAt', timestampType, true),
        {
          name: 'importedAtSource',
          type: 'varchar',
          length: '32',
          isNullable: true,
        },
        {
          name: 'importedAtConfidence',
          type: 'varchar',
          length: '16',
          isNullable: true,
        },
        timestamp('firstObservedAt', timestampType, false, true),
        timestamp('lastSeenAt', timestampType, true),
        timestamp('removedAt', timestampType, true),
        { name: 'isCurrent', type: 'boolean', default: trueDefault },
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_library_file_source', [
          'sourceSystem',
          'sourceScope',
          'sourceFileId',
          'sourceGeneration',
        ]),
      ],
      indices: [
        index('IDX_library_file_presence_current', [
          'libraryPresenceId',
          'isCurrent',
        ]),
      ],
      foreignKeys: [
        foreignKey(
          'FK_library_file_presence',
          ['libraryPresenceId'],
          'library_presence',
          ['id'],
          'RESTRICT'
        ),
        foreignKey(
          'FK_library_file_root',
          ['storageRootId'],
          'storage_root',
          ['id'],
          'RESTRICT'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'library_file_episode',
      columns: [
        { name: 'libraryFileId', type: 'integer', isPrimary: true },
        { name: 'canonicalEpisodeId', type: 'integer', isPrimary: true },
        timestamp('createdAt', timestampType, false, true),
      ],
      indices: [
        index('IDX_library_file_episode_episode', ['canonicalEpisodeId']),
      ],
      foreignKeys: [
        foreignKey(
          'FK_library_file_episode_file',
          ['libraryFileId'],
          'library_file',
          ['id'],
          'RESTRICT'
        ),
        foreignKey(
          'FK_library_file_episode_episode',
          ['canonicalEpisodeId'],
          'canonical_episode',
          ['id'],
          'RESTRICT'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'hydration_run',
      columns: [
        primaryKey(),
        { name: 'source', type: 'varchar', length: '32' },
        { name: 'sourceScope', type: 'varchar', length: '128' },
        {
          name: 'sourceGeneration',
          type: 'varchar',
          length: '64',
          isNullable: true,
        },
        { name: 'stage', type: 'varchar', length: '64' },
        { name: 'status', type: 'integer', default: '0' },
        timestamp('startedAt', timestampType, false, true),
        timestamp('completedAt', timestampType, true),
        timestamp('coverageStartedAt', timestampType, true),
        timestamp('coverageEndedAt', timestampType, true),
        { name: 'rowsInspected', type: 'integer', default: '0' },
        { name: 'rowsCreated', type: 'integer', default: '0' },
        { name: 'rowsUpdated', type: 'integer', default: '0' },
        { name: 'unresolvedCount', type: 'integer', default: '0' },
        {
          name: 'failureCode',
          type: 'varchar',
          length: '64',
          isNullable: true,
        },
        {
          name: 'failureMessage',
          type: 'varchar',
          length: '500',
          isNullable: true,
        },
      ],
      indices: [
        index('IDX_hydration_run_source_started', [
          'source',
          'sourceScope',
          'startedAt',
        ]),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'source_checkpoint',
      columns: [
        primaryKey(),
        { name: 'source', type: 'varchar', length: '32' },
        { name: 'sourceScope', type: 'varchar', length: '128' },
        { name: 'stage', type: 'varchar', length: '64' },
        {
          name: 'sourceGeneration',
          type: 'varchar',
          length: '64',
          isNullable: true,
        },
        { name: 'cursor', type: 'text', isNullable: true },
        { name: 'status', type: 'integer', default: '0' },
        timestamp('lastAttemptAt', timestampType, true),
        timestamp('lastSuccessfulAt', timestampType, true),
        { name: 'lastRunId', type: 'integer', isNullable: true },
        timestamp('updatedAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_source_checkpoint_identity', [
          'source',
          'sourceScope',
          'stage',
        ]),
      ],
      indices: [
        index('IDX_source_checkpoint_status', ['status', 'lastSuccessfulAt']),
      ],
      foreignKeys: [
        foreignKey(
          'FK_source_checkpoint_run',
          ['lastRunId'],
          'hydration_run',
          ['id'],
          'SET NULL'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'library_source_observation',
      columns: [
        primaryKey(),
        { name: 'libraryPresenceId', type: 'integer' },
        { name: 'source', type: 'varchar', length: '32' },
        { name: 'sourceScope', type: 'varchar', length: '128' },
        {
          name: 'sourceGeneration',
          type: 'varchar',
          length: '64',
          default: "''",
        },
        { name: 'sourceObservationId', type: 'varchar', length: '255' },
        { name: 'hydrationRunId', type: 'integer', isNullable: true },
        { name: 'storageRootId', type: 'integer', isNullable: true },
        { name: 'pathSnapshot', type: 'text', isNullable: true },
        { name: 'logicalSizeBytes', type: 'bigint', isNullable: true },
        { name: 'servarrManaged', type: 'boolean', isNullable: true },
        { name: 'servarrHasFile', type: 'boolean', isNullable: true },
        { name: 'jellyfinVisible', type: 'boolean', isNullable: true },
        timestamp('observedAt', timestampType),
        timestamp('createdAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_library_source_observation_identity', [
          'source',
          'sourceScope',
          'sourceGeneration',
          'sourceObservationId',
        ]),
      ],
      indices: [
        index('IDX_library_source_observation_presence', [
          'libraryPresenceId',
          'observedAt',
        ]),
      ],
      foreignKeys: [
        foreignKey(
          'FK_library_source_observation_presence',
          ['libraryPresenceId'],
          'library_presence',
          ['id'],
          'RESTRICT'
        ),
        foreignKey(
          'FK_library_source_observation_run',
          ['hydrationRunId'],
          'hydration_run',
          ['id'],
          'SET NULL'
        ),
        foreignKey(
          'FK_library_source_observation_root',
          ['storageRootId'],
          'storage_root',
          ['id'],
          'RESTRICT'
        ),
      ],
    })
  );

  await queryRunner.createTable(
    new Table({
      name: 'viewing_evidence',
      columns: [
        primaryKey(),
        { name: 'source', type: 'varchar', length: '32' },
        { name: 'sourceScope', type: 'varchar', length: '128' },
        { name: 'sourceClass', type: 'varchar', length: '32' },
        { name: 'sourceActivityId', type: 'varchar', length: '255' },
        {
          name: 'sourceGeneration',
          type: 'varchar',
          length: '64',
          isNullable: true,
        },
        {
          name: 'sourceVersion',
          type: 'varchar',
          length: '32',
          isNullable: true,
        },
        {
          name: 'sourceUserId',
          type: 'varchar',
          length: '128',
          isNullable: true,
        },
        {
          name: 'sourceItemId',
          type: 'varchar',
          length: '128',
          isNullable: true,
        },
        { name: 'viewerId', type: 'integer', isNullable: true },
        { name: 'canonicalMediaId', type: 'integer', isNullable: true },
        { name: 'canonicalEpisodeId', type: 'integer', isNullable: true },
        timestamp('observedAt', timestampType, true),
        timestamp('observedEndAt', timestampType, true),
        {
          name: 'playbackDurationSeconds',
          type: 'integer',
          isNullable: true,
        },
        { name: 'playbackPositionTicks', type: 'bigint', isNullable: true },
        { name: 'runtimeTicks', type: 'bigint', isNullable: true },
        { name: 'progressBasisPoints', type: 'integer', isNullable: true },
        { name: 'identityResolutionState', type: 'integer', default: '0' },
        { name: 'completionClassification', type: 'integer', default: '0' },
        {
          name: 'completionDerivationVersion',
          type: 'integer',
          isNullable: true,
        },
        timestamp('completionDerivedAt', timestampType, true),
        {
          name: 'provenance',
          type: 'varchar',
          length: '64',
          isNullable: true,
        },
        timestamp('createdAt', timestampType, false, true),
        timestamp('updatedAt', timestampType, false, true),
      ],
      uniques: [
        unique('UQ_viewing_evidence_source_activity', [
          'source',
          'sourceScope',
          'sourceClass',
          'sourceActivityId',
        ]),
      ],
      indices: [
        index('IDX_viewing_evidence_viewer_time', ['viewerId', 'observedAt']),
        index('IDX_viewing_evidence_media_time', [
          'canonicalMediaId',
          'observedAt',
        ]),
        index('IDX_viewing_evidence_episode_time', [
          'canonicalEpisodeId',
          'observedAt',
        ]),
        index('IDX_viewing_evidence_resolution', ['identityResolutionState']),
      ],
      foreignKeys: [
        foreignKey(
          'FK_viewing_evidence_viewer',
          ['viewerId'],
          'viewer',
          ['id'],
          'RESTRICT'
        ),
        foreignKey(
          'FK_viewing_evidence_media',
          ['canonicalMediaId'],
          'canonical_media',
          ['id'],
          'RESTRICT'
        ),
        foreignKey(
          'FK_viewing_evidence_episode',
          ['canonicalEpisodeId'],
          'canonical_episode',
          ['id'],
          'RESTRICT'
        ),
      ],
    })
  );
};

export const dropLibraryHistoryTables = async (
  queryRunner: QueryRunner
): Promise<void> => {
  for (const tableName of [...libraryHistoryTableNames].reverse()) {
    await queryRunner.dropTable(tableName, true, true, true);
  }
};
