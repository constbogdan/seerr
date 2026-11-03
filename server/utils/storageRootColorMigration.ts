import type { QueryRunner } from 'typeorm';

export const addStorageRootColor = async (
  queryRunner: QueryRunner
): Promise<void> => {
  await queryRunner.query(
    `ALTER TABLE "storage_root" ADD COLUMN "color" varchar(7)`
  );
};

export const removeStorageRootColor = async (
  queryRunner: QueryRunner
): Promise<void> => {
  await queryRunner.query(`ALTER TABLE "storage_root" DROP COLUMN "color"`);
};
