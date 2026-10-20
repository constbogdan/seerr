import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { AllSettings } from '@server/lib/settings';
import { runMigrations } from '@server/lib/settings/migrator';

describe('settings migration loader', () => {
  it('preserves historical markers, tolerates removed 0009, and runs 0010', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'seerr-settings-'));
    const migrations = path.join(directory, 'migrations');
    const settingsPath = path.join(directory, 'settings.json');
    const initial = {
      migrations: [
        '0007_migrate_arr_tags',
        '0008_migrate_blacklist_to_blocklist',
        '0009_remove_overflow_preview_mode',
      ],
      futureMigrationApplied: false,
    } as unknown as AllSettings;

    try {
      mkdirSync(migrations);
      const migration0007 = path.join(
        __dirname,
        'migrations/0007_migrate_arr_tags.ts'
      );
      const migration0008 = path.join(
        __dirname,
        'migrations/0008_migrate_blacklist_to_blocklist.ts'
      );
      writeFileSync(
        path.join(migrations, '0007_migrate_arr_tags.js'),
        `module.exports = require(${JSON.stringify(migration0007)}).default;`
      );
      writeFileSync(
        path.join(migrations, '0008_migrate_blacklist_to_blocklist.js'),
        `module.exports = require(${JSON.stringify(migration0008)}).default;`
      );
      writeFileSync(
        path.join(migrations, '0010_future_settings.js'),
        "module.exports = async (settings) => ({ ...settings, futureMigrationApplied: true, migrations: [...settings.migrations, '0010_future_settings'] });"
      );
      writeFileSync(settingsPath, JSON.stringify(initial));

      const migrated = (await runMigrations(
        initial,
        settingsPath,
        migrations
      )) as AllSettings & { futureMigrationApplied: boolean };

      assert.deepEqual(migrated.migrations, [
        '0007_migrate_arr_tags',
        '0008_migrate_blacklist_to_blocklist',
        '0009_remove_overflow_preview_mode',
        '0010_future_settings',
      ]);
      assert.equal(migrated.futureMigrationApplied, true);
      assert.deepEqual(initial.migrations, [
        '0007_migrate_arr_tags',
        '0008_migrate_blacklist_to_blocklist',
        '0009_remove_overflow_preview_mode',
      ]);
      assert.deepEqual(
        JSON.parse(await readFile(settingsPath, 'utf8')).migrations,
        migrated.migrations
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(settingsPath.replace('.json', '.old.json'), 'utf8')
        ).migrations,
        initial.migrations
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
