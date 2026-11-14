import { Table, type QueryRunner } from 'typeorm';

export const addMovieCollectionObservation = async (
  runner: QueryRunner,
  timestampType: 'datetime' | 'timestamptz'
): Promise<void> => {
  await runner.createTable(
    new Table({
      name: 'movie_collection_observation',
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
        { name: 'tmdbCollectionId', type: 'integer', isNullable: true },
        { name: 'observedAt', type: timestampType },
      ],
      uniques: [
        {
          name: 'UQ_movie_collection_observation_identity',
          columnNames: ['mediaType', 'tmdbId'],
        },
      ],
      checks: [
        {
          name: 'CHK_movie_collection_observation_type',
          expression: `"mediaType" = 'movie'`,
        },
        {
          name: 'CHK_movie_collection_observation_tmdb_id',
          expression: '"tmdbId" > 0',
        },
        {
          name: 'CHK_movie_collection_observation_collection_id',
          expression: '"tmdbCollectionId" IS NULL OR "tmdbCollectionId" > 0',
        },
      ],
      indices: [
        {
          name: 'IDX_movie_collection_observation_observed_at',
          columnNames: ['observedAt'],
        },
      ],
    })
  );
};

export const dropMovieCollectionObservation = async (
  runner: QueryRunner
): Promise<void> => {
  await runner.dropTable('movie_collection_observation');
};
