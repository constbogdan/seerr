import {
  createRemovalExecutionTables,
  dropRemovalExecutionTables,
} from '@server/utils/removalExecutionMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemovalExecutions1790000000037 implements MigrationInterface {
  name = 'AddRemovalExecutions1790000000037';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createRemovalExecutionTables(queryRunner, {
      timestampType: 'timestamp without time zone',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropRemovalExecutionTables(queryRunner);
  }
}
