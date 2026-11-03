import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFreshEligibilitySchemaVersion1790000000007 implements MigrationInterface {
  name = 'AddFreshEligibilitySchemaVersion1790000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn(
        'fresh_sync_state',
        'eligibilitySchemaVersion'
      ))
    ) {
      await queryRunner.query(
        `ALTER TABLE "fresh_sync_state" ADD COLUMN "eligibilitySchemaVersion" integer NOT NULL DEFAULT 0`
      );
    }
  }

  public async down(): Promise<void> {
    // Fresh is unreleased; forward migration is authoritative.
  }
}
