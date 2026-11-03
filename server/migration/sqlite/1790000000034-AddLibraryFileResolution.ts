import {
  addLibraryFileResolution,
  removeLibraryFileResolution,
} from '@server/utils/libraryFileResolutionMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLibraryFileResolution1790000000034 implements MigrationInterface {
  name = 'AddLibraryFileResolution1790000000034';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addLibraryFileResolution(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await removeLibraryFileResolution(queryRunner);
  }
}
