import {
  createRemovalScheduleTable,
  dropRemovalScheduleTable,
} from '@server/utils/removalScheduleMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemovalSchedules1790000000024 implements MigrationInterface {
  name = 'AddRemovalSchedules1790000000024';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createRemovalScheduleTable(queryRunner, {
      idDefinition: 'integer PRIMARY KEY AUTOINCREMENT NOT NULL',
      timestampType: 'datetime',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropRemovalScheduleTable(queryRunner);
  }
}
