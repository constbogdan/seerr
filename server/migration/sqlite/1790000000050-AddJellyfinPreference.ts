import {
  addJellyfinPreference,
  dropJellyfinPreference,
} from '@server/utils/jellyfinPreferenceMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddJellyfinPreference1790000000050 implements MigrationInterface {
  name = 'AddJellyfinPreference1790000000050';
  public async up(runner: QueryRunner): Promise<void> {
    await addJellyfinPreference(runner, 'datetime');
  }
  public async down(runner: QueryRunner): Promise<void> {
    await dropJellyfinPreference(runner);
  }
}
