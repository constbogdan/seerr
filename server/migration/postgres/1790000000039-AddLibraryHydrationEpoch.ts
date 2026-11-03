import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLibraryHydrationEpoch1790000000039 implements MigrationInterface {
  name = 'AddLibraryHydrationEpoch1790000000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "library_hydration_epoch" ("sourceSystem" character varying(16) NOT NULL, "sourceScope" character varying(128) NOT NULL, "epoch" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_library_hydration_epoch" PRIMARY KEY ("sourceSystem", "sourceScope"))`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "library_hydration_epoch"`);
  }
}
