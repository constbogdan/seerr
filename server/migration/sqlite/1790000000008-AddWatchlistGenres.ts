import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWatchlistGenres1790000000008 implements MigrationInterface {
  name = 'AddWatchlistGenres1790000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('watchlist', 'genreIds'))) {
      await queryRunner.query(
        `ALTER TABLE "watchlist" ADD COLUMN "genreIds" text`
      );
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_watchlist_user_created" ON "watchlist" ("requestedById", "createdAt")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_watchlist_user_type_title" ON "watchlist" ("requestedById", "mediaType", "title")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_watchlist_user_type_title"`);
    await queryRunner.query(`DROP INDEX "IDX_watchlist_user_created"`);
    await queryRunner.query(`ALTER TABLE "watchlist" DROP COLUMN "genreIds"`);
  }
}
