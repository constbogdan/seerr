import type { QueryRunner } from 'typeorm';

export const createSeriesRelocationTable = async (
  queryRunner: QueryRunner,
  timestampType: string
) => {
  await queryRunner.query(`CREATE TABLE "series_relocation_execution" (
    "id" varchar(36) NOT NULL,
    "canonicalMediaId" integer NOT NULL,
    "state" varchar(32) NOT NULL,
    "activeKey" varchar(64),
    "serviceId" integer NOT NULL,
    "sonarrSeriesId" integer NOT NULL,
    "sourceRootFolderId" integer NOT NULL,
    "destinationRootFolderId" integer NOT NULL,
    "sourceVolumeId" varchar(255) NOT NULL,
    "destinationVolumeId" varchar(255) NOT NULL,
    "sourcePath" text NOT NULL,
    "destinationPath" text NOT NULL,
    "expectedEpisodeFileIds" text NOT NULL,
    "expectedFileCount" integer NOT NULL,
    "expectedBytes" bigint NOT NULL,
    "failureCode" varchar(64),
    "failureMessage" text,
    "providerStartedAt" ${timestampType},
    "providerAcceptedAt" ${timestampType},
    "verifiedAt" ${timestampType},
    "createdAt" ${timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" ${timestampType} NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PK_series_relocation_execution" PRIMARY KEY ("id"),
    CONSTRAINT "UQ_series_relocation_active" UNIQUE ("activeKey"),
    CONSTRAINT "CHK_series_relocation_state" CHECK ("state" IN ('claimed', 'provider_in_flight', 'verifying', 'completed', 'reconciliation_required')),
    CONSTRAINT "FK_series_relocation_media" FOREIGN KEY ("canonicalMediaId") REFERENCES "canonical_media"("id") ON DELETE RESTRICT
  )`);
  await queryRunner.query(
    `CREATE INDEX "IDX_series_relocation_media_created" ON "series_relocation_execution" ("canonicalMediaId", "createdAt")`
  );
  await queryRunner.query(
    `CREATE INDEX "IDX_series_relocation_state_updated" ON "series_relocation_execution" ("state", "updatedAt")`
  );
};

export const dropSeriesRelocationTable = async (queryRunner: QueryRunner) => {
  await queryRunner.query('DROP TABLE "series_relocation_execution"');
};
