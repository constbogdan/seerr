import type { QueryRunner } from 'typeorm';

export const addLibraryFileResolution = async (
  queryRunner: QueryRunner
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE "library_file" ADD COLUMN "resolution" integer`
  );
};

export const removeLibraryFileResolution = async (
  queryRunner: QueryRunner
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE "library_file" DROP COLUMN "resolution"`
  );
};
