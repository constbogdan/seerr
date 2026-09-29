import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn, TableForeignKey, TableIndex } from 'typeorm';

const MEDIA_FOREIGN_KEY = 'FK_6641da8d831b93dfcb429f8b8bc';

export class AddWatchlistEnrichment1790000000015 implements MigrationInterface {
  name = 'AddWatchlistEnrichment1790000000015';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

    const table = await queryRunner.getTable('watchlist');
    const mediaForeignKey = table?.foreignKeys.find(
      (foreignKey) =>
        foreignKey.columnNames.length === 1 &&
        foreignKey.columnNames[0] === 'mediaId'
    );
    if (!mediaForeignKey) {
      throw new Error('Watchlist media foreign key is missing.');
    }
    await queryRunner.dropForeignKey('watchlist', mediaForeignKey);
    await queryRunner.createForeignKey(
      'watchlist',
      new TableForeignKey({
        name: MEDIA_FOREIGN_KEY,
        columnNames: ['mediaId'],
        referencedTableName: 'media',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
        onUpdate: 'NO ACTION',
      })
    );
    await queryRunner.createIndex(
      'watchlist',
      new TableIndex({
        name: 'IDX_watchlist_user_played_created',
        columnNames: ['requestedById', 'jellyfinPlayed', 'createdAt'],
      })
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_jellyfin_id_normalized" ON "user" (lower(replace(btrim("jellyfinUserId"), '-', ''))) WHERE "jellyfinUserId" IS NOT NULL AND btrim("jellyfinUserId") <> ''`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_user_jellyfin_id_normalized"`);
    await queryRunner.dropIndex(
      'watchlist',
      'IDX_watchlist_user_played_created'
    );
    const table = await queryRunner.getTable('watchlist');
    const mediaForeignKey = table?.foreignKeys.find(
      (foreignKey) =>
        foreignKey.columnNames.length === 1 &&
        foreignKey.columnNames[0] === 'mediaId'
    );
    if (!mediaForeignKey) {
      throw new Error('Watchlist media foreign key is missing.');
    }
    await queryRunner.dropForeignKey('watchlist', mediaForeignKey);
    await queryRunner.createForeignKey(
      'watchlist',
      new TableForeignKey({
        name: MEDIA_FOREIGN_KEY,
        columnNames: ['mediaId'],
        referencedTableName: 'media',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      })
    );
    await queryRunner.dropColumns('watchlist', [
      'jellyfinPlayStateSyncedAt',
      'jellyfinPlayStateUserId',
      'jellyfinLastPlayedAt',
      'jellyfinPlayed',
    ]);
  }
}
