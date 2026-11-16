import { Table, type QueryRunner } from 'typeorm';

export const addSimilarCollections = async (
  runner: QueryRunner,
  timestampType: 'datetime' | 'timestamptz'
): Promise<void> => {
  await runner.createTable(
    new Table({
      name: 'similar_collection_relation',
      columns: [
        { name: 'originCollectionId', type: 'integer', isPrimary: true },
        { name: 'seedMovieId', type: 'integer', isPrimary: true },
        { name: 'relatedCollectionId', type: 'integer', isPrimary: true },
        { name: 'discoveredAt', type: timestampType },
      ],
      checks: [
        {
          name: 'CHK_similar_relation_origin',
          expression: '"originCollectionId" > 0',
        },
        { name: 'CHK_similar_relation_seed', expression: '"seedMovieId" > 0' },
        {
          name: 'CHK_similar_relation_related',
          expression: '"relatedCollectionId" > 0',
        },
        {
          name: 'CHK_similar_relation_not_self',
          expression: '"originCollectionId" <> "relatedCollectionId"',
        },
      ],
      indices: [
        {
          name: 'IDX_similar_relation_origin_related',
          columnNames: ['originCollectionId', 'relatedCollectionId'],
        },
      ],
    })
  );
  await runner.createTable(
    new Table({
      name: 'similar_collection_seed_progress',
      columns: [
        { name: 'originCollectionId', type: 'integer', isPrimary: true },
        { name: 'seedMovieId', type: 'integer', isPrimary: true },
        { name: 'nextPage', type: 'integer', default: 1 },
        { name: 'reportedTotalPages', type: 'integer', isNullable: true },
        { name: 'failureCount', type: 'integer', default: 0 },
        { name: 'lastAttemptAt', type: timestampType, isNullable: true },
        { name: 'retryAfter', type: timestampType, isNullable: true },
        { name: 'completedAt', type: timestampType, isNullable: true },
        { name: 'claimToken', type: 'varchar', length: '64', isNullable: true },
        {
          name: 'lastVisitToken',
          type: 'varchar',
          length: '64',
          isNullable: true,
        },
        { name: 'claimExpiresAt', type: timestampType, isNullable: true },
      ],
      checks: [
        {
          name: 'CHK_similar_seed_origin',
          expression: '"originCollectionId" > 0',
        },
        { name: 'CHK_similar_seed_movie', expression: '"seedMovieId" >= 0' },
        {
          name: 'CHK_similar_seed_page',
          expression: '"nextPage" BETWEEN 1 AND 4',
        },
      ],
      indices: [
        {
          name: 'IDX_similar_seed_retry',
          columnNames: ['originCollectionId', 'retryAfter'],
        },
      ],
    })
  );
};

export const dropSimilarCollections = async (
  runner: QueryRunner
): Promise<void> => {
  await runner.dropTable('similar_collection_seed_progress');
  await runner.dropTable('similar_collection_relation');
};
