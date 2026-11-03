import type { MigrationInterface, QueryRunner } from 'typeorm';

export class UpgradeFreshMembership1790000000002 implements MigrationInterface {
  name = 'UpgradeFreshMembership1790000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (
      !(await queryRunner.hasColumn('fresh_sync_state', 'mediaEligibilityDays'))
    ) {
      await queryRunner.query(
        `ALTER TABLE "fresh_sync_state" ADD COLUMN "mediaEligibilityDays" integer NOT NULL DEFAULT (90)`
      );
      if (
        await queryRunner.hasColumn('fresh_sync_state', 'projectionWindowDays')
      ) {
        await queryRunner.query(
          `UPDATE "fresh_sync_state" SET "mediaEligibilityDays" = "projectionWindowDays"`
        );
      }
    }
    if (
      !(await queryRunner.hasColumn('fresh_sync_state', 'freshVisibilityDays'))
    ) {
      await queryRunner.query(
        `ALTER TABLE "fresh_sync_state" ADD COLUMN "freshVisibilityDays" integer NOT NULL DEFAULT (7)`
      );
    }
    const upgradingMedia = !(await queryRunner.hasColumn(
      'fresh_media',
      'admitted'
    ));
    if (upgradingMedia) {
      await queryRunner.query(
        `ALTER TABLE "fresh_media" ADD COLUMN "admitted" boolean NOT NULL DEFAULT (0)`
      );
    }
    if (!(await queryRunner.hasColumn('fresh_media', 'membershipReason'))) {
      await queryRunner.query(
        `ALTER TABLE "fresh_media" ADD COLUMN "membershipReason" varchar(64)`
      );
    }
    if (!(await queryRunner.hasColumn('fresh_media', 'contentRating'))) {
      await queryRunner.query(
        `ALTER TABLE "fresh_media" ADD COLUMN "contentRating" varchar(32) NOT NULL DEFAULT ('')`
      );
    }
    if (!(await queryRunner.hasColumn('fresh_media', 'contentRatingRegion'))) {
      await queryRunner.query(
        `ALTER TABLE "fresh_media" ADD COLUMN "contentRatingRegion" varchar(8) NOT NULL DEFAULT ('')`
      );
    }
    if (upgradingMedia) {
      await queryRunner.query(
        `UPDATE "fresh_media" SET "admitted" = 1 WHERE "id" IN (SELECT "freshMediaId" FROM "fresh_candidate" WHERE "status" = 3)`
      );
      await queryRunner.query(
        `UPDATE "fresh_media" SET "membershipReason" = CASE WHEN "active" = 1 THEN 'active_fresh' ELSE 'visibility_expired' END WHERE "admitted" = 1`
      );
      await queryRunner.query(
        `UPDATE "fresh_media" SET "membershipReason" = 'outside_eligibility_window' WHERE "admitted" = 0`
      );
      await queryRunner.query(
        `UPDATE "fresh_candidate" SET "status" = 3, "lastFailureReason" = NULL, "nextAttemptAt" = NULL WHERE "status" = 7 AND "freshMediaId" IS NOT NULL`
      );
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_fresh_media_membership_reason" ON "fresh_media" ("membershipReason")`
    );
  }

  public async down(): Promise<void> {
    // Fresh is unreleased; forward migration is authoritative.
  }
}
