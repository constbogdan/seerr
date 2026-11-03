import { addFreshV2, dropFreshV2 } from '@server/utils/freshV2Migration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFreshV21790000000048 implements MigrationInterface {
  name = 'AddFreshV21790000000048';
  public async up(runner: QueryRunner): Promise<void> {
    await addFreshV2(runner, 'datetime');
  }
  public async down(runner: QueryRunner): Promise<void> {
    await dropFreshV2(runner);
  }
}
