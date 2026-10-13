import {
  addStorageRootDisplayName,
  removeStorageRootDisplayName,
} from '@server/utils/storageRootDisplayNameMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStorageRootDisplayName1790000000029 implements MigrationInterface {
  name = 'AddStorageRootDisplayName1790000000029';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addStorageRootDisplayName(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await removeStorageRootDisplayName(queryRunner);
  }
}
