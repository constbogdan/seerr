import {
  createRemovalExecutionTables,
  dropRemovalExecutionTables,
} from '@server/utils/removalExecutionMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemovalExecutions1790000000036 implements MigrationInterface {
  name = 'AddRemovalExecutions1790000000036';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createRemovalExecutionTables(queryRunner, {
      timestampType: 'datetime',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropRemovalExecutionTables(queryRunner);
  }
}
