import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import FreshDiscovery from '@server/entity/FreshDiscovery';
import FreshSourceState from '@server/entity/FreshSourceState';
import FreshWork from '@server/entity/FreshWork';
import { classifyFreshGenres } from '@server/lib/fresh/categories';
import {
  backfillFreshCategories,
  previewFreshCategories,
} from '@server/lib/fresh/categoryBackfill';
import { FreshEngine } from '@server/lib/fresh/engine';
import { matchFreshIdentity } from '@server/lib/fresh/matching';
import { AddFreshCategories1790000000051 as PostgresMigration } from '@server/migration/postgres/1790000000051-AddFreshCategories';
import { AddFreshCategories1790000000051 } from '@server/migration/sqlite/1790000000051-AddFreshCategories';
import {
  createFixtureDatabase,
  fixtureNow,
  fixturePage,
  fixtureProvider,
  fixtureRelease,
  fixtureSettings,
} from '@server/test/freshFixtures';
import { addFreshV2 } from '@server/utils/freshV2Migration';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource, type QueryRunner, type Table } from 'typeorm';

describe('Fresh native category classification', () => {
  it('classifies only valid genres, including empty, mixed and dual categories', () => {
    for (const [genres, isAnimation, isDocumentary] of [
      [[], false, false],
      [[{ id: 16 }, { id: 18 }], true, false],
      [[{ id: 99 }], false, true],
      [[{ id: 99 }, { id: 16 }], true, true],
      [undefined, null, null],
      [null, null, null],
      [[{ id: '16' }], null, null],
      [[{ id: 16 }, null], null, null],
      [[{ id: -1 }], null, null],
    ] as const)
      assert.deepEqual(classifyFreshGenres(genres), {
        isAnimation,
        isDocumentary,
      });
  });

  it('uses the one existing verified Movie/TV detail response without changing identity confidence', async () => {
    for (const mediaType of ['movie', 'tv'] as const) {
      const provider = fixtureProvider();
      let calls = 0;
      const details = async () => {
        calls++;
        return {
          id: 7,
          ...(mediaType === 'movie'
            ? { title: 'Fixture' }
            : { name: 'Fixture' }),
          genres: [{ id: 16 }, { id: 99 }],
        };
      };
      provider.getMovie = async () => (await details()) as TmdbMovieDetails;
      provider.getTvShow = async () => (await details()) as TmdbTvDetails;
      provider.searchMoviesStrict = provider.searchTvShowsStrict = async () => {
        throw new Error('must not search');
      };
      assert.deepEqual(
        await matchFreshIdentity(
          new FreshWork({ mediaType, externalTmdbId: 7 }),
          [],
          provider
        ),
        {
          kind: 'resolved',
          id: 7,
          title: 'Fixture',
          isAnimation: true,
          isDocumentary: true,
        }
      );
      assert.equal(calls, 1);
    }
  });

  it('updates only title anchors independently of clocks and preserves known flags on missing genres', async () => {
    const database = await createFixtureDatabase();
    try {
      const releases = [
        fixtureRelease(1, {
          mediaType: 'tv',
          title: 'Fixture',
          tmdbId: 7,
          explicitSeason: true,
          seasonNumber: 1,
        }),
      ];
      const provider = fixtureProvider();
      let genres: { id: number; name: string }[] | undefined = [
        { id: 16, name: 'Animation' },
        { id: 99, name: 'Documentary' },
      ];
      let calls = 0;
      provider.getTvShow = async () => {
        calls++;
        return { id: 7, name: 'Fixture', genres } as TmdbTvDetails;
      };
      const engine = () =>
        new FreshEngine({
          database,
          now: () => fixtureNow,
          tmdb: provider,
          autobrr: () => ({
            filter: async () => ({ id: 7, name: 'Fixture', years: [] }),
            page: async (_filter, cursor) => fixturePage(releases, cursor),
          }),
        });
      await engine().run(fixtureSettings);
      const repository = database.getRepository(FreshDiscovery);
      const anchor = await repository.findOneByOrFail({ eventKey: 'series' });
      assert.equal(anchor.isAnimation, true);
      assert.equal(anchor.isDocumentary, true);
      const season = await repository.findOneByOrFail({ eventKey: 'season:1' });
      assert.equal(season.isAnimation, null);
      assert.equal(season.isDocumentary, null);
      await engine().run(fixtureSettings);
      assert.equal(calls, 1, 'unchanged release is not looked up again');
      genres = [];
      releases.unshift(
        fixtureRelease(2, {
          mediaType: 'tv',
          title: 'Fixture',
          tmdbId: 7,
          explicitSeason: true,
          seasonNumber: 2,
          observedAt: fixtureNow.getTime(),
        })
      );
      await engine().run(fixtureSettings);
      const corrected = await repository.findOneByOrFail({
        eventKey: 'series',
      });
      assert.equal(corrected.isAnimation, false);
      assert.equal(corrected.isDocumentary, false);
      assert.deepEqual(corrected.discoveredAt, anchor.discoveredAt);
      assert.deepEqual(corrected.visibleUntil, anchor.visibleUntil);
      genres = undefined;
      releases.unshift(
        fixtureRelease(3, {
          mediaType: 'tv',
          title: 'Fixture',
          tmdbId: 7,
          explicitSeason: true,
          seasonNumber: 3,
        })
      );
      await engine().run(fixtureSettings);
      assert.equal(
        (await repository.findOneByOrFail({ eventKey: 'series' })).isAnimation,
        false
      );
    } finally {
      await database.destroy();
    }
  });
});

describe('Explicit Fresh category maintenance', () => {
  it('previews the same bounded unknown title anchors without changing flags or source progress', async () => {
    const database = await createFixtureDatabase();
    try {
      assert.deepEqual(await previewFreshCategories({ database }), {
        dryRun: true,
        afterId: 0,
        limit: 20,
        maxLimit: 100,
        budgetMs: 120000,
        remainingUnknown: 0,
        unknownMovies: 0,
        unknownTv: 0,
        eligibleRecords: 0,
        selectedAnchorIds: [],
        nextAfterId: 0,
        hasMore: false,
      });
      const repository = database.getRepository(FreshDiscovery);
      const base = {
        sourceKey: 'preview',
        title: 'Historical',
        discoveredAt: fixtureNow,
        visibleUntil: fixtureNow,
      };
      await repository.save([
        new FreshDiscovery({
          ...base,
          id: 1,
          mediaType: 'movie',
          tmdbId: 1,
          eventKey: 'movie',
        }),
        new FreshDiscovery({
          ...base,
          id: 2,
          mediaType: 'tv',
          tmdbId: 1,
          eventKey: 'series',
        }),
        new FreshDiscovery({
          ...base,
          id: 3,
          mediaType: 'movie',
          tmdbId: 2,
          eventKey: 'movie',
          isAnimation: false,
          isDocumentary: true,
        }),
        new FreshDiscovery({
          ...base,
          id: 4,
          mediaType: 'tv',
          tmdbId: 2,
          eventKey: 'series',
          isAnimation: true,
        }),
        new FreshDiscovery({
          ...base,
          id: 5,
          mediaType: 'tv',
          tmdbId: 2,
          eventKey: 'season:2',
        }),
      ]);
      await database.getRepository(FreshSourceState).save(
        new FreshSourceState({
          sourceKey: 'preview',
          checkpoint: '77',
          scanCursor: '66',
        })
      );
      const before = await repository.find();
      const progress = await database.getRepository(FreshSourceState).find();
      await database.query('PRAGMA query_only=ON');
      const preview = await previewFreshCategories({ database, limit: 2 });
      assert.equal(preview.remainingUnknown, 3);
      assert.equal(preview.unknownMovies, 1);
      assert.equal(preview.unknownTv, 2);
      assert.equal(preview.eligibleRecords, 2);
      assert.deepEqual(preview.selectedAnchorIds, [1, 2]);
      assert.equal(preview.nextAfterId, 2);
      assert.equal(preview.hasMore, true);
      const next = await previewFreshCategories({
        database,
        afterId: 2,
        limit: 1,
      });
      assert.deepEqual(next.selectedAnchorIds, [4]);
      assert.equal(next.nextAfterId, 4);
      assert.equal(next.hasMore, false);
      const exhausted = await previewFreshCategories({ database, afterId: 99 });
      assert.equal(exhausted.nextAfterId, 99);
      assert.equal(exhausted.eligibleRecords, 0);
      assert.equal(exhausted.remainingUnknown, 3);
      for (const bounds of [
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { afterId: -1 },
        { afterId: NaN },
        { budgetMs: 0 },
      ])
        await assert.rejects(
          previewFreshCategories({ database, ...bounds }),
          /bounds/
        );
      assert.deepEqual(await repository.find(), before);
      assert.deepEqual(
        await database.getRepository(FreshSourceState).find(),
        progress
      );
    } finally {
      await database.destroy();
    }
  });
  it('defaults the command to a provider-free dry run that leaves an isolated database byte-identical', async () => {
    const prefix = path.join(tmpdir(), 'fresh-category-cli-');
    const directory = mkdtempSync(prefix);
    const filename = path.join(directory, 'fixture.sqlite3');
    const guard = path.join(directory, 'no-network.cjs');
    const database = new DataSource({
      type: 'sqlite',
      database: filename,
      entities: [FreshDiscovery],
      synchronize: true,
    });
    try {
      await database.initialize();
      await database.getRepository(FreshDiscovery).save(
        new FreshDiscovery({
          sourceKey: 'one',
          mediaType: 'movie',
          tmdbId: 7,
          eventKey: 'movie',
          title: 'Fixture',
          discoveredAt: fixtureNow,
          visibleUntil: fixtureNow,
        })
      );
      await database.destroy();
      const before = readFileSync(filename);
      writeFileSync(
        guard,
        `for (const p of ['http','https']) for (const k of ['get','request']) require(p)[k] = () => { throw new Error('network forbidden'); }; require(process.cwd() + '/server/api/themoviedb').default = class { constructor() { throw new Error('provider construction forbidden'); } };`
      );
      const result = spawnSync(
        process.execPath,
        [
          '-r',
          'ts-node/register',
          '-r',
          'tsconfig-paths/register',
          '-r',
          guard,
          'server/scripts/backfillFreshCategories.ts',
          '--database',
          filename,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...process.env,
            TS_NODE_PROJECT: path.resolve('server/tsconfig.json'),
            CONFIG_DIRECTORY: directory,
            TS_NODE_TRANSPILE_ONLY: 'true',
          },
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).dryRun, true);
      assert.equal(JSON.parse(result.stdout).remainingUnknown, 1);
      assert.deepEqual(JSON.parse(result.stdout).selectedAnchorIds, [1]);
      assert.deepEqual(readFileSync(filename), before);
      for (const args of [
        ['--limit', '0'],
        ['--limit', '101'],
        ['--after-id', '-1'],
        ['--limit', 'abc'],
      ]) {
        const invalid = spawnSync(
          process.execPath,
          [
            '-r',
            'ts-node/register',
            '-r',
            'tsconfig-paths/register',
            '-r',
            guard,
            'server/scripts/backfillFreshCategories.ts',
            '--database',
            filename,
            ...args,
          ],
          {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 60000,
            env: {
              ...process.env,
              TS_NODE_PROJECT: path.resolve('server/tsconfig.json'),
              TS_NODE_TRANSPILE_ONLY: 'true',
              CONFIG_DIRECTORY: directory,
            },
          }
        );
        assert.equal(invalid.status, 1);
        assert.match(invalid.stderr, /maintenance failed/);
        assert.deepEqual(readFileSync(filename), before);
      }
    } finally {
      if (database.isInitialized) await database.destroy();
      assert.ok(path.resolve(directory).startsWith(path.resolve(prefix)));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('resumes past failures, deduplicates typed lookups, preserves clocks and retries unknowns on a new pass', async () => {
    const database = await createFixtureDatabase();
    try {
      const repository = database.getRepository(FreshDiscovery);
      const base = {
        sourceKey: 'one',
        mediaType: 'movie' as const,
        tmdbId: 1,
        eventKey: 'movie',
        title: 'Fixture',
        discoveredAt: fixtureNow,
        visibleUntil: fixtureNow,
      };
      const failed = await repository.save(
        new FreshDiscovery({ ...base, isAnimation: true })
      );
      await repository.save(new FreshDiscovery({ ...base, tmdbId: 2 }));
      await repository.save(
        new FreshDiscovery({ ...base, sourceKey: 'two', tmdbId: 2 })
      );
      await repository.save(
        new FreshDiscovery({
          ...base,
          mediaType: 'tv',
          tmdbId: 2,
          eventKey: 'series',
        })
      );
      await repository.save(
        new FreshDiscovery({
          ...base,
          mediaType: 'tv',
          tmdbId: 2,
          eventKey: 'season:1',
        })
      );
      let fail = true;
      let movieCalls = 0;
      let tvCalls = 0;
      const provider = fixtureProvider();
      provider.getMovie = async ({ movieId }) => {
        movieCalls++;
        if (movieId === 1 && fail) throw new Error('fixture failure');
        return {
          id: movieId,
          title: 'Fixture',
          genres: [{ id: 16 }],
        } as TmdbMovieDetails;
      };
      provider.getTvShow = async ({ tvId }) => {
        tvCalls++;
        return {
          id: tvId,
          name: 'Fixture',
          genres: [{ id: 99 }],
        } as TmdbTvDetails;
      };
      const first = await backfillFreshCategories({
        database,
        provider,
        limit: 1,
      });
      assert.equal(first.failures, 1);
      assert.equal(first.nextAfterId, failed.id);
      const next = await backfillFreshCategories({
        database,
        provider,
        afterId: first.nextAfterId,
      });
      assert.equal(next.updated, 3);
      assert.equal(next.hasMore, false);
      assert.equal(next.remainingUnknown, 1);
      assert.equal(
        movieCalls,
        2,
        'same Movie identity across sources is hydrated once per batch'
      );
      assert.equal(tvCalls, 1, 'TV is a separate identity');
      assert.equal(
        (await repository.findOneByOrFail({ id: failed.id })).isAnimation,
        true
      );
      fail = false;
      assert.equal(
        (await backfillFreshCategories({ database, provider }))
          .remainingUnknown,
        0
      );
      for (const row of await repository.find()) {
        assert.deepEqual(row.discoveredAt, fixtureNow);
        assert.deepEqual(row.visibleUntil, fixtureNow);
        if (row.eventKey === 'season:1') assert.equal(row.isDocumentary, null);
      }
      assert.equal(await database.getRepository(FreshWork).count(), 0);
      assert.equal(await database.getRepository(FreshSourceState).count(), 0);
      assert.deepEqual(await database.query('PRAGMA foreign_key_check'), []);
    } finally {
      await database.destroy();
    }
  });

  it('leaves malformed genres and wrong typed detail identities unknown, and enforces batch/time bounds', async () => {
    const database = await createFixtureDatabase();
    try {
      const repository = database.getRepository(FreshDiscovery);
      for (const tmdbId of [1, 2, 3])
        await repository.save(
          new FreshDiscovery({
            sourceKey: 'one',
            mediaType: 'movie',
            tmdbId,
            eventKey: 'movie',
            title: 'Fixture',
            discoveredAt: fixtureNow,
            visibleUntil: fixtureNow,
          })
        );
      const provider = fixtureProvider();
      provider.getMovie = async ({ movieId }) =>
        ({
          id: movieId === 2 ? 999 : movieId,
          title: 'Fixture',
        }) as TmdbMovieDetails;
      const result = await backfillFreshCategories({
        database,
        provider,
        limit: 2,
      });
      assert.equal(result.inspected, 2);
      assert.equal(result.unavailableGenres, 1);
      assert.equal(result.failures, 1);
      assert.equal(result.remainingUnknown, 3);
      let time = 0;
      const bounded = await backfillFreshCategories({
        database,
        provider,
        now: () => time++,
        budgetMs: 1,
      });
      assert.equal(bounded.inspected, 0);
      await assert.rejects(
        backfillFreshCategories({ database, provider, limit: 101 })
      );
    } finally {
      await database.destroy();
    }
  });
});

describe('Fresh category additive migrations', () => {
  it('preserves historical clocks and nullable unknowns, matches entities, and rolls back only the new columns', async () => {
    const database = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [FreshDiscovery, FreshWork, FreshSourceState],
    });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await addFreshV2(runner, 'datetime');
      await runner.query(
        `INSERT INTO fresh_discovery (sourceKey,mediaType,tmdbId,eventKey,discoveredAt,visibleUntil,title) VALUES ('one','tv',7,'series','2020-01-01','2020-01-08','Fixture')`
      );
      const migration = new AddFreshCategories1790000000051();
      await migration.up(runner);
      const row = (await runner.query('SELECT * FROM fresh_discovery'))[0];
      assert.equal(row.isAnimation, null);
      assert.equal(row.isDocumentary, null);
      assert.equal(row.discoveredAt, '2020-01-01');
      assert.deepEqual(
        (await database.driver.createSchemaBuilder().log()).upQueries,
        []
      );
      await migration.down(runner);
      const restored = (await runner.query('SELECT * FROM fresh_discovery'))[0];
      assert.equal(restored.discoveredAt, row.discoveredAt);
      assert.equal(restored.title, 'Fixture');
      assert.equal('isAnimation' in restored, false);
    } finally {
      await runner.release();
      await database.destroy();
    }
  });

  it('generates nullable PostgreSQL booleans without connecting or touching existing columns', async () => {
    const database = new DataSource({ type: 'postgres', database: 'unused' });
    const runner = database.createQueryRunner();
    runner.enableSqlMemory();
    const tables: Table[] = [];
    await addFreshV2(
      {
        createTable: async (table: Table) => {
          tables.push(table);
        },
      } as unknown as QueryRunner,
      'timestamptz'
    );
    // Supply the historical schema fixture instead of live introspection; the
    // PostgreSQL runner still generates the actual ALTER TABLE statements.
    const addColumn = runner.addColumn.bind(runner);
    runner.addColumn = async (_name, column) => addColumn(tables[2], column);
    await new PostgresMigration().up(runner);
    const statements = runner
      .getMemorySql()
      .upQueries.map((query) => query.query);
    assert.ok(
      statements.includes(
        'ALTER TABLE "fresh_discovery" ADD "isAnimation" boolean'
      )
    );
    assert.ok(
      statements.includes(
        'ALTER TABLE "fresh_discovery" ADD "isDocumentary" boolean'
      )
    );
  });
});
