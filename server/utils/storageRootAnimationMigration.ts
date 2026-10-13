import type { QueryRunner } from 'typeorm';

export const addStorageRootAnimation = async (
  queryRunner: QueryRunner
): Promise<void> => {
  const defaultValue =
    queryRunner.connection.options.type === 'postgres' ? 'false' : '(0)';
  await queryRunner.query(
    `ALTER TABLE "storage_root" ADD COLUMN "isAnimation" boolean NOT NULL DEFAULT ${defaultValue}`
  );
};

export const removeStorageRootAnimation = async (
  queryRunner: QueryRunner
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE "storage_root" DROP COLUMN "isAnimation"`
  );
};
