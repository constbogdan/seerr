import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFreshPersistence1790000000000 implements MigrationInterface {
  name = 'AddFreshPersistence1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "fresh_sync_state" ("id" integer PRIMARY KEY NOT NULL, "sourceFingerprint" varchar(64) NOT NULL DEFAULT (''), "filterId" integer NOT NULL DEFAULT (0), "generation" integer NOT NULL DEFAULT (0), "checkpointReleaseId" varchar(20), "continuityStatus" integer NOT NULL DEFAULT (1), "mediaEligibilityDays" integer NOT NULL DEFAULT (90), "freshVisibilityDays" integer NOT NULL DEFAULT (7), "lastSuccessfulSyncAt" datetime, "lastSuccessfulReconciliationAt" datetime, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP))`
    );
    await queryRunner.query(`INSERT INTO "fresh_sync_state" ("id") VALUES (1)`);
    await queryRunner.query(
      `CREATE TABLE "fresh_media" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaType" varchar(8) NOT NULL, "tmdbId" integer NOT NULL, "active" boolean NOT NULL DEFAULT (0), "admitted" boolean NOT NULL DEFAULT (0), "membershipReason" varchar(64), "lastMatchedGeneration" integer NOT NULL DEFAULT (0), "firstSeenAt" datetime NOT NULL, "lastSeenAt" datetime NOT NULL, "resolvedAt" datetime NOT NULL, "metadataRefreshedAt" datetime NOT NULL, "displayTitle" varchar(300) NOT NULL, "sortTitle" varchar(300) NOT NULL, "originalTitle" varchar(300) NOT NULL, "mediaDate" varchar(10), "posterPath" varchar(500), "backdropPath" varchar(500), "overview" text NOT NULL DEFAULT (''), "originalLanguage" varchar(20) NOT NULL DEFAULT (''), "popularity" float NOT NULL DEFAULT (0), "voteAverage" float NOT NULL DEFAULT (0), "voteCount" integer NOT NULL DEFAULT (0), "genreIds" text NOT NULL, "contentRating" varchar(32) NOT NULL DEFAULT (''), "contentRatingRegion" varchar(8) NOT NULL DEFAULT (''), "adult" boolean, "video" boolean, "originCountries" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_fresh_media_identity" UNIQUE ("mediaType", "tmdbId"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_media_active_first_seen" ON "fresh_media" ("active", "firstSeenAt")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_media_active_type_first_seen" ON "fresh_media" ("active", "mediaType", "firstSeenAt")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_media_active_sort_title" ON "fresh_media" ("active", "sortTitle")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_media_active_date" ON "fresh_media" ("active", "mediaDate")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_media_active_vote" ON "fresh_media" ("active", "voteAverage")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_media_membership_reason" ON "fresh_media" ("membershipReason")`
    );
    await queryRunner.query(
      `CREATE TABLE "fresh_candidate" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "sourceGeneration" integer NOT NULL, "mediaType" varchar(8) NOT NULL, "normalizedTitle" varchar(300) NOT NULL, "displayTitle" varchar(300) NOT NULL, "matchYear" integer NOT NULL DEFAULT (0), "status" integer NOT NULL DEFAULT (1), "tmdbId" integer, "freshMediaId" integer, "firstObservedAt" datetime NOT NULL, "lastObservedAt" datetime NOT NULL, "attemptCount" integer NOT NULL DEFAULT (0), "lastAttemptAt" datetime, "nextAttemptAt" datetime, "resolutionStartedAt" datetime, "resolvedAt" datetime, "lastFailureReason" varchar(64), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_fresh_candidate_identity" UNIQUE ("sourceGeneration", "mediaType", "normalizedTitle", "matchYear"), CONSTRAINT "FK_fresh_candidate_media" FOREIGN KEY ("freshMediaId") REFERENCES "fresh_media" ("id") ON DELETE SET NULL)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_candidate_due" ON "fresh_candidate" ("sourceGeneration", "status", "nextAttemptAt")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_candidate_media" ON "fresh_candidate" ("freshMediaId")`
    );
    await queryRunner.query(
      `CREATE TABLE "fresh_observation" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "sourceGeneration" integer NOT NULL, "releaseId" varchar(20) NOT NULL, "filterId" integer NOT NULL, "candidateId" integer NOT NULL, "mediaType" varchar(8) NOT NULL, "title" varchar(300) NOT NULL, "normalizedTitle" varchar(300) NOT NULL, "year" integer NOT NULL DEFAULT (0), "observedAt" datetime NOT NULL, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_fresh_observation_release" UNIQUE ("sourceGeneration", "releaseId"), CONSTRAINT "FK_fresh_observation_candidate" FOREIGN KEY ("candidateId") REFERENCES "fresh_candidate" ("id") ON DELETE CASCADE)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_observation_candidate" ON "fresh_observation" ("candidateId")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_fresh_observation_generation_time" ON "fresh_observation" ("sourceGeneration", "observedAt")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "fresh_observation"`);
    await queryRunner.query(`DROP TABLE "fresh_candidate"`);
    await queryRunner.query(`DROP TABLE "fresh_media"`);
    await queryRunner.query(`DROP TABLE "fresh_sync_state"`);
  }
}
