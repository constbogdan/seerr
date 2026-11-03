import {
  addStorageRootColor,
  removeStorageRootColor,
} from '@server/utils/storageRootColorMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStorageRootColor1790000000033 implements MigrationInterface {
  name = 'AddStorageRootColor1790000000033';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addStorageRootColor(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await removeStorageRootColor(queryRunner);
  }
}
