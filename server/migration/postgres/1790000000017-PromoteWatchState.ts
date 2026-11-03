import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  Table,
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableUnique,
} from 'typeorm';

export class PromoteWatchState1790000000017 implements MigrationInterface {
  name = 'PromoteWatchState1790000000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumn(
      'user',
      new TableColumn({
        name: 'includeInUserMetrics',
        type: 'boolean',
        default: 'true',
      })
    );
    if (await queryRunner.hasColumn('user', 'classification')) {
      await queryRunner.query(
        `UPDATE "user" SET "includeInUserMetrics" = false WHERE "classification" = 2`
      );
      await queryRunner.dropColumn('user', 'classification');
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
            type: 'timestamptz',
            isNullable: true,
          },
          {
            name: 'jellyfinPlayStateSyncedAt',
            type: 'timestamptz',
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
            type: 'timestamptz',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updatedAt',
            type: 'timestamptz',
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
        type: 'timestamptz',
        isNullable: true,
      }),
      new TableColumn({
        name: 'jellyfinPlayStateSyncedAt',
        type: 'timestamptz',
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
      UPDATE "watchlist" watchlist
      SET
        "jellyfinPlayed" = state."jellyfinPlayed",
        "jellyfinLastPlayedAt" = state."jellyfinLastPlayedAt",
        "jellyfinPlayStateSyncedAt" = state."jellyfinPlayStateSyncedAt",
        "jellyfinPlayStateUserId" = state."jellyfinPlayStateUserId"
      FROM "user_media_state" state
      WHERE state."userId" = watchlist."requestedById"
        AND state."mediaType" = watchlist."mediaType"
        AND state."tmdbId" = watchlist."tmdbId"
    `);
    await queryRunner.createIndex(
      'watchlist',
      new TableIndex({
        name: 'IDX_watchlist_user_played_created',
        columnNames: ['requestedById', 'jellyfinPlayed', 'createdAt'],
      })
    );
    await queryRunner.dropTable('user_media_state');
    await queryRunner.dropColumn('user', 'includeInUserMetrics');
  }
}
