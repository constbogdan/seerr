import type { AutobrrFilterOption } from '@server/api/autobrr';
import { FreshContinuityStatus } from '@server/constants/fresh';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshMedia from '@server/entity/FreshMedia';
import FreshObservation from '@server/entity/FreshObservation';
import { FreshSyncState } from '@server/entity/FreshSyncState';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { Watchlist } from '@server/entity/Watchlist';
import type { FreshDiagnosticsSnapshot } from '@server/lib/fresh';
import {
  FreshService,
  normalizeFreshSettings,
  publicFreshSettings,
  type FreshServiceDependencies,
} from '@server/lib/fresh/service';
import type { FreshSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const settings: FreshSettings = {
  enabled: true,
  baseUrl: 'https://autobrr.test/api/',
  apiToken: 'fixture-token',
  filterId: 7,
  cachedFilterName: 'Fresh Movies & TV',
  mediaEligibilityDays: 90,
  freshVisibilityDays: 7,
  includeGenreIds: [],
  excludeGenreIds: [],
  includeOriginalLanguages: [],
  excludeOriginalLanguages: [],
  includeContentRatings: [],
  excludeContentRatings: [],
  minimumTmdbScore: 0,
  minimumTmdbVotes: 0,
};

const diagnostics: FreshDiagnosticsSnapshot = {
  operation: 'sync',
  outcome: 'succeeded',
  startedAt: '2026-09-26T10:00:00.000Z',
  completedAt: '2026-09-26T10:00:01.000Z',
  stages: {
    configuration: 'succeeded',
    filter_authentication: 'succeeded',
    source_history: 'succeeded',
    observation_persistence: 'succeeded',
    checkpoint_commit: 'succeeded',
    resolution_search: 'succeeded',
    projection_update: 'succeeded',
    retention: 'succeeded',
    reconciliation: 'not_started',
  },
  counts: {
    newAutobrrReleases: 0,
    persistedObservations: 0,
    replayedObservations: 0,
    uniqueCandidates: 0,
    alreadyResolved: 0,
    resolutionAttempts: 0,
    resolved: 0,
    noMatch: 0,
    ambiguous: 0,
    transientFailures: 0,
    outsideFreshWindow: 0,
    newFreshMedia: 0,
    existingFreshMediaUpdated: 0,
    expiredFreshMedia: 0,
    currentFreshMedia: 0,
  },
  decisions: [],
  checkpoint: {},
};

function fixture() {
  let runs = 0;
  let resolveRun: (() => void) | undefined;
  const filters: AutobrrFilterOption[] = [
    { id: 7, name: 'Fresh Movies & TV', enabled: true },
  ];
  const deps = {
    engine: {
      run: async () => {
        runs++;
        await new Promise<void>((resolve) => (resolveRun = resolve));
        return { diagnostics };
      },
      cancel: () => undefined,
    },
    database: {
      getRepository: () => ({
        findOneBy: async () => undefined,
        countBy: async () => 0,
      }),
    } as unknown as FreshServiceDependencies['database'],
    createAutobrr: () => ({ filters: async () => filters }),
    now: () => new Date('2026-09-26T10:00:00.000Z'),
  } satisfies FreshServiceDependencies;
  return {
    deps,
    filters,
    runs: () => runs,
    complete: () => resolveRun?.(),
  };
}

describe('Fresh application service', () => {
  it('normalizes settings and never exposes the API token', () => {
    const normalized = normalizeFreshSettings(settings);
    assert.equal(normalized.baseUrl, 'https://autobrr.test');
    assert.deepEqual(publicFreshSettings(normalized), {
      enabled: true,
      baseUrl: 'https://autobrr.test',
      filterId: 7,
      cachedFilterName: 'Fresh Movies & TV',
      mediaEligibilityDays: 90,
      freshVisibilityDays: 7,
      includeGenreIds: [],
      excludeGenreIds: [],
      includeOriginalLanguages: [],
      excludeOriginalLanguages: [],
      includeContentRatings: [],
      excludeContentRatings: [],
      minimumTmdbScore: 0,
      minimumTmdbVotes: 0,
      apiTokenConfigured: true,
    });
    assert.doesNotMatch(
      JSON.stringify(publicFreshSettings(normalized)),
      /fixture/
    );
    assert.throws(() =>
      normalizeFreshSettings({ ...settings, apiToken: 'bad\nheader' })
    );
    assert.throws(() =>
      normalizeFreshSettings({ ...settings, mediaEligibilityDays: 366 })
    );
  });

  it('does no synchronization work when disabled', async () => {
    const f = fixture();
    const service = new FreshService(f.deps);
    service.configure({
      ...settings,
      enabled: false,
      baseUrl: '',
      apiToken: '',
      filterId: 0,
    });
    await service.sync();
    assert.equal(f.runs(), 0);
    assert.equal((await service.status()).status, 'disabled');
  });

  it('joins concurrent manual and scheduled synchronization', async () => {
    const f = fixture();
    const service = new FreshService(f.deps);
    service.configure(settings);
    const first = service.sync();
    const second = service.sync();
    assert.equal(f.runs(), 1);
    assert.equal(service.running(), true);
    f.complete();
    await Promise.all([first, second]);
    assert.equal(service.running(), false);
  });

  it('serializes administrator mutations behind an active synchronization', async () => {
    const events: string[] = [];
    let finishSync: (() => void) | undefined;
    const service = new FreshService({
      ...fixture().deps,
      engine: {
        cancel: () => undefined,
        run: async () => {
          events.push('sync:start');
          await new Promise<void>((resolve) => {
            finishSync = resolve;
          });
          events.push('sync:end');
          return { diagnostics };
        },
        resolveManually: async () => {
          events.push('manual');
          return {
            candidate: new FreshCandidate({ id: 1 }),
            media: new FreshMedia({ mediaType: 'tv', tmdbId: 305251 }),
          };
        },
      },
    });
    service.configure(settings);

    const synchronization = service.sync();
    const mutation = service.resolveCandidate(1, 'tv', 305251, 7, 42);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ['sync:start']);
    finishSync?.();
    await Promise.all([synchronization, mutation]);
    assert.deepEqual(events, ['sync:start', 'sync:end', 'manual']);
  });

  it('returns sanitized browser-safe filter options', async () => {
    const f = fixture();
    const service = new FreshService(f.deps);
    service.configure(settings);
    assert.deepEqual(await service.filters(), f.filters);
  });

  it('reevaluates persisted membership without running source synchronization', async () => {
    const f = fixture();
    let reevaluations = 0;
    const service = new FreshService({
      ...f.deps,
      engine: {
        ...f.deps.engine,
        reevaluate: async () => {
          reevaluations++;
          return 12;
        },
      },
    });
    service.configure(settings);
    await service.reevaluate();
    assert.equal(reevaluations, 1);
    assert.equal(f.runs(), 0);
  });

  it('rebuilds only Fresh-owned state before using the normal initial sync path', async () => {
    const cleared: unknown[] = [];
    let synchronizedSettings: FreshSettings | undefined;
    let reconcile: boolean | undefined;
    const service = new FreshService({
      ...fixture().deps,
      database: {
        getRepository: (entity: unknown) =>
          entity === FreshSyncState
            ? { findOneBy: async () => undefined }
            : { countBy: async () => 0 },
        transaction: async (work: (manager: unknown) => Promise<void>) =>
          work({
            getRepository: (entity: unknown) => ({
              createQueryBuilder: () => ({
                delete: () => ({
                  execute: async () => {
                    cleared.push(entity);
                  },
                }),
              }),
            }),
          }),
      } as unknown as FreshServiceDependencies['database'],
      engine: {
        cancel: () => undefined,
        run: async (receivedSettings, receivedReconcile) => {
          synchronizedSettings = receivedSettings;
          reconcile = receivedReconcile;
          assert.deepEqual(cleared, [
            FreshObservation,
            FreshCandidate,
            FreshSyncState,
          ]);
          return { diagnostics };
        },
      },
    });
    service.configure(settings);

    await service.rebuild();

    assert.deepEqual(cleared, [
      FreshObservation,
      FreshCandidate,
      FreshSyncState,
    ]);
    assert.equal((cleared as unknown[]).includes(Media), false);
    assert.equal((cleared as unknown[]).includes(Watchlist), false);
    assert.equal((cleared as unknown[]).includes(MediaRequest), false);
    assert.deepEqual(synchronizedSettings, {
      ...settings,
      baseUrl: 'https://autobrr.test',
    });
    assert.equal(synchronizedSettings?.apiToken, 'fixture-token');
    assert.equal(synchronizedSettings?.filterId, 7);
    assert.equal(reconcile, false);
  });

  it('coalesces concurrent rebuild and sync requests at the Fresh coordinator', async () => {
    let transactions = 0;
    let runs = 0;
    let finish:
      | ((value: { diagnostics: FreshDiagnosticsSnapshot }) => void)
      | undefined;
    const service = new FreshService({
      ...fixture().deps,
      database: {
        getRepository: (entity: unknown) =>
          entity === FreshSyncState
            ? { findOneBy: async () => undefined }
            : { countBy: async () => 0 },
        transaction: async (work: (manager: unknown) => Promise<void>) => {
          transactions++;
          return work({
            getRepository: () => ({
              createQueryBuilder: () => ({
                delete: () => ({ execute: async () => undefined }),
              }),
            }),
          });
        },
      } as unknown as FreshServiceDependencies['database'],
      engine: {
        cancel: () => undefined,
        run: async () => {
          runs++;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    service.configure(settings);

    const rebuild = service.rebuild();
    await new Promise((resolve) => setImmediate(resolve));
    const joinedSync = service.sync();
    const joinedRebuild = service.rebuild();
    assert.equal(transactions, 1);
    assert.equal(runs, 1);
    assert.equal((await service.status()).status, 'rebuilding');
    finish?.({ diagnostics });
    await Promise.all([rebuild, joinedSync, joinedRebuild]);
    assert.equal(transactions, 1);
    assert.equal(runs, 1);
  });

  it('fails rebuild truthfully when the normal initial sync fails', async () => {
    const failedDiagnostics: FreshDiagnosticsSnapshot = {
      ...diagnostics,
      outcome: 'failed',
      failingStage: 'source_history',
      failureReason: 'source_unavailable',
    };
    const service = new FreshService({
      ...fixture().deps,
      database: {
        getRepository: (entity: unknown) =>
          entity === FreshSyncState
            ? { findOneBy: async () => undefined }
            : { countBy: async () => 0 },
        transaction: async (work: (manager: unknown) => Promise<void>) =>
          work({
            getRepository: () => ({
              createQueryBuilder: () => ({
                delete: () => ({ execute: async () => undefined }),
              }),
            }),
          }),
      } as unknown as FreshServiceDependencies['database'],
      engine: {
        cancel: () => undefined,
        run: async () => ({ diagnostics: failedDiagnostics }),
      },
    });
    service.configure(settings);

    await assert.rejects(() => service.rebuild(), /fresh_rebuild_failed/);
    const result = await service.diagnostics();
    assert.equal(result.latestAttempt?.outcome, 'failed');
    assert.equal(result.latestAttempt?.failureReason, 'source_unavailable');
    assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
  });

  it('does not start initial sync when the transactional reset fails', async () => {
    let runs = 0;
    const service = new FreshService({
      ...fixture().deps,
      database: {
        getRepository: (entity: unknown) =>
          entity === FreshSyncState
            ? { findOneBy: async () => undefined }
            : { countBy: async () => 0 },
        transaction: async () => {
          throw new Error('database reset failed with private provider detail');
        },
      } as unknown as FreshServiceDependencies['database'],
      engine: {
        cancel: () => undefined,
        run: async () => {
          runs++;
          return { diagnostics };
        },
      },
    });
    service.configure(settings);

    await assert.rejects(() => service.rebuild(), /database reset failed/);
    assert.equal(runs, 0);
    assert.equal(service.running(), false);
  });

  it('returns defensive copies of bounded in-memory diagnostics', async () => {
    const f = fixture();
    const service = new FreshService(f.deps);
    service.configure(settings);
    const run = service.sync();
    f.complete();
    await run;
    const first = await service.diagnostics();
    first.latestAttempt?.decisions.push({
      title: 'mutated client copy',
      mediaType: 'movie',
      normalizedTitle: 'mutated',
      stage: 'configuration',
      outcome: 'rejected',
      reason: 'client_mutation',
    });
    const second = await service.diagnostics();
    assert.equal(second.latestAttempt?.decisions.length, 0);
  });

  it('returns persistent pipeline state when no in-memory attempt exists', async () => {
    const f = fixture();
    const persistentState = new FreshSyncState({
      checkpointReleaseId: '4084',
      continuityStatus: FreshContinuityStatus.CURRENT,
      lastSuccessfulSyncAt: new Date('2026-09-26T10:00:00.000Z'),
      lastSuccessfulReconciliationAt: new Date('2026-09-26T03:15:00.000Z'),
    });
    const service = new FreshService({
      ...f.deps,
      database: {
        getRepository: (entity: unknown) =>
          entity === FreshSyncState
            ? { findOneBy: async () => persistentState }
            : entity === FreshMedia
              ? { countBy: async () => 194 }
              : {},
      } as unknown as FreshServiceDependencies['database'],
    });
    service.configure(settings);

    const result = await service.diagnostics();
    assert.equal(result.latestAttempt, null);
    assert.deepEqual(result.currentProjection, {
      status: 'ready',
      refreshing: false,
      lastRefresh: '2026-09-26T10:00:00.000Z',
      lastReconciliation: '2026-09-26T03:15:00.000Z',
      checkpoint: '4084',
      itemCount: 194,
      continuityStatus: FreshContinuityStatus.CURRENT,
      error: undefined,
    });
  });
});
