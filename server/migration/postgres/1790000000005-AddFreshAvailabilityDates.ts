import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFreshAvailabilityDates1790000000005 implements MigrationInterface {
  name = 'AddFreshAvailabilityDates1790000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn('fresh_observation', 'availabilityType'))
    ) {
      await queryRunner.query(
        `ALTER TABLE "fresh_observation" ADD COLUMN "availabilityType" varchar(16) NOT NULL DEFAULT 'unknown'`
      );
    }
    if (!(await queryRunner.hasColumn('fresh_media', 'digitalReleaseDate'))) {
      await queryRunner.query(
        `ALTER TABLE "fresh_media" ADD COLUMN "digitalReleaseDate" varchar(10)`
      );
    }
    if (!(await queryRunner.hasColumn('fresh_media', 'physicalReleaseDate'))) {
      await queryRunner.query(
        `ALTER TABLE "fresh_media" ADD COLUMN "physicalReleaseDate" varchar(10)`
      );
    }
  }

  public async down(): Promise<void> {
    // Fresh is unreleased; forward migration is authoritative.
  }
}
