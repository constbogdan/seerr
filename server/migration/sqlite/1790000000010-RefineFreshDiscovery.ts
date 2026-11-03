import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table, TableColumn, TableIndex, TableUnique } from 'typeorm';

const addColumn = async (
  queryRunner: QueryRunner,
  table: string,
  column: TableColumn
) => {
  if (!(await queryRunner.hasColumn(table, column.name))) {
    await queryRunner.addColumn(table, column);
  }
};

export class RefineFreshDiscovery1790000000010 implements MigrationInterface {
  name = 'RefineFreshDiscovery1790000000010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addColumn(
      queryRunner,
      'fresh_observation',
      new TableColumn({
        name: 'sourceTitle',
        type: 'varchar',
        length: '300',
        default: "''",
      })
    );
    await addColumn(
      queryRunner,
      'fresh_observation',
      new TableColumn({ name: 'seasonNumber', type: 'integer', default: -1 })
    );
    await addColumn(
      queryRunner,
      'fresh_observation',
      new TableColumn({ name: 'episodeNumber', type: 'integer', default: -1 })
    );
    await addColumn(
      queryRunner,
      'fresh_observation',
      new TableColumn({ name: 'explicitSeason', type: 'boolean', default: 0 })
    );
    await addColumn(
      queryRunner,
      'fresh_observation',
      new TableColumn({ name: 'explicitSpecial', type: 'boolean', default: 0 })
    );
    await addColumn(
      queryRunner,
      'fresh_observation',
      new TableColumn({
        name: 'comparisonVersion',
        type: 'integer',
        default: 1,
      })
    );
    await addColumn(
      queryRunner,
      'fresh_observation',
      new TableColumn({
        name: 'sourceEvidenceKey',
        type: 'varchar',
        length: '64',
        default: "''",
      })
    );

    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({ name: 'seasonKey', type: 'integer', default: -1 })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({
        name: 'specialEpisodeKey',
        type: 'integer',
        default: -1,
      })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({ name: 'explicitSeason', type: 'boolean', default: 0 })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({ name: 'explicitSpecial', type: 'boolean', default: 0 })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({
        name: 'comparisonVersion',
        type: 'integer',
        default: 1,
      })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({
        name: 'sourceEvidenceKey',
        type: 'varchar',
        length: '64',
        default: "''",
      })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({ name: 'revision', type: 'integer', default: 1 })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({
        name: 'effectiveMediaType',
        type: 'varchar',
        length: '8',
        isNullable: true,
      })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({
        name: 'automaticTmdbId',
        type: 'integer',
        isNullable: true,
      })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({
        name: 'automaticFreshMediaId',
        type: 'integer',
        isNullable: true,
      })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({
        name: 'automaticStatus',
        type: 'integer',
        isNullable: true,
      })
    );
    await addColumn(
      queryRunner,
      'fresh_candidate',
      new TableColumn({
        name: 'automaticFailureReason',
        type: 'varchar',
        length: '64',
        isNullable: true,
      })
    );
    await addColumn(
      queryRunner,
      'fresh_media',
      new TableColumn({
        name: 'automaticReasons',
        type: 'text',
        default: "'[]'",
      })
    );
    await queryRunner.query(
      `UPDATE "fresh_candidate" SET "automaticTmdbId" = "tmdbId", "automaticFreshMediaId" = "freshMediaId", "automaticStatus" = "status", "automaticFailureReason" = "lastFailureReason", "effectiveMediaType" = "mediaType" WHERE "automaticStatus" IS NULL`
    );

    const candidateTable = await queryRunner.getTable('fresh_candidate');
    const oldIdentity = candidateTable?.uniques.find(
      (unique) => unique.name === 'UQ_fresh_candidate_identity'
    );
    if (oldIdentity)
      await queryRunner.dropUniqueConstraint('fresh_candidate', oldIdentity);
    if (
      !candidateTable?.uniques.some(
        (unique) => unique.name === 'UQ_fresh_candidate_identity_v2'
      )
    ) {
      await queryRunner.createUniqueConstraint(
        'fresh_candidate',
        new TableUnique({
          name: 'UQ_fresh_candidate_identity_v2',
          columnNames: [
            'sourceGeneration',
            'mediaType',
            'normalizedTitle',
            'matchYear',
            'seasonKey',
            'specialEpisodeKey',
          ],
        })
      );
    }

    await queryRunner.createTable(
      new Table({
        name: 'fresh_discovery_history',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'mediaType', type: 'varchar', length: '8' },
          { name: 'tmdbId', type: 'integer' },
          { name: 'identityKind', type: 'varchar', length: '16' },
          { name: 'seasonKey', type: 'integer', default: -1 },
          { name: 'specialEpisodeKey', type: 'integer', default: -1 },
          { name: 'admitted', type: 'boolean', default: 0 },
          { name: 'legacyProjection', type: 'boolean', default: 0 },
          { name: 'firstObservedAt', type: 'datetime' },
          { name: 'lastObservedAt', type: 'datetime' },
          { name: 'firstFreshAt', type: 'datetime', isNullable: true },
          { name: 'visibleUntil', type: 'datetime', isNullable: true },
          {
            name: 'activityDate',
            type: 'varchar',
            length: '10',
            isNullable: true,
          },
          {
            name: 'activitySource',
            type: 'varchar',
            length: '32',
            default: "'unavailable'",
          },
          {
            name: 'admissionReason',
            type: 'varchar',
            length: '64',
            default: "'not_evaluated'",
          },
          { name: 'automaticReasons', type: 'text', default: "'[]'" },
          { name: 'firstSeenGeneration', type: 'integer', default: 0 },
          { name: 'lastSeenGeneration', type: 'integer', default: 0 },
          { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
          { name: 'updatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
        ],
        uniques: [
          {
            name: 'UQ_fresh_discovery_history_identity',
            columnNames: [
              'mediaType',
              'tmdbId',
              'identityKind',
              'seasonKey',
              'specialEpisodeKey',
            ],
          },
        ],
      }),
      true
    );
    await queryRunner.createIndex(
      'fresh_discovery_history',
      new TableIndex({
        name: 'IDX_fresh_discovery_history_projection',
        columnNames: ['mediaType', 'tmdbId', 'visibleUntil'],
      })
    );

    await queryRunner.createTable(
      new Table({
        name: 'fresh_manual_resolution',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'sourceEvidenceVersion', type: 'integer', default: 1 },
          { name: 'sourceEvidenceKey', type: 'varchar', length: '64' },
          { name: 'mediaType', type: 'varchar', length: '8' },
          { name: 'tmdbId', type: 'integer' },
          { name: 'canonicalTitle', type: 'varchar', length: '300' },
          {
            name: 'canonicalDate',
            type: 'varchar',
            length: '10',
            isNullable: true,
          },
          { name: 'active', type: 'boolean', default: 1 },
          { name: 'revision', type: 'integer', default: 1 },
          { name: 'actorUserId', type: 'integer', isNullable: true },
          { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
          { name: 'updatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
        ],
        uniques: [
          {
            name: 'UQ_fresh_manual_resolution_source',
            columnNames: ['sourceEvidenceVersion', 'sourceEvidenceKey'],
          },
        ],
      }),
      true
    );
    await queryRunner.createIndex(
      'fresh_manual_resolution',
      new TableIndex({
        name: 'IDX_fresh_manual_resolution_identity',
        columnNames: ['mediaType', 'tmdbId'],
      })
    );

    await queryRunner.createTable(
      new Table({
        name: 'fresh_admission_override',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'mediaType', type: 'varchar', length: '8' },
          { name: 'tmdbId', type: 'integer' },
          { name: 'identityKind', type: 'varchar', length: '16' },
          { name: 'seasonKey', type: 'integer', default: -1 },
          { name: 'specialEpisodeKey', type: 'integer', default: -1 },
          { name: 'active', type: 'boolean', default: 1 },
          { name: 'revision', type: 'integer', default: 1 },
          { name: 'actorUserId', type: 'integer', isNullable: true },
          { name: 'firstAdmittedAt', type: 'datetime', isNullable: true },
          { name: 'createdAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
          { name: 'updatedAt', type: 'datetime', default: 'CURRENT_TIMESTAMP' },
        ],
        uniques: [
          {
            name: 'UQ_fresh_admission_override_identity',
            columnNames: [
              'mediaType',
              'tmdbId',
              'identityKind',
              'seasonKey',
              'specialEpisodeKey',
            ],
          },
        ],
      }),
      true
    );
    await queryRunner.createIndex(
      'fresh_admission_override',
      new TableIndex({
        name: 'IDX_fresh_admission_override_active',
        columnNames: ['active'],
      })
    );

    await queryRunner.query(`
      INSERT OR IGNORE INTO "fresh_discovery_history"
        ("mediaType", "tmdbId", "identityKind", "seasonKey", "specialEpisodeKey",
         "admitted", "legacyProjection", "firstObservedAt", "lastObservedAt",
         "firstFreshAt", "visibleUntil", "activityDate", "activitySource",
         "admissionReason", "automaticReasons", "firstSeenGeneration", "lastSeenGeneration")
      SELECT "mediaType", "tmdbId",
        CASE WHEN "mediaType" = 'movie' THEN 'movie' ELSE 'legacy_tv' END,
        -1, -1, 1, CASE WHEN "mediaType" = 'tv' THEN 1 ELSE 0 END,
        "firstSeenAt", "lastSeenAt", "firstSeenAt",
        datetime("firstSeenAt", '+' || COALESCE((SELECT "freshVisibilityDays" FROM "fresh_sync_state" WHERE "id" = 1), 7) || ' days'),
        "mediaDate", CASE WHEN "mediaType" = 'movie' THEN 'legacy_movie' ELSE 'legacy_tv' END,
        CASE WHEN "mediaType" = 'movie' THEN 'legacy_movie_admission' ELSE 'legacy_tv_projection' END,
        '[]', "lastMatchedGeneration", "lastMatchedGeneration"
      FROM "fresh_media" WHERE "admitted" = 1
    `);
  }

  public async down(): Promise<void> {
    // Fresh downstream history is intentionally irreversible.
  }
}
