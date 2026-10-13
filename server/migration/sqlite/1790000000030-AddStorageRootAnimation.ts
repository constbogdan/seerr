import {
  addStorageRootAnimation,
  removeStorageRootAnimation,
} from '@server/utils/storageRootAnimationMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStorageRootAnimation1790000000030 implements MigrationInterface {
  name = 'AddStorageRootAnimation1790000000030';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addStorageRootAnimation(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await removeStorageRootAnimation(queryRunner);
  }
}
