import {
  createRemovalScheduleTable,
  dropRemovalScheduleTable,
} from '@server/utils/removalScheduleMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemovalSchedules1790000000025 implements MigrationInterface {
  name = 'AddRemovalSchedules1790000000025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createRemovalScheduleTable(queryRunner, {
      idDefinition: 'SERIAL PRIMARY KEY NOT NULL',
      timestampType: 'timestamp without time zone',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropRemovalScheduleTable(queryRunner);
  }
}
