import { TableColumn, type QueryRunner } from 'typeorm';

export interface TmdbCollectionMembershipMigrationOptions {
  timestampType: string;
}

export const addTmdbCollectionMembership = async (
  queryRunner: QueryRunner,
  options: TmdbCollectionMembershipMigrationOptions
) => {
  await queryRunner.addColumns('canonical_media', [
    new TableColumn({
      name: 'tmdbCollectionId',
      type: 'integer',
      isNullable: true,
    }),
    new TableColumn({
      name: 'collectionMembershipHydratedAt',
      type: options.timestampType,
      isNullable: true,
    }),
  ]);
  await queryRunner.query(
    `CREATE INDEX "IDX_canonical_media_type_tmdb_collection" ` +
      `ON "canonical_media" ("mediaType", "tmdbCollectionId")`
  );
};

export const dropTmdbCollectionMembership = async (
  queryRunner: QueryRunner
) => {
  await queryRunner.dropIndex(
    'canonical_media',
    'IDX_canonical_media_type_tmdb_collection'
  );
  await queryRunner.dropColumns('canonical_media', [
    'collectionMembershipHydratedAt',
    'tmdbCollectionId',
  ]);
};
