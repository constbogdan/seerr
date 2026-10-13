import {
  addHydrationRunLeaseMetadata,
  dropHydrationRunLeaseMetadata,
} from '@server/utils/hydrationRunLeaseMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHydrationRunLeases1790000000040 implements MigrationInterface {
  name = 'AddHydrationRunLeases1790000000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await addHydrationRunLeaseMetadata(queryRunner, {
      timestampType: 'datetime',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropHydrationRunLeaseMetadata(queryRunner);
  }
}
