import type { QueryRunner } from 'typeorm';

export interface RemovalMigrationOptions {
  idDefinition: string;
  timestampType: string;
}

export const createRemovalScheduleTable = async (
  queryRunner: QueryRunner,
  options: RemovalMigrationOptions
) => {
  await queryRunner.query(`CREATE TABLE "removal_schedule" (
    "id" ${options.idDefinition},
    "canonicalMediaId" integer NOT NULL,
    "targetType" varchar(8) NOT NULL,
    "seasonNumber" integer,
    "sourceSystem" varchar(16) NOT NULL,
    "sourceScope" varchar(128) NOT NULL,
    "origin" varchar(16) NOT NULL,
    "status" varchar(16) NOT NULL,
    "activeKey" varchar(320),
    "scheduledAt" ${options.timestampType} NOT NULL,
    "removeAt" ${options.timestampType} NOT NULL,
    "activityBaselineAt" ${options.timestampType},
    "revision" integer NOT NULL DEFAULT 1,
    "failureCode" varchar(64),
    "failureMessage" text,
    "lastAttemptAt" ${options.timestampType},
    "completedAt" ${options.timestampType},
    "leaseToken" varchar(64),
    "leaseUntil" ${options.timestampType},
    "createdAt" ${options.timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" ${options.timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CHK_removal_schedule_target" CHECK ("targetType" IN ('movie', 'series', 'season')),
    CONSTRAINT "CHK_removal_schedule_origin" CHECK ("origin" IN ('manual', 'automatic')),
    CONSTRAINT "CHK_removal_schedule_status" CHECK ("status" IN ('active', 'deferred', 'completed', 'cancelled', 'failed')),
    CONSTRAINT "CHK_removal_schedule_season" CHECK (("targetType" = 'season' AND "seasonNumber" IS NOT NULL) OR ("targetType" <> 'season' AND "seasonNumber" IS NULL)),
    CONSTRAINT "UQ_removal_schedule_active_key" UNIQUE ("activeKey"),
    CONSTRAINT "FK_removal_schedule_media" FOREIGN KEY ("canonicalMediaId") REFERENCES "canonical_media"("id") ON DELETE RESTRICT
  )`);
  await queryRunner.query(
    `CREATE INDEX "IDX_removal_schedule_due" ON "removal_schedule" ("status", "removeAt")`
  );
  await queryRunner.query(
    `CREATE INDEX "IDX_removal_schedule_media" ON "removal_schedule" ("canonicalMediaId", "status")`
  );
};

export const dropRemovalScheduleTable = async (queryRunner: QueryRunner) => {
  await queryRunner.query('DROP TABLE "removal_schedule"');
};
