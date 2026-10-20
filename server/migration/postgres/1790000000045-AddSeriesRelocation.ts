import {
  createSeriesRelocationTable,
  dropSeriesRelocationTable,
} from '@server/utils/seriesRelocationMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSeriesRelocation1790000000045 implements MigrationInterface {
  name = 'AddSeriesRelocation1790000000045';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await createSeriesRelocationTable(
      queryRunner,
      'timestamp without time zone'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropSeriesRelocationTable(queryRunner);
  }
}
