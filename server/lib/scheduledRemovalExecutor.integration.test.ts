import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import {
  LibraryMediaType,
  LibraryRemovalSource,
} from '@server/constants/libraryHistory';
import {
  RemovalExecutionInitiator,
  RemovalExecutionState,
  RemovalScheduleOrigin,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import dataSource, { getRepository } from '@server/datasource';
import { CanonicalMedia, CanonicalSeason } from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import {
  RemovalExecution,
  RemovalExecutionClaim,
} from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import {
  RemovalExecutionCoordinator,
  RemovalExecutionOwnershipLostError,
} from '@server/lib/removalExecutionCoordinator';
import {
  RemovalScheduleConflictError,
  clearAllScheduledRemovalRecords,
} from '@server/lib/removalScheduler';
import {
  ScheduledRemovalExecutor,
  type ScheduledRemovalGateway,
} from '@server/lib/scheduledRemovalExecutor';
import { setupTestDb } from '@server/test/db';
import { In } from 'typeorm';

setupTestDb();

const now = new Date('2026-10-11T12:00:00.000Z');
let media: CanonicalMedia;
let presence: LibraryPresence;
let schedule: RemovalSchedule;

beforeEach(async () => {
  media = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: 'Scheduled execution fixture',
    })
  );
  presence = await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: media.id,
      sourceSystem: 'radarr',
      sourceScope: 'service:0',
      sourceItemId: 'movie:42',
      sourceGeneration: 'fixture-generation',
      firstObservedAt: now,
      isCurrent: true,
      servarrHasFile: true,
    })
  );
  schedule = await getRepository(RemovalSchedule).save(
    new RemovalSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
      sourceScope: 'service:0',
      origin: RemovalScheduleOrigin.MANUAL,
      status: RemovalScheduleStatus.ACTIVE,
      activeKey: `service:0:${media.id}:movie:-`,
      scheduledAt: new Date('2026-10-01T00:00:00.000Z'),
      removeAt: new Date('2026-10-10T00:00:00.000Z'),
    })
  );
});

const target = () =>
  ({
    canonicalMedia: media,
    canonicalMediaId: media.id,
    targetType: RemovalTargetType.MOVIE,
    sourceSystem: 'radarr' as const,
    sourceScope: 'service:0',
    service: { id: 0 },
    is4k: false,
    externalServiceId: 42,
    libraryPresenceId: presence.id,
    sourceItemId: presence.sourceItemId,
    sourceGeneration: presence.sourceGeneration,
    removalSource: LibraryRemovalSource.SCHEDULED,
  }) as Awaited<ReturnType<ScheduledRemovalGateway['prepareScheduledRemoval']>>;

const gateway = (
  overrides: Partial<ScheduledRemovalGateway> = {}
): ScheduledRemovalGateway => ({
  resolveScheduledRemovalTarget: async () => target(),
  prepareScheduledRemoval: async () => target(),
  executeScheduledProviderRemoval: async (_target, assertOwnership) => {
    await assertOwnership();
    return {
      targetType: RemovalTargetType.MOVIE,
      providerResult: 'removed',
    };
  },
  isScheduledProviderTargetAbsent: async () => false,
  reconcileResolvedRemoval: async () => undefined,
  assertResolvedTargetSnapshot: async () => undefined,
  reconcileSchedules: async () => 0,
  ...overrides,
});

describe('ScheduledRemovalExecutor durable coordination', () => {
  it('fences provider execution and atomically completes its schedule', async () => {
    const provider = mock.fn(async (_target, assertOwnership) => {
      await assertOwnership();
      return {
        targetType: RemovalTargetType.MOVIE,
        providerResult: 'removed' as const,
      };
    });
    const executor = new ScheduledRemovalExecutor(
      dataSource,
      gateway({ executeScheduledProviderRemoval: provider }),
      new RemovalExecutionCoordinator(dataSource, () => now),
      () => now
    );

    assert.equal(await executor.execute(schedule), 'completed');
    assert.equal(provider.mock.callCount(), 1);
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: schedule.id,
        })
      ).status,
      RemovalScheduleStatus.COMPLETED
    );
    const execution = await getRepository(RemovalExecution).findOneByOrFail({
      scheduleId: schedule.id,
    });
    assert.equal(execution.state, RemovalExecutionState.COMPLETED);
    assert.equal(execution.providerOutcome, 'acknowledged');
    assert.equal(execution.physicalAbsenceConfirmedAt, null);
    assert.equal(
      (
        await getRepository(RemovalExecutionClaim).findOneByOrFail({
          canonicalMediaId: media.id,
        })
      ).executionId,
      null
    );
  });

  it('revalidates authoritative Season files at the provider boundary', async () => {
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Season boundary fixture',
      })
    );
    const seriesPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceItemId: 'series:84',
        sourceGeneration: 'series-generation',
        firstObservedAt: now,
        isCurrent: true,
        servarrHasFile: true,
      })
    );
    await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
    );
    const seasonSchedule = await getRepository(RemovalSchedule).save(
      new RemovalSchedule({
        canonicalMediaId: series.id,
        targetType: RemovalTargetType.SEASON,
        seasonNumber: 1,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        origin: RemovalScheduleOrigin.MANUAL,
        status: RemovalScheduleStatus.ACTIVE,
        activeKey: `service:0:${series.id}:season:1`,
        scheduledAt: new Date('2026-10-01T00:00:00.000Z'),
        removeAt: new Date('2026-10-10T00:00:00.000Z'),
      })
    );
    const seasonTarget = {
      canonicalMedia: series,
      canonicalMediaId: series.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 1,
      sourceSystem: 'sonarr' as const,
      sourceScope: 'service:0',
      service: { id: 0 },
      is4k: false,
      externalServiceId: 84,
      libraryPresenceId: seriesPresence.id,
      sourceItemId: seriesPresence.sourceItemId,
      sourceGeneration: seriesPresence.sourceGeneration,
      removalSource: LibraryRemovalSource.SCHEDULED,
    } as Awaited<
      ReturnType<ScheduledRemovalGateway['prepareScheduledRemoval']>
    >;
    const provider = mock.fn(async () => ({
      targetType: RemovalTargetType.SEASON,
      providerResult: 'removed' as const,
    }));
    const executor = new ScheduledRemovalExecutor(
      dataSource,
      gateway({
        resolveScheduledRemovalTarget: async () => seasonTarget,
        prepareScheduledRemoval: async () => seasonTarget,
        executeScheduledProviderRemoval: provider,
        assertResolvedTargetSnapshot: async () => {
          throw new RemovalExecutionOwnershipLostError(
            'Authoritative Season files changed before provider execution'
          );
        },
      }),
      new RemovalExecutionCoordinator(dataSource, () => now),
      () => now
    );

    assert.equal(await executor.execute(seasonSchedule), 'failed');
    assert.equal(provider.mock.callCount(), 0);
    assert.equal(
      (
        await getRepository(RemovalExecution).findOneByOrFail({
          scheduleId: seasonSchedule.id,
        })
      ).state,
      RemovalExecutionState.FAILED_PRE_PROVIDER
    );
  });

  it('allows only one scheduled worker to command a canonical target', async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const provider = mock.fn(async (_target, assertOwnership) => {
      await assertOwnership();
      providerStarted();
      await providerGate;
      return {
        targetType: RemovalTargetType.MOVIE,
        providerResult: 'removed' as const,
      };
    });
    const first = new ScheduledRemovalExecutor(
      dataSource,
      gateway({ executeScheduledProviderRemoval: provider }),
      new RemovalExecutionCoordinator(dataSource, () => now),
      () => now
    );
    const second = new ScheduledRemovalExecutor(
      dataSource,
      gateway({ executeScheduledProviderRemoval: provider }),
      new RemovalExecutionCoordinator(dataSource, () => now),
      () => now
    );

    const firstRun = first.execute(schedule);
    await started;
    assert.equal(await second.execute(schedule), 'skipped');
    releaseProvider();
    assert.equal(await firstRun, 'completed');
    assert.equal(provider.mock.callCount(), 1);
  });

  it('rejects Clear All atomically while a durable claim is provider-bound', async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const executor = new ScheduledRemovalExecutor(
      dataSource,
      gateway({
        executeScheduledProviderRemoval: async (_target, assertOwnership) => {
          await assertOwnership();
          providerStarted();
          await providerGate;
          return {
            targetType: RemovalTargetType.MOVIE,
            providerResult: 'removed',
          };
        },
      }),
      new RemovalExecutionCoordinator(dataSource, () => now),
      () => now
    );

    const execution = executor.execute(schedule);
    await started;
    await assert.rejects(
      () => clearAllScheduledRemovalRecords(dataSource, now),
      RemovalScheduleConflictError
    );
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: schedule.id,
        })
      ).status,
      RemovalScheduleStatus.ACTIVE
    );
    releaseProvider();
    assert.equal(await execution, 'completed');
  });

  it('quarantines an ambiguous provider error and never retries the command', async () => {
    const provider = mock.fn(async (_target, assertOwnership) => {
      await assertOwnership();
      throw new Error('provider timeout');
    });
    const executor = new ScheduledRemovalExecutor(
      dataSource,
      gateway({ executeScheduledProviderRemoval: provider }),
      new RemovalExecutionCoordinator(dataSource, () => now),
      () => now
    );

    assert.equal(await executor.execute(schedule), 'quarantined');
    assert.equal(await executor.execute(schedule), 'skipped');
    assert.equal(provider.mock.callCount(), 1);
    const storedExecution = await getRepository(
      RemovalExecution
    ).findOneByOrFail({
      scheduleId: schedule.id,
    });
    assert.equal(storedExecution.state, RemovalExecutionState.UNCERTAIN);
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: schedule.id,
        })
      ).status,
      RemovalScheduleStatus.ACTIVE
    );
  });

  it('recovers an uncertain outcome only after read-only provider absence', async () => {
    const provider = mock.fn(async () => {
      throw new Error('connection reset after request');
    });
    const coordinator = new RemovalExecutionCoordinator(dataSource, () => now);
    const first = new ScheduledRemovalExecutor(
      dataSource,
      gateway({ executeScheduledProviderRemoval: provider }),
      coordinator,
      () => now
    );
    assert.equal(await first.execute(schedule), 'quarantined');

    const absenceCheck = mock.fn(async () => true);
    const recovery = new ScheduledRemovalExecutor(
      dataSource,
      gateway({ isScheduledProviderTargetAbsent: absenceCheck }),
      coordinator,
      () => now
    );
    assert.deepEqual(await recovery.recover(), { released: 0, reconciled: 1 });
    assert.equal(absenceCheck.mock.callCount(), 1);
    assert.equal(provider.mock.callCount(), 1);
    const execution = await getRepository(RemovalExecution).findOneByOrFail({
      scheduleId: schedule.id,
    });
    assert.equal(execution.state, RemovalExecutionState.COMPLETED);
    assert.equal(execution.providerOutcome, 'absent');
    assert.deepEqual(execution.physicalAbsenceConfirmedAt, now);
  });

  it('retains provider acknowledgment when local reconciliation fails', async () => {
    const reconcile = mock.fn(async () => {
      throw new Error('local transaction failed');
    });
    const coordinator = new RemovalExecutionCoordinator(dataSource, () => now);
    const first = new ScheduledRemovalExecutor(
      dataSource,
      gateway({ reconcileResolvedRemoval: reconcile }),
      coordinator,
      () => now
    );

    assert.equal(await first.execute(schedule), 'quarantined');
    let execution = await getRepository(RemovalExecution).findOneByOrFail({
      scheduleId: schedule.id,
    });
    assert.equal(
      execution.state,
      RemovalExecutionState.RECONCILIATION_REQUIRED
    );
    assert.equal(execution.providerOutcome, 'acknowledged');

    const recovery = new ScheduledRemovalExecutor(
      dataSource,
      gateway({ isScheduledProviderTargetAbsent: async () => true }),
      coordinator,
      () => now
    );
    assert.deepEqual(await recovery.recover(), { released: 0, reconciled: 1 });
    execution = await getRepository(RemovalExecution).findOneByOrFail({
      scheduleId: schedule.id,
    });
    assert.equal(execution.state, RemovalExecutionState.COMPLETED);
    assert.equal(execution.providerOutcome, 'acknowledged');
    assert.deepEqual(execution.physicalAbsenceConfirmedAt, now);
  });

  it('recovers a restarted manual execution by read-only absence without repeating removal', async () => {
    const coordinator = new RemovalExecutionCoordinator(dataSource, () => now);
    const ownership = await coordinator.acquire({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      initiator: RemovalExecutionInitiator.MANUAL,
      sourceSystem: 'radarr',
      sourceScope: presence.sourceScope,
      sourceItemId: presence.sourceItemId,
      sourceGeneration: presence.sourceGeneration,
      libraryPresenceId: presence.id,
    });
    await coordinator.beginProvider(ownership);
    await coordinator.quarantineProviderOutcomeIfOwned(
      ownership,
      'PROCESS_EXIT',
      'Worker exited after entering the provider boundary'
    );

    const absence = mock.fn(async () => true);
    const reconcile = mock.fn(async () => undefined);
    const reconcileSchedules = mock.fn(async () => 0);
    const recovery = new ScheduledRemovalExecutor(
      dataSource,
      gateway({
        isScheduledProviderTargetAbsent: absence,
        reconcileResolvedRemoval: reconcile,
        reconcileSchedules,
      }),
      coordinator,
      () => now
    );

    assert.deepEqual(await recovery.recover(), { released: 0, reconciled: 1 });
    assert.equal(absence.mock.callCount(), 1);
    assert.equal(reconcile.mock.callCount(), 1);
    assert.equal(reconcileSchedules.mock.callCount(), 1);
    const execution = await getRepository(RemovalExecution).findOneByOrFail({
      id: ownership.executionId,
    });
    assert.equal(execution.state, RemovalExecutionState.COMPLETED);
    assert.deepEqual(execution.physicalAbsenceConfirmedAt, now);
  });

  it('cannot overwrite a newer schedule revision from a stale completion', async () => {
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const executor = new ScheduledRemovalExecutor(
      dataSource,
      gateway({
        executeScheduledProviderRemoval: async (_target, assertOwnership) => {
          await assertOwnership();
          providerStarted();
          await providerGate;
          return {
            targetType: RemovalTargetType.MOVIE,
            providerResult: 'removed',
          };
        },
      }),
      new RemovalExecutionCoordinator(dataSource, () => now),
      () => now
    );
    const run = executor.execute(schedule);
    await started;
    await getRepository(RemovalSchedule)
      .createQueryBuilder()
      .update(RemovalSchedule)
      .set({
        status: RemovalScheduleStatus.CANCELLED,
        activeKey: null,
        revision: () => '"revision" + 1',
      })
      .where('id = :id', { id: schedule.id })
      .execute();
    releaseProvider();

    assert.equal(await run, 'quarantined');
    const stored = await getRepository(RemovalSchedule).findOneByOrFail({
      id: schedule.id,
    });
    assert.equal(stored.status, RemovalScheduleStatus.CANCELLED);
    assert.equal(stored.revision, schedule.revision + 1);
    assert.equal(
      (
        await getRepository(RemovalExecution).findOneByOrFail({
          scheduleId: schedule.id,
        })
      ).state,
      RemovalExecutionState.RECONCILIATION_REQUIRED
    );
  });

  it('quarantines an owner whose lease expires between Season-like steps', async () => {
    let clock = now.getTime();
    const current = () => new Date(clock);
    const coordinator = new RemovalExecutionCoordinator(
      dataSource,
      current,
      1_000
    );
    const executor = new ScheduledRemovalExecutor(
      dataSource,
      gateway({
        executeScheduledProviderRemoval: async (_target, assertOwnership) => {
          await assertOwnership();
          clock += 1_001;
          await assertOwnership();
          return {
            targetType: RemovalTargetType.MOVIE,
            providerResult: 'removed',
          };
        },
      }),
      coordinator,
      current,
      60_000
    );

    assert.equal(await executor.execute(schedule), 'quarantined');
    assert.equal(
      (
        await getRepository(RemovalExecution).findOneByOrFail({
          scheduleId: schedule.id,
        })
      ).state,
      RemovalExecutionState.UNCERTAIN
    );
  });

  it('stops provider work after heartbeat renewal fails', async () => {
    const coordinator = new RemovalExecutionCoordinator(
      dataSource,
      () => now,
      10_000
    );
    const renew = coordinator.renew.bind(coordinator);
    let providerStarted = false;
    mock.method(
      coordinator,
      'renew',
      async (ownership: Parameters<typeof renew>[0]) => {
        if (providerStarted) throw new Error('heartbeat database failure');
        return renew(ownership);
      }
    );
    const executor = new ScheduledRemovalExecutor(
      dataSource,
      gateway({
        executeScheduledProviderRemoval: async (_target, assertOwnership) => {
          await assertOwnership();
          providerStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 100));
          await assertOwnership();
          return {
            targetType: RemovalTargetType.MOVIE,
            providerResult: 'removed',
          };
        },
      }),
      coordinator,
      () => now,
      20
    );

    assert.equal(await executor.execute(schedule), 'quarantined');
    assert.equal(
      (
        await getRepository(RemovalExecution).findOneByOrFail({
          scheduleId: schedule.id,
        })
      ).state,
      RemovalExecutionState.UNCERTAIN
    );
  });

  it('renews a live lease while a provider operation remains active', async () => {
    let clock = now.getTime();
    const current = () => new Date(clock);
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const coordinator = new RemovalExecutionCoordinator(
      dataSource,
      current,
      500
    );
    const executor = new ScheduledRemovalExecutor(
      dataSource,
      gateway({
        executeScheduledProviderRemoval: async (_target, assertOwnership) => {
          await assertOwnership();
          providerStarted();
          await providerGate;
          await assertOwnership();
          return {
            targetType: RemovalTargetType.MOVIE,
            providerResult: 'removed',
          };
        },
      }),
      coordinator,
      current,
      25
    );

    const run = executor.execute(schedule);
    await started;
    const initialLeaseUntil = clock + 500;
    clock += 400;
    let renewed = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const claim = await getRepository(RemovalExecutionClaim).findOneByOrFail({
        canonicalMediaId: media.id,
      });
      if (claim.leaseUntil && claim.leaseUntil.getTime() > initialLeaseUntil) {
        renewed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(renewed, true);
    clock += 400;
    releaseProvider();
    const outcome = await run;
    const debugExecution = await getRepository(RemovalExecution).findOneBy({
      scheduleId: schedule.id,
    });
    assert.equal(outcome, 'completed', debugExecution?.failureMessage ?? '');
    assert.equal(
      (
        await getRepository(RemovalExecution).findOneByOrFail({
          scheduleId: schedule.id,
        })
      ).state,
      RemovalExecutionState.COMPLETED
    );
  });

  it('rejects Clear All without changing any schedule when a legacy lease is live', async () => {
    schedule.leaseToken = 'legacy-worker';
    schedule.leaseUntil = new Date(now.getTime() + 60_000);
    await getRepository(RemovalSchedule).save(schedule);
    const secondMedia = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Second clear fixture',
      })
    );
    const second = await getRepository(RemovalSchedule).save(
      new RemovalSchedule({
        canonicalMediaId: secondMedia.id,
        targetType: RemovalTargetType.MOVIE,
        sourceSystem: 'radarr',
        sourceScope: 'service:0',
        origin: RemovalScheduleOrigin.MANUAL,
        status: RemovalScheduleStatus.ACTIVE,
        activeKey: `service:0:${secondMedia.id}:movie:-`,
        scheduledAt: now,
        removeAt: now,
      })
    );

    await assert.rejects(
      () => clearAllScheduledRemovalRecords(dataSource, now),
      RemovalScheduleConflictError
    );
    assert.deepEqual(
      (
        await getRepository(RemovalSchedule).find({
          where: { id: In([schedule.id, second.id]) },
          order: { id: 'ASC' },
        })
      ).map(({ status }) => status),
      [RemovalScheduleStatus.ACTIVE, RemovalScheduleStatus.ACTIVE]
    );
  });
});
