import { TableColumn, type QueryRunner } from 'typeorm';

export const addCurrentEpisodeIdentityGeneration = async (
  queryRunner: QueryRunner
) => {
  await queryRunner.addColumn(
    'canonical_episode_identity',
    new TableColumn({
      name: 'lastSeenSourceGeneration',
      type: 'varchar',
      length: '64',
      isNullable: true,
    })
  );
  await queryRunner.query(
    `CREATE INDEX "IDX_canonical_episode_identity_current_generation" ` +
      `ON "canonical_episode_identity" ("provider", "sourceScope", "lastSeenSourceGeneration")`
  );
  // Existing aliases have no trustworthy generation. Require one complete
  // Jellyfin Library hydration before current viewing can use or prune them.
  await queryRunner.query(
    `UPDATE "source_checkpoint" SET "status" = 2 ` +
      `WHERE "source" = 'jellyfin' AND "stage" = 'current-library' AND "status" = 1`
  );
};

export const dropCurrentEpisodeIdentityGeneration = async (
  queryRunner: QueryRunner
) => {
  await queryRunner.dropIndex(
    'canonical_episode_identity',
    'IDX_canonical_episode_identity_current_generation'
  );
  await queryRunner.dropColumn(
    'canonical_episode_identity',
    'lastSeenSourceGeneration'
  );
};
