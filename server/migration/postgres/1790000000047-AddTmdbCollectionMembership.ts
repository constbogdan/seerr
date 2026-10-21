import {
  addTmdbCollectionMembership,
  dropTmdbCollectionMembership,
} from '@server/utils/tmdbCollectionMembershipMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTmdbCollectionMembership1790000000047 implements MigrationInterface {
  name = 'AddTmdbCollectionMembership1790000000047';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addTmdbCollectionMembership(queryRunner, {
      timestampType: 'timestamptz',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropTmdbCollectionMembership(queryRunner);
  }
}
