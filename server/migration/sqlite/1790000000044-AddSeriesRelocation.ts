import {
  createSeriesRelocationTable,
  dropSeriesRelocationTable,
} from '@server/utils/seriesRelocationMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSeriesRelocation1790000000044 implements MigrationInterface {
  name = 'AddSeriesRelocation1790000000044';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createSeriesRelocationTable(queryRunner, 'datetime');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropSeriesRelocationTable(queryRunner);
  }
}
