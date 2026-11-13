/* eslint-disable no-console -- Explicit maintenance command emits bounded progress only. */
import TheMovieDb from '@server/api/themoviedb';
import FreshDiscovery from '@server/entity/FreshDiscovery';
import {
  backfillFreshCategories,
  previewFreshCategories,
} from '@server/lib/fresh/categoryBackfill';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DataSource } from 'typeorm';

const main = async () => {
  const command = new Command()
    .description(
      'Classify a bounded batch of unknown Fresh title anchors on an offline SQLite database'
    )
    .requiredOption(
      '--database <path>',
      'Explicit existing migrated SQLite database'
    )
    .option('--apply', 'Allow metadata reads and classification writes', false)
    .option('--after-id <id>', 'Resume after the last reported anchor ID', '0')
    .option('--limit <count>', 'Maximum anchors (1-100)', '20')
    .parse();
  const options = command.opts<{
    database: string;
    apply: boolean;
    afterId: string;
    limit: string;
  }>();
  if (!path.isAbsolute(options.database) || !existsSync(options.database))
    throw new Error('An existing absolute database path is required');
  const database = new DataSource({
    type: 'sqlite',
    database: options.database,
    entities: [FreshDiscovery],
    synchronize: false,
    migrationsRun: false,
  });
  await database.initialize();
  try {
    const batch = {
      database,
      afterId: Number(options.afterId),
      limit: Number(options.limit),
    };
    if (!options.apply) {
      await database.query('PRAGMA query_only=ON');
      console.log(JSON.stringify(await previewFreshCategories(batch)));
      return;
    }
    const result = await backfillFreshCategories({
      ...batch,
      provider: new TheMovieDb(),
    });
    console.log(JSON.stringify(result));
  } finally {
    await database.destroy();
  }
};

void main().catch(() => {
  console.error(
    'Fresh category maintenance failed; check the database schema and arguments.'
  );
  process.exitCode = 1;
});
