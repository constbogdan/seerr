import type { QueryRunner } from 'typeorm';

export const addStorageRootDisplayName = async (
  queryRunner: QueryRunner
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE "storage_root" ADD COLUMN "displayName" varchar(120)`
  );
};

export const removeStorageRootDisplayName = async (
  queryRunner: QueryRunner
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE "storage_root" DROP COLUMN "displayName"`
  );
};
