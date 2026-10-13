import { TableColumn, type QueryRunner } from 'typeorm';

const removedFreshPresentationColumns = [
  'originalTitle',
  'posterPath',
  'backdropPath',
  'overview',
  'popularity',
  'adult',
  'video',
  'originCountries',
] as const;

export const normalizeWatchlistAndFresh = async (
  queryRunner: QueryRunner,
  options: {
    idDefinition: string;
    timestampType: string;
    nowDefault: string;
  }
): Promise<void> => {
  if (!(await queryRunner.hasTable('user_media_intent_occurrence'))) {
    await queryRunner.query(
      `CREATE TABLE "user_media_intent_occurrence" (` +
        `"id" ${options.idDefinition}, ` +
        `"userId" integer NOT NULL, ` +
        `"intentType" varchar(16) NOT NULL DEFAULT 'WATCHLIST', ` +
        `"mediaType" varchar(8) NOT NULL, ` +
        `"tmdbId" integer NOT NULL, ` +
        `"state" varchar(16) NOT NULL DEFAULT 'ACTIVE', ` +
        `"startedAt" ${options.timestampType} NOT NULL, ` +
        `"endedAt" ${options.timestampType}, ` +
        `"endReason" varchar(32), ` +
        `"completionEvidenceId" integer, ` +
        `"createdAt" ${options.timestampType} NOT NULL DEFAULT ${options.nowDefault}, ` +
        `"updatedAt" ${options.timestampType} NOT NULL DEFAULT ${options.nowDefault}, ` +
        `CONSTRAINT "CHK_user_media_intent_type" CHECK ("intentType" IN ('WATCHLIST')), ` +
        `CONSTRAINT "CHK_user_media_intent_state" CHECK ("state" IN ('ACTIVE', 'SATISFIED', 'REMOVED')), ` +
        `CONSTRAINT "FK_user_media_intent_user" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE, ` +
        `CONSTRAINT "FK_user_media_intent_completion_evidence" FOREIGN KEY ("completionEvidenceId") REFERENCES "viewing_evidence"("id") ON DELETE SET NULL)`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_media_intent_active" ON "user_media_intent_occurrence" ("userId", "intentType", "mediaType", "tmdbId") WHERE "state" = 'ACTIVE'`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_media_intent_user_started" ON "user_media_intent_occurrence" ("userId", "startedAt")`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_media_intent_identity_state" ON "user_media_intent_occurrence" ("mediaType", "tmdbId", "state")`
    );
    if (await queryRunner.hasTable('watchlist')) {
      await queryRunner.query(
        `INSERT INTO "user_media_intent_occurrence" (` +
          `"userId", "intentType", "mediaType", "tmdbId", "state", "startedAt", "createdAt", "updatedAt") ` +
          `SELECT "requestedById", 'WATCHLIST', "mediaType", "tmdbId", 'ACTIVE', "createdAt", "createdAt", "updatedAt" FROM "watchlist"`
      );
    }
  }

  const table = await queryRunner.getTable('fresh_media');
  const columns = removedFreshPresentationColumns.flatMap((name) => {
    const column = table?.findColumnByName(name);
    return column ? [column] : [];
  });
  if (columns.length > 0) await queryRunner.dropColumns('fresh_media', columns);
};

export const denormalizeWatchlistAndFresh = async (
  queryRunner: QueryRunner
): Promise<void> => {
  if (await queryRunner.hasTable('user_media_intent_occurrence')) {
    await queryRunner.dropTable('user_media_intent_occurrence', true);
  }
  if (!(await queryRunner.hasTable('fresh_media'))) return;
  const definitions = [
    new TableColumn({
      name: 'originalTitle',
      type: 'varchar',
      length: '300',
      default: "''",
    }),
    new TableColumn({
      name: 'posterPath',
      type: 'varchar',
      length: '500',
      isNullable: true,
    }),
    new TableColumn({
      name: 'backdropPath',
      type: 'varchar',
      length: '500',
      isNullable: true,
    }),
    new TableColumn({ name: 'overview', type: 'text', default: "''" }),
    new TableColumn({ name: 'popularity', type: 'float', default: 0 }),
    new TableColumn({ name: 'adult', type: 'boolean', isNullable: true }),
    new TableColumn({ name: 'video', type: 'boolean', isNullable: true }),
    new TableColumn({ name: 'originCountries', type: 'text', default: "'[]'" }),
  ];
  for (const column of definitions) {
    if (!(await queryRunner.hasColumn('fresh_media', column.name))) {
      await queryRunner.addColumn('fresh_media', column);
    }
  }
};
