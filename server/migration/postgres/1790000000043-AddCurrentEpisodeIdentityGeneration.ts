import {
  addCurrentEpisodeIdentityGeneration,
  dropCurrentEpisodeIdentityGeneration,
} from '@server/utils/currentEpisodeIdentityGenerationMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCurrentEpisodeIdentityGeneration1790000000043 implements MigrationInterface {
  name = 'AddCurrentEpisodeIdentityGeneration1790000000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addCurrentEpisodeIdentityGeneration(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropCurrentEpisodeIdentityGeneration(queryRunner);
  }
}
