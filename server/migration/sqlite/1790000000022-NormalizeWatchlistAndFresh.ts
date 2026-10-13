import {
  denormalizeWatchlistAndFresh,
  normalizeWatchlistAndFresh,
} from '@server/utils/watchlistFreshNormalizationMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class NormalizeWatchlistAndFresh1790000000022 implements MigrationInterface {
  name = 'NormalizeWatchlistAndFresh1790000000022';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await normalizeWatchlistAndFresh(queryRunner, {
      idDefinition: 'integer PRIMARY KEY AUTOINCREMENT NOT NULL',
      timestampType: 'datetime',
      nowDefault: 'CURRENT_TIMESTAMP',
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await denormalizeWatchlistAndFresh(queryRunner);
  }
}
