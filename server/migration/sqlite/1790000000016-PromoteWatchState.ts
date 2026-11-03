import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  Table,
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from 'typeorm';

export class PromoteWatchState1790000000016 implements MigrationInterface {
  name = 'PromoteWatchState1790000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // SQLite's TypeORM addColumn emulation rebuilds the user table. Dropping
    // that temporary table can cascade-delete Watchlist rows before their
    // play state is copied, so use SQLite's native additive ALTER instead.
    await queryRunner.query(
      `ALTER TABLE "user" ADD COLUMN "includeInUserMetrics" boolean NOT NULL DEFAULT 1`
    );
    if (await queryRunner.hasColumn('user', 'classification')) {
      // The abandoned, unreleased classification prototype had one explicit
      // exclusion value (Service = 2). Preserve only that deliberate choice.
      await queryRunner.query(
        `UPDATE "user" SET "includeInUserMetrics" = 0 WHERE "classification" = 2`
      );
      await queryRunner.query(
        `ALTER TABLE "user" DROP COLUMN "classification"`
      );
    }
    await queryRunner.createTable(
      new Table({
        name: 'user_media_state',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'userId', type: 'integer' },
          { name: 'mediaType', type: 'varchar' },
          { name: 'tmdbId', type: 'integer' },
          { name: 'mediaId', type: 'integer', isNullable: true },
          { name: 'jellyfinPlayed', type: 'boolean', isNullable: true },
          {
            name: 'jellyfinLastPlayedAt',
            type: 'datetime',
            isNullable: true,
          },
          {
            name: 'jellyfinPlayStateSyncedAt',
            type: 'datetime',
            isNullable: true,
          },
          {
            name: 'jellyfinPlayStateUserId',
            type: 'varchar',
            length: '32',
            isNullable: true,
          },
          {
            name: 'createdAt',
            type: 'datetime',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'datetime',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
        foreignKeys: [
          new TableForeignKey({
            name: 'FK_user_media_state_user',
            columnNames: ['userId'],
            referencedTableName: 'user',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          }),
          new TableForeignKey({
            name: 'FK_user_media_state_media',
            columnNames: ['mediaId'],
            referencedTableName: 'media',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          }),
        ],
        uniques: [
          new TableUnique({
            name: 'UQ_user_media_state_identity',
            columnNames: ['userId', 'mediaType', 'tmdbId'],
          }),
        ],
        indices: [
          new TableIndex({
            name: 'IDX_user_media_state_userId',
            columnNames: ['userId'],
          }),
          new TableIndex({
            name: 'IDX_user_media_state_tmdbId',
            columnNames: ['tmdbId'],
          }),
          new TableIndex({
            name: 'IDX_user_media_state_mediaId',
            columnNames: ['mediaId'],
          }),
          new TableIndex({
            name: 'IDX_user_media_state_user_played',
            columnNames: ['userId', 'jellyfinPlayed'],
          }),
        ],
      })
    );
    await queryRunner.query(`
      INSERT INTO "user_media_state" (
        "userId", "mediaType", "tmdbId", "mediaId", "jellyfinPlayed",
        "jellyfinLastPlayedAt", "jellyfinPlayStateSyncedAt",
        "jellyfinPlayStateUserId", "createdAt", "updatedAt"
      )
      SELECT
        "requestedById", "mediaType", "tmdbId", "mediaId",
        "jellyfinPlayed", "jellyfinLastPlayedAt",
        "jellyfinPlayStateSyncedAt", "jellyfinPlayStateUserId",
        "createdAt", "updatedAt"
      FROM "watchlist"
    `);
    await queryRunner.dropIndex(
      'watchlist',
      'IDX_watchlist_user_played_created'
    );
    await queryRunner.dropColumns('watchlist', [
      'jellyfinPlayStateSyncedAt',
      'jellyfinPlayStateUserId',
      'jellyfinLastPlayedAt',
      'jellyfinPlayed',
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('watchlist', [
      new TableColumn({
        name: 'jellyfinPlayed',
        type: 'boolean',
        isNullable: true,
      }),
      new TableColumn({
        name: 'jellyfinLastPlayedAt',
        type: 'datetime',
        isNullable: true,
      }),
      new TableColumn({
        name: 'jellyfinPlayStateSyncedAt',
        type: 'datetime',
        isNullable: true,
      }),
      new TableColumn({
        name: 'jellyfinPlayStateUserId',
        type: 'varchar',
        length: '32',
        isNullable: true,
      }),
    ]);
    await queryRunner.query(`
      UPDATE "watchlist"
      SET
        "jellyfinPlayed" = (
          SELECT "jellyfinPlayed" FROM "user_media_state" state
          WHERE state."userId" = "watchlist"."requestedById"
            AND state."mediaType" = "watchlist"."mediaType"
            AND state."tmdbId" = "watchlist"."tmdbId"
        ),
        "jellyfinLastPlayedAt" = (
          SELECT "jellyfinLastPlayedAt" FROM "user_media_state" state
          WHERE state."userId" = "watchlist"."requestedById"
            AND state."mediaType" = "watchlist"."mediaType"
            AND state."tmdbId" = "watchlist"."tmdbId"
        ),
        "jellyfinPlayStateSyncedAt" = (
          SELECT "jellyfinPlayStateSyncedAt" FROM "user_media_state" state
          WHERE state."userId" = "watchlist"."requestedById"
            AND state."mediaType" = "watchlist"."mediaType"
            AND state."tmdbId" = "watchlist"."tmdbId"
        ),
        "jellyfinPlayStateUserId" = (
          SELECT "jellyfinPlayStateUserId" FROM "user_media_state" state
          WHERE state."userId" = "watchlist"."requestedById"
            AND state."mediaType" = "watchlist"."mediaType"
            AND state."tmdbId" = "watchlist"."tmdbId"
        )
    `);
    await queryRunner.createIndex(
      'watchlist',
      new TableIndex({
        name: 'IDX_watchlist_user_played_created',
        columnNames: ['requestedById', 'jellyfinPlayed', 'createdAt'],
      })
    );
    await queryRunner.dropTable('user_media_state');
    await queryRunner.query(
      `ALTER TABLE "user" DROP COLUMN "includeInUserMetrics"`
    );
  }
}
