import type { QueryRunner } from 'typeorm';

export interface RemovalExecutionMigrationOptions {
  timestampType: string;
}

export const createRemovalExecutionTables = async (
  queryRunner: QueryRunner,
  options: RemovalExecutionMigrationOptions
) => {
  await queryRunner.query(`CREATE TABLE "removal_execution" (
    "id" varchar(36) NOT NULL,
    "canonicalMediaId" integer NOT NULL,
    "targetType" varchar(8) NOT NULL,
    "seasonNumber" integer,
    "initiator" varchar(16) NOT NULL,
    "state" varchar(32) NOT NULL,
    "fence" integer NOT NULL,
    "sourceSystem" varchar(16),
    "sourceScope" varchar(128),
    "sourceItemId" varchar(128),
    "sourceGeneration" varchar(64),
    "libraryPresenceId" integer,
    "scheduleId" integer,
    "scheduleRevision" integer,
    "providerOutcome" varchar(16),
    "providerStartedAt" ${options.timestampType},
    "providerAcknowledgedAt" ${options.timestampType},
    "providerAbsentAt" ${options.timestampType},
    "physicalAbsenceConfirmedAt" ${options.timestampType},
    "reconciledAt" ${options.timestampType},
    "failureCode" varchar(64),
    "failureMessage" text,
    "createdAt" ${options.timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" ${options.timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PK_removal_execution" PRIMARY KEY ("id"),
    CONSTRAINT "CHK_removal_execution_target" CHECK ("targetType" IN ('movie', 'series', 'season')),
    CONSTRAINT "CHK_removal_execution_season" CHECK (("targetType" = 'season' AND "seasonNumber" IS NOT NULL) OR ("targetType" <> 'season' AND "seasonNumber" IS NULL)),
    CONSTRAINT "CHK_removal_execution_initiator" CHECK ("initiator" IN ('manual', 'bulk', 'scheduled')),
    CONSTRAINT "CHK_removal_execution_state" CHECK ("state" IN ('claimed', 'provider_in_flight', 'provider_acknowledged', 'provider_absent', 'reconciliation_required', 'uncertain', 'completed', 'failed_pre_provider', 'failed_provider', 'cancelled_pre_provider', 'abandoned_pre_provider')),
    CONSTRAINT "CHK_removal_execution_provider_outcome" CHECK ("providerOutcome" IS NULL OR "providerOutcome" IN ('acknowledged', 'absent')),
    CONSTRAINT "FK_removal_execution_media" FOREIGN KEY ("canonicalMediaId") REFERENCES "canonical_media"("id") ON DELETE RESTRICT,
    CONSTRAINT "FK_removal_execution_presence" FOREIGN KEY ("libraryPresenceId") REFERENCES "library_presence"("id") ON DELETE RESTRICT
  )`);
  await queryRunner.query(
    `CREATE INDEX "IDX_removal_execution_media_created" ON "removal_execution" ("canonicalMediaId", "createdAt")`
  );
  await queryRunner.query(
    `CREATE INDEX "IDX_removal_execution_state_updated" ON "removal_execution" ("state", "updatedAt")`
  );
  await queryRunner.query(
    `CREATE INDEX "IDX_removal_execution_schedule" ON "removal_execution" ("scheduleId")`
  );

  await queryRunner.query(`CREATE TABLE "removal_execution_claim" (
    "canonicalMediaId" integer NOT NULL,
    "executionId" varchar(36),
    "fence" integer NOT NULL DEFAULT 0,
    "ownerToken" varchar(64),
    "phase" varchar(24),
    "leaseUntil" ${options.timestampType},
    "createdAt" ${options.timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" ${options.timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PK_removal_execution_claim" PRIMARY KEY ("canonicalMediaId"),
    CONSTRAINT "UQ_removal_execution_claim_execution" UNIQUE ("executionId"),
    CONSTRAINT "CHK_removal_execution_claim_phase" CHECK ("phase" IS NULL OR "phase" IN ('pre_provider', 'provider', 'reconciliation', 'uncertain')),
    CONSTRAINT "FK_removal_execution_claim_media" FOREIGN KEY ("canonicalMediaId") REFERENCES "canonical_media"("id") ON DELETE RESTRICT,
    CONSTRAINT "FK_removal_execution_claim_execution" FOREIGN KEY ("executionId") REFERENCES "removal_execution"("id") ON DELETE RESTRICT
  )`);
  await queryRunner.query(
    `CREATE INDEX "IDX_removal_execution_claim_lease" ON "removal_execution_claim" ("leaseUntil")`
  );
};

export const dropRemovalExecutionTables = async (queryRunner: QueryRunner) => {
  await queryRunner.query('DROP TABLE "removal_execution_claim"');
  await queryRunner.query('DROP TABLE "removal_execution"');
};
