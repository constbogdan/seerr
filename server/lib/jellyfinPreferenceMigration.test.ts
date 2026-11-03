import { AddJellyfinPreference1790000000050 as PostgresMigration } from '@server/migration/postgres/1790000000050-AddJellyfinPreference';
import { AddJellyfinPreference1790000000050 as SqliteMigration } from '@server/migration/sqlite/1790000000050-AddJellyfinPreference';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource, type QueryRunner, type TableColumn } from 'typeorm';

describe('Jellyfin preference migration', () => {
  it('preserves existing state on upgrade/rollback and preference across database restart', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'seerr-preference-migration-')
    );
    const options = {
      type: 'sqlite' as const,
      database: path.join(directory, 'fixture.sqlite3'),
    };
    let db = await new DataSource(options).initialize();
    try {
      await db.query(
        'CREATE TABLE user_media_state (id integer PRIMARY KEY, jellyfinPlayed boolean, tmdbId integer)'
      );
      await db.query('INSERT INTO user_media_state VALUES (1, 1, 10)');
      await new SqliteMigration().up(db.createQueryRunner());
      assert.deepEqual(
        await db.query(
          'SELECT jellyfinPlayed, jellyfinLikes, jellyfinPreferenceObservedAt FROM user_media_state'
        ),
        [
          {
            jellyfinPlayed: 1,
            jellyfinLikes: null,
            jellyfinPreferenceObservedAt: null,
          },
        ]
      );
      await db.query(
        "UPDATE user_media_state SET jellyfinLikes=0, jellyfinPreferenceObservedAt='2026-10-29 12:00:00' WHERE id=1"
      );
      await db.destroy();
      db = await new DataSource(options).initialize();
      assert.equal(
        (await db.query('SELECT jellyfinLikes FROM user_media_state'))[0]
          .jellyfinLikes,
        0
      );
      await new SqliteMigration().down(db.createQueryRunner());
      assert.deepEqual(await db.query('SELECT * FROM user_media_state'), [
        { id: 1, jellyfinPlayed: 1, tmdbId: 10 },
      ]);
    } finally {
      if (db.isInitialized) await db.destroy();
      await rm(directory, { recursive: true });
    }
  });
  it('uses equivalent nullable PostgreSQL columns and a timezone-aware observation timestamp', async () => {
    const columns: TableColumn[] = [];
    const dropped: string[] = [];
    const runner = {
      addColumns: async (_table: string, values: TableColumn[]) =>
        columns.push(...values),
      dropColumns: async (_table: string, names: string[]) =>
        dropped.push(...names),
    } as unknown as QueryRunner;
    await new PostgresMigration().up(runner);
    assert.equal(columns.length, 6);
    assert.ok(
      columns
        .filter((c) => c.name !== 'jellyfinPlayStateTracked')
        .every((c) => c.isNullable)
    );
    assert.equal(
      columns.find((c) => c.name === 'jellyfinPreferenceObservedAt')?.type,
      'timestamp with time zone'
    );
    await new PostgresMigration().down(runner);
    assert.deepEqual(
      dropped,
      columns.map((c) => c.name)
    );
  });
});
