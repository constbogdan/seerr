import FreshDiscovery from '@server/entity/FreshDiscovery';
import FreshSourceState from '@server/entity/FreshSourceState';
import FreshWork from '@server/entity/FreshWork';
import { FreshEngine } from '@server/lib/fresh/engine';
import logger from '@server/logger';
import {
  createFixtureDatabase,
  fixtureNow,
  fixturePage,
  fixtureProvider,
  fixtureRelease,
  fixtureSettings,
} from '@server/test/freshFixtures';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { DataSource } from 'typeorm';

describe('Fresh V2 durable sync', () => {
  let database: DataSource;
  let clock: Date;
  beforeEach(async () => {
    database = await createFixtureDatabase();
    clock = new Date(fixtureNow);
  });
  afterEach(async () => {
    mock.restoreAll();
    await database.destroy();
  });
  const engine = (
    releases: ReturnType<typeof fixtureRelease>[],
    extra: Partial<ConstructorParameters<typeof FreshEngine>[0]> = {}
  ) =>
    new FreshEngine({
      database,
      now: () => clock,
      pagesPerRun: 10,
      tmdb: fixtureProvider(),
      autobrr: () => ({
        filter: async () => ({ id: 7, name: 'Fresh', years: [2025, 2026] }),
        page: async (_filter, cursor) => fixturePage(releases, cursor),
      }),
      ...extra,
    });

  it('traverses all history over multiple executions and restarts without early checkpoint completion', async () => {
    const releases = Array.from({ length: 8 }, (_, index) =>
      fixtureRelease(8 - index)
    );
    for (let run = 0; run < 4; run++) {
      const result = await engine(releases, { pagesPerRun: 1 }).run(
        fixtureSettings
      );
      assert.equal(result.sourceFailed, false);
      assert.equal(result.backfillComplete, false);
      assert.equal(
        (
          await database
            .getRepository(FreshSourceState)
            .findOneByOrFail({ id: 1 })
        ).checkpoint,
        null
      );
    }
    const result = await engine(releases, { pagesPerRun: 1 }).run(
      fixtureSettings
    );
    assert.equal(result.backfillComplete, true);
    assert.equal(await database.getRepository(FreshWork).count(), 8);
    assert.equal(
      (
        await database
          .getRepository(FreshSourceState)
          .findOneByOrFail({ id: 1 })
      ).checkpoint,
      '8'
    );
  });

  it('records arbitrarily old approved media without release-age admission or ingestion-time clocks', async () => {
    const observedAt = Date.parse('2010-01-01T00:00:00Z');
    await engine([fixtureRelease(1, { observedAt, year: 1995 })]).run(
      fixtureSettings
    );
    const discovery = await database
      .getRepository(FreshDiscovery)
      .findOneByOrFail({ tmdbId: 1 });
    assert.equal(
      discovery.discoveredAt.toISOString(),
      '2010-01-01T00:00:00.000Z'
    );
    assert.equal(
      discovery.visibleUntil.toISOString(),
      '2010-01-08T00:00:00.000Z'
    );
  });

  it('captures new arrivals after an interrupted frozen-head backfill', async () => {
    const releases = [
      fixtureRelease(4),
      fixtureRelease(3),
      fixtureRelease(2),
      fixtureRelease(1),
    ];
    await engine(releases, { pagesPerRun: 1 }).run(fixtureSettings);
    releases.unshift(fixtureRelease(5));
    await engine(releases).run(fixtureSettings);
    assert.equal(
      (
        await database
          .getRepository(FreshSourceState)
          .findOneByOrFail({ id: 1 })
      ).checkpoint,
      '4'
    );
    await engine(releases).run(fixtureSettings);
    assert.equal(
      (
        await database
          .getRepository(FreshSourceState)
          .findOneByOrFail({ id: 1 })
      ).checkpoint,
      '5'
    );
    assert.equal(await database.getRepository(FreshWork).count(), 5);
  });

  it('does zero TMDB lookups on unchanged runs and repeated release groups', async () => {
    let calls = 0;
    const tmdb = fixtureProvider();
    const search = tmdb.searchMoviesStrict;
    tmdb.searchMoviesStrict = async (options) => {
      calls++;
      return search(options);
    };
    const releases = [
      fixtureRelease(2, { title: 'Movie 1' }),
      fixtureRelease(1),
    ];
    await engine(releases, { tmdb }).run(fixtureSettings);
    assert.equal(calls, 1);
    const second = await engine(releases, { tmdb }).run(fixtureSettings);
    assert.equal(second.examined, 0);
    assert.equal(calls, 1);
    assert.equal(await database.getRepository(FreshWork).count(), 1);
    assert.equal(await database.getRepository(FreshDiscovery).count(), 1);
  });

  it('moves discovery earlier as older source evidence arrives, never later for upgrades', async () => {
    const releases = [
      fixtureRelease(3, { title: 'Movie 1' }),
      fixtureRelease(2, { title: 'Movie 1' }),
      fixtureRelease(1, { observedAt: fixtureNow.getTime() - 10 * 86400000 }),
    ];
    await engine(releases, { pagesPerRun: 1 }).run(fixtureSettings);
    await engine(releases).run(fixtureSettings);
    const original = await database
      .getRepository(FreshDiscovery)
      .findOneByOrFail({ tmdbId: 1 });
    releases.unshift(
      fixtureRelease(4, { title: 'Movie 1', observedAt: fixtureNow.getTime() })
    );
    await engine(releases).run(fixtureSettings);
    const later = await database
      .getRepository(FreshDiscovery)
      .findOneByOrFail({ tmdbId: 1 });
    assert.equal(later.discoveredAt.getTime(), original.discoveredAt.getTime());
    assert.equal(
      later.discoveredAt.getTime(),
      fixtureNow.getTime() - 10 * 86400000
    );
  });

  it('keeps continuation on source outage and resumes after bounded backoff', async () => {
    const releases = [
      fixtureRelease(4),
      fixtureRelease(3),
      fixtureRelease(2),
      fixtureRelease(1),
    ];
    await engine(releases, { pagesPerRun: 1 }).run(fixtureSettings);
    const broken = engine(releases, {
      autobrr: () => ({
        filter: async () => ({ id: 7, name: 'Fresh', years: [] }),
        page: async () => {
          throw new Error('secret source payload');
        },
      }),
    });
    const failed = await broken.run(fixtureSettings);
    assert.equal(failed.sourceFailed, true);
    const state = await database
      .getRepository(FreshSourceState)
      .findOneByOrFail({ id: 1 });
    assert.equal(state.scanCursor, '3');
    assert.equal(state.checkpoint, null);
    assert.equal(state.lastError, 'source_unavailable_or_invalid');
    clock = new Date(clock.getTime() + 60000);
    assert.equal(
      (await engine(releases).run(fixtureSettings)).backfillComplete,
      true
    );
    assert.equal(await database.getRepository(FreshWork).count(), 4);
  });

  it('recovers missing checkpoint and ID regression automatically using retained history', async () => {
    await engine([fixtureRelease(8)]).run(fixtureSettings);
    await engine([
      fixtureRelease(12),
      fixtureRelease(11),
      fixtureRelease(10),
    ]).run(fixtureSettings);
    assert.equal(
      (
        await database
          .getRepository(FreshSourceState)
          .findOneByOrFail({ id: 1 })
      ).checkpoint,
      '12'
    );
    await engine([fixtureRelease(3), fixtureRelease(2)]).run(fixtureSettings);
    assert.equal(
      (
        await database
          .getRepository(FreshSourceState)
          .findOneByOrFail({ id: 1 })
      ).checkpoint,
      '3'
    );
    assert.equal(await database.getRepository(FreshWork).count(), 6);
  });

  it('retries metadata failures without blocking durable ingestion or fabricating no-match', async () => {
    const tmdb = fixtureProvider();
    tmdb.searchMoviesStrict = async () => {
      throw new Error('authorization=secret');
    };
    const failed = await engine([fixtureRelease(1)], { tmdb }).run(
      fixtureSettings
    );
    assert.equal(failed.retried, 1);
    assert.equal(
      (await database.getRepository(FreshWork).findOneByOrFail({ id: 1 }))
        .outcome,
      'retry'
    );
    assert.equal(
      (
        await database
          .getRepository(FreshSourceState)
          .findOneByOrFail({ id: 1 })
      ).checkpoint,
      '1'
    );
    assert.equal(
      (await engine([fixtureRelease(1)]).run(fixtureSettings)).examined,
      0
    );
    clock = new Date(clock.getTime() + 60000);
    assert.equal(
      (await engine([fixtureRelease(1)]).run(fixtureSettings)).resolved,
      1
    );
  });

  it('records one Series identity and separate regular Seasons without Season provider calls', async () => {
    const base = {
      mediaType: 'tv' as const,
      title: 'Long Running Series',
      year: 2026,
      explicitSeason: true,
    };
    const releases = [
      fixtureRelease(4, { ...base, seasonNumber: 2026 }),
      fixtureRelease(3, { ...base, seasonNumber: 2026 }),
      fixtureRelease(2, { ...base, seasonNumber: 2 }),
      fixtureRelease(1, { ...base, seasonNumber: 1 }),
    ];
    await engine(releases).run(fixtureSettings);
    const discoveries = await database.getRepository(FreshDiscovery).find();
    assert.deepEqual(discoveries.map((row) => row.eventKey).sort(), [
      'season:1',
      'season:2',
      'season:2026',
      'series',
    ]);
    assert.ok(discoveries.every((row) => row.tmdbId === 201));
    const before = discoveries.map((row) => [
      row.eventKey,
      row.discoveredAt.getTime(),
    ]);
    releases.unshift(
      fixtureRelease(5, {
        ...base,
        seasonNumber: 0,
        explicitSeason: false,
        explicitSpecial: true,
        episodeNumber: 7,
        observedAt: clock.getTime(),
      })
    );
    await engine(releases).run(fixtureSettings);
    assert.deepEqual(
      (await database.getRepository(FreshDiscovery).find()).map((row) => [
        row.eventKey,
        row.discoveredAt.getTime(),
      ]),
      before
    );
  });

  it('does not execute when disabled and cancels bounded work without losing saved continuation', async () => {
    const sync = engine([fixtureRelease(1)]);
    assert.equal(
      (await sync.run({ ...fixtureSettings, enabled: false })).examined,
      0
    );
    assert.equal(await database.getRepository(FreshSourceState).count(), 0);
  });
  it('bounds and sanitizes metadata warnings during an outage', async () => {
    const warnings: unknown[] = [];
    mock.method(logger, 'warn', (...args: unknown[]) => {
      warnings.push(args);
      return logger;
    });
    const tmdb = fixtureProvider();
    tmdb.searchMoviesStrict = async () => {
      throw new Error('Authorization: super-secret provider payload');
    };
    const releases = Array.from({ length: 8 }, (_, index) =>
      fixtureRelease(8 - index)
    );
    const result = await engine(releases, { tmdb }).run(fixtureSettings);
    assert.equal(result.retried, 8);
    assert.equal(warnings.length, 3);
    assert.match(JSON.stringify(warnings), /identity|workId/);
    assert.doesNotMatch(
      JSON.stringify(warnings),
      /Authorization|super-secret|payload|fixture-token/
    );
  });
  it('persists cancellation progress and resumes without skipping source pages', async () => {
    const releases = [
      fixtureRelease(4),
      fixtureRelease(3),
      fixtureRelease(2),
      fixtureRelease(1),
    ];
    const sync: FreshEngine = engine(releases, {
      autobrr: () => ({
        filter: async () => ({ id: 7, name: 'Fresh', years: [] }),
        page: async (_filter, cursor) => {
          const page = fixturePage(releases, cursor);
          sync.cancel();
          return page;
        },
      }),
    });
    assert.equal((await sync.run(fixtureSettings)).cancelled, true);
    assert.equal(
      (
        await database
          .getRepository(FreshSourceState)
          .findOneByOrFail({ id: 1 })
      ).scanCursor,
      '3'
    );
    await engine(releases).run(fixtureSettings);
    assert.equal(await database.getRepository(FreshWork).count(), 4);
  });
  it('does not advance a checkpoint after invalid page ordering', async () => {
    const release = fixtureRelease(1);
    const result = await engine([release], {
      autobrr: () => ({
        filter: async () => ({ id: 7, name: 'Fresh', years: [] }),
        page: async () => ({
          ...fixturePage([release]),
          releaseIds: ['1', '1'],
        }),
      }),
    }).run(fixtureSettings);
    assert.equal(result.sourceFailed, true);
    assert.equal(
      (
        await database
          .getRepository(FreshSourceState)
          .findOneByOrFail({ id: 1 })
      ).checkpoint,
      null
    );
    assert.equal(await database.getRepository(FreshWork).count(), 0);
  });
  it('automatically captures late approvals beyond the head page with bounded historical probing', async () => {
    const releases = Array.from({ length: 10 }, (_, index) =>
      fixtureRelease(10 - index)
    );
    let approved = false;
    let pageCalls = 0;
    const source = () => ({
      filter: async () => ({ id: 7, name: 'Fresh', years: [] }),
      page: async (_filter: { id: number }, cursor = 0) => {
        pageCalls++;
        const page = fixturePage(releases, cursor);
        return {
          ...page,
          releases: page.releases.filter(
            (release) => approved || release.releaseId !== '3'
          ),
        };
      },
    });
    await engine(releases, { autobrr: source }).run(fixtureSettings);
    assert.equal(await database.getRepository(FreshWork).count(), 9);
    approved = true;
    for (let tick = 0; tick < 4; tick++) {
      pageCalls = 0;
      await engine(releases, { autobrr: source }).run(fixtureSettings);
      assert.ok(pageCalls <= 2);
    }
    assert.equal(await database.getRepository(FreshWork).count(), 10);
    assert.equal(
      await database.getRepository(FreshDiscovery).countBy({ tmdbId: 3 }),
      1
    );
  });
});
