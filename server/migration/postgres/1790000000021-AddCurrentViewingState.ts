import {
  createCurrentViewingTable,
  dropCurrentViewingTable,
} from '@server/utils/currentViewingMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCurrentViewingState1790000000021 implements MigrationInterface {
  name = 'AddCurrentViewingState1790000000021';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createCurrentViewingTable(queryRunner, {
      timestampType: 'timestamptz',
      falseDefault: 'false',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropCurrentViewingTable(queryRunner);
  }
}
