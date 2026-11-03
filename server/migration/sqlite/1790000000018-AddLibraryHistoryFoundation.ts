import {
  createLibraryHistoryTables,
  dropLibraryHistoryTables,
} from '@server/utils/libraryHistoryMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLibraryHistoryFoundation1790000000018 implements MigrationInterface {
  name = 'AddLibraryHistoryFoundation1790000000018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createLibraryHistoryTables(queryRunner, {
      timestampType: 'datetime',
      trueDefault: '1',
      falseDefault: '0',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropLibraryHistoryTables(queryRunner);
  }
}
