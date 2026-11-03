import { createHash } from 'crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { Table } from 'typeorm';

const normalizeTitle = (title: string): string =>
  title
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/'/g, '')
    .replace(/(^|[^\p{L}\p{N}])&(?=[^\p{L}\p{N}]|$)/gu, '$1and')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const evidenceKey = (candidate: {
  displayTitle: string;
  matchYear: number;
  seasonKey: number;
  specialEpisodeKey: number;
}) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        1,
        normalizeTitle(candidate.displayTitle),
        candidate.matchYear || 0,
        candidate.seasonKey,
        candidate.specialEpisodeKey,
      ])
    )
    .digest('hex');

export class AddFreshCandidateVisibility1790000000012 implements MigrationInterface {
  name = 'AddFreshCandidateVisibility1790000000012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const candidates = (await queryRunner.query(
      `SELECT "id", "displayTitle", "matchYear", "seasonKey", "specialEpisodeKey"
       FROM "fresh_candidate" WHERE "sourceEvidenceKey" = ''`
    )) as (Parameters<typeof evidenceKey>[0] & { id: number })[];
    for (const candidate of candidates) {
      await queryRunner.query(
        `UPDATE "fresh_candidate" SET "sourceEvidenceKey" = ? WHERE "id" = ?`,
        [evidenceKey(candidate), candidate.id]
      );
    }
    await queryRunner.createTable(
      new Table({
        name: 'fresh_candidate_visibility',
        columns: [
          {
            name: 'id',
            type: 'integer',
            isPrimary: true,
            isGenerated: true,
            generationStrategy: 'increment',
          },
          { name: 'sourceEvidenceVersion', type: 'integer', default: 1 },
          { name: 'mediaType', type: 'varchar', length: '8' },
          { name: 'sourceEvidenceKey', type: 'varchar', length: '64' },
          { name: 'show', type: 'boolean', default: 1 },
        ],
        uniques: [
          {
            name: 'UQ_fresh_candidate_visibility_source',
            columnNames: [
              'sourceEvidenceVersion',
              'mediaType',
              'sourceEvidenceKey',
            ],
          },
        ],
      }),
      true
    );
    await queryRunner.query(`
      INSERT OR IGNORE INTO "fresh_candidate_visibility"
        ("sourceEvidenceVersion", "mediaType", "sourceEvidenceKey", "show")
      SELECT 1, "mediaType", "sourceEvidenceKey", 1
      FROM "fresh_candidate"
      WHERE "sourceEvidenceKey" <> ''
      GROUP BY "mediaType", "sourceEvidenceKey"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('fresh_candidate_visibility', true);
  }
}
