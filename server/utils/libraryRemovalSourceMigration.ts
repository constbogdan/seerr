import type { QueryRunner } from 'typeorm';

const tables = ['library_presence', 'library_file'] as const;

export const addLibraryRemovalSource = async (
  queryRunner: QueryRunner
): Promise<void> => {
  for (const table of tables) {
    await queryRunner.query(
      `ALTER TABLE "${table}" ADD COLUMN "removalSource" varchar(16)`
    );
    await queryRunner.query(
      `UPDATE "${table}" SET "removalSource" = 'unknown' ` +
        `WHERE "removedAt" IS NOT NULL AND "removalSource" IS NULL`
    );
  }
};

export const removeLibraryRemovalSource = async (
  queryRunner: QueryRunner
): Promise<void> => {
  for (const table of [...tables].reverse()) {
    await queryRunner.query(
      `ALTER TABLE "${table}" DROP COLUMN "removalSource"`
    );
  }
};
