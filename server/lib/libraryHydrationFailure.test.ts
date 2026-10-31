import {
  HydrationRunStatus,
  LibraryMediaType,
  SourceCheckpointStatus,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import {
  HydrationRun,
  SourceCheckpoint,
} from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import {
  LibraryHistoryHydrationService,
  type HydrationSourceSummary,
  type LibraryHydrationDependencies,
} from '@server/lib/libraryHistoryHydration';
import {
  LibraryHydrationRunCoordinator,
  LibraryHydrationRunOwnershipLostError,
} from '@server/lib/libraryHydrationRunCoordinator';
import logger from '@server/logger';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { EntityManager, QueryFailedError, type EntityTarget } from 'typeorm';

setupTestDb();

const now = () => new Date('2026-10-30T13:22:34Z');
const unexpected = () => {
  throw new Error('No provider calls permitted');
};
const dependencies: LibraryHydrationDependencies = {
  radarrServers: () => [],
  sonarrServers: () => [],
  jellyfinSettings: unexpected,
  createRadarrClient: unexpected,
  createSonarrClient: unexpected,
  createJellyfinContext: unexpected,
  createQueryMetadataClient: unexpected,
  now,
};
const localHydration = (
  coordinator = new LibraryHydrationRunCoordinator(dataSource, now)
) => {
  const service = new LibraryHistoryHydrationService(dependencies, coordinator);
  // Exercise the actual source entry point without invoking any other provider.
  return () =>
    (
      service as unknown as { hydrateSeerr(): Promise<HydrationSourceSummary> }
    ).hydrateSeerr();
};
const fixture = async () => {
  const media = await getRepository(Media).save(
    new Media({ tmdbId: 100, tvdbId: 200, mediaType: MediaType.MOVIE }),
    { listeners: false }
  );
  const canonical = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({ mediaType: LibraryMediaType.MOVIE })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: canonical.id,
      mediaType: LibraryMediaType.MOVIE,
      provider: 'tmdb',
      sourceScope: '',
      value: '100',
    })
  );
  return { media, canonical };
};
const failure = (code = 'SQLITE_CONSTRAINT') =>
  new QueryFailedError(
    'private SQL containing private-value',
    ['private token'],
    Object.assign(
      new Error(`${code}: FOREIGN KEY constraint failed: private-value`),
      { code }
    )
  );
const failRepository = (
  context: TestContext,
  target: EntityTarget<object>,
  method: string,
  error: Error
) => {
  const original = EntityManager.prototype.getRepository;
  context.mock.method(
    EntityManager.prototype,
    'getRepository',
    function (this: EntityManager, entity: EntityTarget<object>) {
      const repository = original.call(this, entity);
      if (entity !== target) return repository;
      return new Proxy(repository, {
        get(instance, key, receiver) {
          if (key === method)
            return async () => {
              throw error;
            };
          return Reflect.get(instance, key, receiver);
        },
      });
    }
  );
};
const recordedFailure = async (operation: string) => {
  const run = await getRepository(HydrationRun).findOneByOrFail({
    source: 'seerr',
  });
  assert.equal(run.status, HydrationRunStatus.FAILED);
  assert.equal(run.failureCode, 'QueryFailedError');
  assert.match(run.failureMessage!, new RegExp(`operation=${operation};`));
  assert.ok(run.failureMessage!.length <= 500);
  assert.doesNotMatch(run.failureMessage!, /private|token/);
  const checkpoint = await getRepository(SourceCheckpoint).findOneByOrFail({
    source: 'seerr',
  });
  assert.equal(checkpoint.status, SourceCheckpointStatus.FAILED);
  assert.equal(checkpoint.lastRunId, run.id);
  assert.equal(run.coverageEndedAt, null);
  assert.equal(run.leaseExpiresAt, null);
  return run;
};

describe('Library hydration failure recording', () => {
  for (const [operation, target, method] of [
    ['media-load', Media, 'find'],
    ['identity-lookup', CanonicalMediaIdentity, 'findOneBy'],
    ['canonical-lookup', CanonicalMedia, 'findOneByOrFail'],
    ['canonical-save', CanonicalMedia, 'save'],
    ['identity-insert', CanonicalMediaIdentity, 'save'],
  ] as const) {
    it(`attributes ${operation} and finalizes once without leaking the exception`, async (context) => {
      await fixture();
      const error = failure();
      failRepository(context, target, method, error);
      const log = context.mock.method(logger, 'error', () => undefined);
      const summary = await localHydration()();
      assert.equal(summary.complete, false);
      assert.equal(summary.failureCode, 'QueryFailedError');
      const run = await recordedFailure(operation);
      assert.equal(log.mock.callCount(), 1);
      assert.deepEqual((log.mock.calls[0].arguments as unknown[])[1], {
        label: 'Library History',
        source: 'seerr',
        runId: run.id,
        operation,
        sqliteCode: 'SQLITE_CONSTRAINT',
        constraintCategory: 'foreign-key',
      });
      assert.doesNotMatch(
        JSON.stringify(log.mock.calls[0].arguments),
        /private|token/
      );
      assert.match(error.message, /private-value/);
    });
  }

  it('attributes ownership locking without adding retries', async (context) => {
    await fixture();
    const coordinator = new LibraryHydrationRunCoordinator(dataSource, now);
    const original = coordinator.assertOwnership.bind(coordinator);
    let attempts = 0;
    context.mock.method(
      coordinator,
      'assertOwnership',
      (...args: Parameters<typeof original>) => {
        attempts++;
        if (attempts === 1) throw failure('SQLITE_LOCKED');
        return original(...args);
      }
    );
    const summary = await localHydration(coordinator)();
    assert.equal(summary.complete, false);
    const run = await recordedFailure('ownership-check');
    assert.match(run.failureMessage!, /sqlite=SQLITE_LOCKED/);
    assert.equal(attempts, 2); // One item check and the existing completion check.
  });

  it('attributes transaction begin failure without adding contention retries', async (context) => {
    await fixture();
    const original = dataSource.transaction.bind(dataSource);
    let attempts = 0;
    const transactions = context.mock.method(
      dataSource,
      'transaction',
      (...args: Parameters<typeof original>) => {
        attempts++;
        if (attempts === 2) throw failure('SQLITE_BUSY');
        return original(...args);
      }
    );
    await localHydration()();
    const run = await recordedFailure('transaction-begin');
    assert.match(run.failureMessage!, /sqlite=SQLITE_BUSY/);
    assert.equal(transactions.mock.callCount(), 3); // begin, item attempt, completion
  });

  it('persists an unknown-error fallback without changing its failureCode', async (context) => {
    await fixture();
    failRepository(
      context,
      CanonicalMedia,
      'save',
      new Error('private provider credentials')
    );
    const log = context.mock.method(logger, 'error', () => undefined);
    const summary = await localHydration()();
    assert.equal(summary.complete, false);
    const run = await getRepository(HydrationRun).findOneByOrFail({
      source: 'seerr',
    });
    assert.equal(run.failureCode, 'Error');
    assert.match(
      run.failureMessage!,
      /operation=canonical-save; sqlite=unknown; constraint=none/
    );
    assert.doesNotMatch(run.failureMessage!, /private|credentials/);
    assert.equal(log.mock.callCount(), 1);
  });

  it('attributes commit failure and retains the existing rollback semantics', async (context) => {
    const { canonical } = await fixture();
    const runner = dataSource.createQueryRunner();
    const original = runner.commitTransaction.bind(runner);
    let commits = 0;
    context.mock.method(runner, 'commitTransaction', async () => {
      commits++;
      if (commits === 2) throw failure('SQLITE_BUSY');
      return original();
    });
    await localHydration()();
    await recordedFailure('transaction-completion');
    assert.equal(
      (
        await getRepository(CanonicalMedia).findOneByOrFail({
          id: canonical.id,
        })
      ).currentMediaId,
      null
    );
    assert.equal(commits, 3);
  });

  it('records an actual SQLite FK failure after a snapshot Media row disappears', async (context) => {
    const { media } = await fixture();
    const repository = getRepository(Media);
    const original = repository.find.bind(repository);
    context.mock.method(
      repository,
      'find',
      async (...args: Parameters<typeof original>) => {
        const rows = await original(...args);
        await dataSource.query('DELETE FROM media WHERE id = ?', [media.id]);
        return rows;
      }
    );
    const result = await localHydration()();
    assert.equal(result.complete, false);
    const run = await recordedFailure('canonical-save');
    assert.match(
      run.failureMessage!,
      /sqlite=SQLITE_CONSTRAINT; constraint=foreign-key/
    );
    assert.deepEqual(await dataSource.query('PRAGMA foreign_key_check'), []);
  });

  it('finalizes the original failure even if structured logging throws', async (context) => {
    await fixture();
    const original = failure();
    failRepository(context, CanonicalMedia, 'save', original);
    context.mock.method(logger, 'error', () => {
      throw new Error('logging unavailable');
    });
    const summary = await localHydration()();
    assert.equal(summary.complete, false);
    await recordedFailure('canonical-save');
    assert.equal(original.constructor.name, 'QueryFailedError');
  });

  it('preserves successful finalization, transaction count and scalar linking', async (context) => {
    const { canonical, media } = await fixture();
    const original = dataSource.transaction.bind(dataSource);
    const transactions = context.mock.method(
      dataSource,
      'transaction',
      (...args: Parameters<typeof original>) => original(...args)
    );
    const log = context.mock.method(logger, 'error', () => undefined);
    const summary = await localHydration()();
    assert.equal(summary.complete, true);
    assert.equal(summary.mediaLinksResolved, 1);
    assert.equal(summary.aliasesCreated, 1);
    assert.equal(transactions.mock.callCount(), 3);
    assert.equal(log.mock.callCount(), 0);
    const run = await getRepository(HydrationRun).findOneByOrFail({
      source: 'seerr',
    });
    assert.equal(run.status, HydrationRunStatus.SUCCEEDED);
    assert.equal(run.failureCode, null);
    assert.equal(run.failureMessage, null);
    assert.equal(
      (
        await getRepository(CanonicalMedia).findOneByOrFail({
          id: canonical.id,
        })
      ).currentMediaId,
      media.id
    );
  });

  it('preserves stale-completion ownership handling', async (context) => {
    await fixture();
    const coordinator = new LibraryHydrationRunCoordinator(dataSource, now);
    context.mock.method(coordinator, 'complete', async () => {
      throw new LibraryHydrationRunOwnershipLostError(
        'fixture ownership changed'
      );
    });
    const summary = await localHydration(coordinator)();
    assert.equal(summary.complete, false);
    assert.equal(summary.failureCode, 'LibraryHydrationRunOwnershipLostError');
  });

  it('does not replace a run-finalization exception', async (context) => {
    const coordinator = new LibraryHydrationRunCoordinator(dataSource, now);
    const error = failure('SQLITE_IOERR');
    context.mock.method(coordinator, 'complete', async () => {
      throw error;
    });
    await assert.rejects(
      localHydration(coordinator)(),
      (actual) => actual === error
    );
  });
});
