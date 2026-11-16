import {
  addSimilarCollections,
  dropSimilarCollections,
} from '@server/utils/similarCollectionsMigration';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSimilarCollections1790000000053 implements MigrationInterface {
  name = 'AddSimilarCollections1790000000053';

  public up(runner: QueryRunner): Promise<void> {
    return addSimilarCollections(runner, 'datetime');
  }

  public down(runner: QueryRunner): Promise<void> {
    return dropSimilarCollections(runner);
  }
}
