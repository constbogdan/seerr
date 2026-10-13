import {
  createLibraryHistoryTables,
  dropLibraryHistoryTables,
} from '@server/utils/libraryHistoryMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLibraryHistoryFoundation1790000000019 implements MigrationInterface {
  name = 'AddLibraryHistoryFoundation1790000000019';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createLibraryHistoryTables(queryRunner, {
      timestampType: 'timestamptz',
      trueDefault: 'true',
      falseDefault: 'false',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropLibraryHistoryTables(queryRunner);
  }
}
