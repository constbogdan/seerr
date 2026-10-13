import {
  denormalizeWatchlistAndFresh,
  normalizeWatchlistAndFresh,
} from '@server/utils/watchlistFreshNormalizationMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class NormalizeWatchlistAndFresh1790000000023 implements MigrationInterface {
  name = 'NormalizeWatchlistAndFresh1790000000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await normalizeWatchlistAndFresh(queryRunner, {
      idDefinition: 'SERIAL PRIMARY KEY',
      timestampType: 'timestamptz',
      nowDefault: 'now()',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await denormalizeWatchlistAndFresh(queryRunner);
  }
}
