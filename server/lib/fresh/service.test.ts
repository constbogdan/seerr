import FreshDiscovery from '@server/entity/FreshDiscovery';
import FreshSourceState from '@server/entity/FreshSourceState';
import FreshWork from '@server/entity/FreshWork';
import { SynchronizationPolicy } from '@server/job/synchronizationPolicy';
import { freshSourceKey } from '@server/lib/fresh/engine';
import { FreshService } from '@server/lib/fresh/service';
import Settings from '@server/lib/settings';
import {
  createFixtureDatabase,
  fixtureSettings,
} from '@server/test/freshFixtures';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

describe('Fresh V2 coordination and containment', () => {
  it('reads current health without provider calls, database writes or checkpoint advancement', async () => {
    const database = await createFixtureDatabase();
    const sourceKey = freshSourceKey(fixtureSettings);
    const now = Date.now();
    const service = new FreshService(
      {
        run: async () => assert.fail('status must not run the engine'),
        cancel: () => assert.fail('status must not cancel work'),
      },
      database,
      new SynchronizationPolicy('contained')
    );
    try {
      await database.getRepository(FreshSourceState).save(
        new FreshSourceState({
          sourceKey,
          backfillComplete: true,
          checkpoint: '50',
          lastIngestedAt: new Date(now - 3600000),
        })
      );
      await database.getRepository(FreshDiscovery).save([
        new FreshDiscovery({
          sourceKey,
          mediaType: 'movie',
          tmdbId: 1,
          eventKey: 'movie',
          title: 'Movie',
          discoveredAt: new Date(now - 86400000),
          visibleUntil: new Date(now + 86400000),
        }),
        new FreshDiscovery({
          sourceKey,
          mediaType: 'tv',
          tmdbId: 2,
          eventKey: 'season:1',
          title: 'Series',
          discoveredAt: new Date(now - 86400000),
          visibleUntil: new Date(now + 86400000),
        }),
        new FreshDiscovery({
          sourceKey,
          mediaType: 'tv',
          tmdbId: 2,
          eventKey: 'season:2',
          title: 'Series',
          discoveredAt: new Date(now - 86400000),
          visibleUntil: new Date(now + 86400000),
        }),
        new FreshDiscovery({
          sourceKey,
          mediaType: 'movie',
          tmdbId: 3,
          eventKey: 'movie',
          title: 'Expired',
          discoveredAt: new Date(now - 30 * 86400000),
          visibleUntil: new Date(now - 86400000),
        }),
      ]);
      await database.getRepository(FreshWork).save(
        ['pending', 'retry'].map(
          (outcome, i) =>
            new FreshWork({
              sourceKey,
              groupKey: 'fixture-' + i,
              mediaType: 'movie',
              title: 'Movie',
              sourceTitle: 'Movie.2026',
              outcome: outcome as 'pending' | 'retry',
              firstObservedAt: new Date(now - 86400000),
            })
        )
      );
      service.configure(fixtureSettings);
      const snapshot = async () =>
        Promise.all([
          database.getRepository(FreshSourceState).find(),
          database.getRepository(FreshDiscovery).find(),
          database.getRepository(FreshWork).find(),
        ]);
      const before = await snapshot();
      const queries = mock.method(database.logger, 'logQuery', () => undefined);
      try {
        const first = await service.status();
        const second = await service.status();
        assert.deepEqual(second, first);
        assert.equal(first.status, 'stale');
        assert.equal(first.itemCount, 2);
        assert.equal(first.pendingWork, 2);
        assert.equal(first.checkpoint, '50');
        assert.equal(first.refreshing, false);
        assert.equal(
          queries.mock.calls.length,
          8,
          'four database reads per enabled status evaluation, no status cache'
        );
        assert.ok(
          queries.mock.calls.every((call) =>
            /^\s*SELECT\b/i.test(call.arguments[0] ?? '')
          )
        );
        service.configure({ ...fixtureSettings, enabled: false });
        assert.equal((await service.status()).status, 'disabled');
        assert.equal(
          queries.mock.calls.length,
          8,
          'disabled status performs no database reads'
        );
      } finally {
        queries.mock.restore();
      }
      assert.deepEqual(await snapshot(), before);
    } finally {
      await database.destroy();
    }
  });
  it('persists content filters across settings reload without changing connection or visibility', async () => {
    const first = new Settings();
    first.fresh = {
      ...fixtureSettings,
      freshVisibilityDays: 90,
      excludeGenreIds: [16, 10762, 10766],
      excludeOriginalLanguages: ['hi'],
      minimumTmdbScore: 7,
      minimumTmdbVotes: 0,
    };
    await first.save();
    const restarted = new Settings();
    // This new fixture has no legacy migration ledger; exercise disk reload and
    // current normalization without invoking unrelated historical migrations.
    await restarted.load(undefined, true);
    assert.deepEqual(restarted.fresh, first.fresh);
    assert.equal(restarted.fresh.freshVisibilityDays, 90);
  });
  it('cannot bypass commissioning order by passing the completion flag', async () => {
    const database = await createFixtureDatabase();
    const service = new FreshService(
      {
        cancel: () => undefined,
        run: async () => {
          throw new Error('must not run');
        },
      },
      database,
      new SynchronizationPolicy('commissioning')
    );
    try {
      service.configure(fixtureSettings);
      assert.throws(() => service.sync(), /contained/);
      assert.throws(() => service.sync(true), /contained/);
    } finally {
      await database.destroy();
    }
  });
  it('joins concurrent sync callers and releases single-flight after completion', async () => {
    const database = await createFixtureDatabase();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const engine = {
      cancel: () => undefined,
      run: async () => {
        calls++;
        await gate;
        return {
          ingested: 0,
          examined: 0,
          resolved: 0,
          skipped: 0,
          retried: 0,
          backfillComplete: true,
          sourceFailed: false,
          cancelled: false,
        };
      },
    };
    try {
      const service = new FreshService(
        engine,
        database,
        new SynchronizationPolicy('normal')
      );
      service.configure(fixtureSettings);
      const first = service.sync();
      const second = service.sync();
      assert.equal(first, second);
      assert.equal(service.running(), true);
      release();
      await first;
      assert.equal(calls, 1);
      assert.equal(service.running(), false);
      await service.sync();
      assert.equal(calls, 2);
    } finally {
      await database.destroy();
    }
  });
  it('suppresses direct and startup sync in contained mode', async () => {
    const database = await createFixtureDatabase();
    let calls = 0;
    const service = new FreshService(
      {
        cancel: () => undefined,
        run: async () => {
          calls++;
          throw new Error('must not execute');
        },
      },
      database,
      new SynchronizationPolicy('contained')
    );
    try {
      service.configure(fixtureSettings);
      assert.throws(() => service.sync(), /contained/);
      service.startCatchUp();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 0);
    } finally {
      await database.destroy();
    }
  });
});
