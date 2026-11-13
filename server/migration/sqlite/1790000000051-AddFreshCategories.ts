import type { MigrationInterface, QueryRunner } from 'typeorm';
import { TableColumn } from 'typeorm';

export class AddFreshCategories1790000000051 implements MigrationInterface {
  name = 'AddFreshCategories1790000000051';

  public async up(runner: QueryRunner): Promise<void> {
    for (const name of ['isAnimation', 'isDocumentary'])
      await runner.addColumn(
        'fresh_discovery',
        new TableColumn({ name, type: 'boolean', isNullable: true })
      );
  }

  public async down(runner: QueryRunner): Promise<void> {
    for (const name of ['isDocumentary', 'isAnimation'])
      await runner.dropColumn('fresh_discovery', name);
  }
}
