import {
  addLibraryFileResolution,
  removeLibraryFileResolution,
} from '@server/utils/libraryFileResolutionMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLibraryFileResolution1790000000035 implements MigrationInterface {
  name = 'AddLibraryFileResolution1790000000035';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addLibraryFileResolution(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await removeLibraryFileResolution(queryRunner);
  }
}
