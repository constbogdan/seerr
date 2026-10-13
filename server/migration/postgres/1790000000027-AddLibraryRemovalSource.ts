import {
  addLibraryRemovalSource,
  removeLibraryRemovalSource,
} from '@server/utils/libraryRemovalSourceMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLibraryRemovalSource1790000000027 implements MigrationInterface {
  name = 'AddLibraryRemovalSource1790000000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addLibraryRemovalSource(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await removeLibraryRemovalSource(queryRunner);
  }
}
