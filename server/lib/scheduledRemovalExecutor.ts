import { LibraryRemovalSource } from '@server/constants/libraryHistory';
import {
  RemovalExecutionInitiator,
  RemovalExecutionState,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import dataSource from '@server/datasource';
import type { RemovalExecution } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import mediaRemoval, {
  MediaRemovalError,
  type RemovalResult,
  type RemovalTarget,
  type ResolvedRemovalTarget,
} from '@server/lib/mediaRemoval';
import removalExecutionCoordinator, {
  RemovalExecutionClaimConflictError,
  RemovalExecutionHeartbeat,
  RemovalExecutionOwnershipLostError,
  type RemovalExecutionOwnership,
} from '@server/lib/removalExecutionCoordinator';
import logger from '@server/logger';
import { In, type DataSource, type EntityManager } from 'typeorm';

const ACTIVE_STATUSES = [
  RemovalScheduleStatus.ACTIVE,
  RemovalScheduleStatus.DEFERRED,
];
const RETRY_DELAY_MS = 15 * 60_000;
const DEFAULT_HEARTBEAT_MS = 3 * 60_000;

export interface ScheduledRemovalGateway {
  resolveScheduledRemovalTarget(
    target: RemovalTarget
  ): Promise<ResolvedRemovalTarget>;
  prepareScheduledRemoval(
    target: RemovalTarget
  ): Promise<ResolvedRemovalTarget>;
  executeScheduledProviderRemoval(
    target: ResolvedRemovalTarget,
    assertOwnership: () => Promise<void>
  ): Promise<RemovalResult>;
  isScheduledProviderTargetAbsent(
    target: ResolvedRemovalTarget
  ): Promise<boolean>;
  reconcileResolvedRemoval(
    target: ResolvedRemovalTarget,
    manager: EntityManager
  ): Promise<void>;
  assertResolvedTargetSnapshot(
    manager: EntityManager,
    execution: RemovalExecution
  ): Promise<void>;
  reconcileSchedules(
    target: ResolvedRemovalTarget,
    manager: EntityManager
  ): Promise<number>;
}

export type ScheduledRemovalExecutionResult =
  | 'completed'
  | 'deferred'
  | 'failed'
  | 'skipped'
  | 'quarantined';

const errorDetails = (error: unknown) => ({
  code: error instanceof MediaRemovalError ? error.code : 'UNKNOWN',
  message: error instanceof Error ? error.message : 'Removal failed',
  retryable:
    error instanceof MediaRemovalError &&
    (error.retryable || error.code === 'ACTIVE_ACQUISITION'),
});

export class ScheduledRemovalExecutor {
  constructor(
    private readonly connection: DataSource = dataSource,
    private readonly gateway: ScheduledRemovalGateway = mediaRemoval,
    private readonly coordinator = removalExecutionCoordinator,
    private readonly now: () => Date = () => new Date(),
    private readonly heartbeatMs = DEFAULT_HEARTBEAT_MS
  ) {}

  private targetInput(schedule: RemovalSchedule): RemovalTarget {
    return {
      canonicalMediaId: schedule.canonicalMediaId,
      targetType: schedule.targetType,
      seasonNumber: schedule.seasonNumber ?? undefined,
      sourceScope: schedule.sourceScope,
      removalSource: LibraryRemovalSource.SCHEDULED,
    };
  }

  private async requireScheduleRevision(
    manager: EntityManager,
    schedule: RemovalSchedule
  ): Promise<RemovalSchedule> {
    const current = await manager.getRepository(RemovalSchedule).findOneBy({
      id: schedule.id,
      revision: schedule.revision,
    });
    if (
      !current ||
      !ACTIVE_STATUSES.includes(current.status) ||
      current.canonicalMediaId !== schedule.canonicalMediaId ||
      current.targetType !== schedule.targetType ||
      current.seasonNumber !== schedule.seasonNumber ||
      current.sourceSystem !== schedule.sourceSystem ||
      current.sourceScope !== schedule.sourceScope
    ) {
      throw new RemovalExecutionOwnershipLostError(
        'Scheduled removal revision is no longer actionable'
      );
    }
    const currentTime = this.now();
    if (
      current.leaseToken &&
      current.leaseUntil &&
      current.leaseUntil > currentTime
    ) {
      throw new RemovalExecutionOwnershipLostError(
        'A legacy scheduled-removal lease is still active'
      );
    }
    return current;
  }

  private async updateScheduleAfterPreProviderFailure(
    schedule: RemovalSchedule,
    error: unknown
  ): Promise<'deferred' | 'failed' | 'skipped'> {
    const details = errorDetails(error);
    const result = await this.connection
      .getRepository(RemovalSchedule)
      .createQueryBuilder()
      .update(RemovalSchedule)
      .set({
        status: details.retryable
          ? RemovalScheduleStatus.DEFERRED
          : RemovalScheduleStatus.FAILED,
        removeAt: details.retryable
          ? new Date(this.now().getTime() + RETRY_DELAY_MS)
          : schedule.removeAt,
        activeKey: details.retryable ? schedule.activeKey : null,
        failureCode: details.code,
        failureMessage: details.message,
        lastAttemptAt: this.now(),
        leaseToken: null,
        leaseUntil: null,
        revision: () => '"revision" + 1',
      })
      .where('id = :id', { id: schedule.id })
      .andWhere('revision = :revision', { revision: schedule.revision })
      .andWhere('status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .execute();
    if ((result.affected ?? 0) !== 1) return 'skipped';
    return details.retryable ? 'deferred' : 'failed';
  }

  private async completeSchedule(
    manager: EntityManager,
    schedule: RemovalSchedule,
    target: ResolvedRemovalTarget
  ): Promise<void> {
    await this.requireScheduleRevision(manager, schedule);
    await this.gateway.reconcileResolvedRemoval(target, manager);
    const schedules = await manager.getRepository(RemovalSchedule).find({
      where: {
        canonicalMediaId: schedule.canonicalMediaId,
        status: In(ACTIVE_STATUSES),
      },
      order: { id: 'ASC' },
    });
    const completed = schedules.filter(
      (candidate) =>
        candidate.id === schedule.id ||
        (schedule.targetType === RemovalTargetType.SERIES &&
          candidate.targetType === RemovalTargetType.SEASON)
    );
    for (const candidate of completed) {
      candidate.status = RemovalScheduleStatus.COMPLETED;
      candidate.completedAt = this.now();
      candidate.lastAttemptAt = this.now();
      candidate.activeKey = null;
      candidate.leaseToken = null;
      candidate.leaseUntil = null;
      candidate.failureCode = null;
      candidate.failureMessage = null;
      candidate.revision += 1;
    }
    await manager.getRepository(RemovalSchedule).save(completed);
  }

  public async execute(
    schedule: RemovalSchedule
  ): Promise<ScheduledRemovalExecutionResult> {
    let target: ResolvedRemovalTarget;
    try {
      target = await this.gateway.resolveScheduledRemovalTarget(
        this.targetInput(schedule)
      );
    } catch (error) {
      return this.updateScheduleAfterPreProviderFailure(schedule, error);
    }

    let ownership: RemovalExecutionOwnership;
    try {
      ownership = await this.coordinator.acquire(
        {
          canonicalMediaId: schedule.canonicalMediaId,
          targetType: schedule.targetType,
          seasonNumber: schedule.seasonNumber ?? undefined,
          initiator: RemovalExecutionInitiator.SCHEDULED,
          sourceSystem: target.sourceSystem,
          sourceScope: target.sourceScope,
          sourceItemId: target.sourceItemId,
          sourceGeneration: target.sourceGeneration,
          libraryPresenceId: target.libraryPresenceId,
          scheduleId: schedule.id,
          scheduleRevision: schedule.revision,
        },
        async (manager) => {
          const current = await this.requireScheduleRevision(manager, schedule);
          current.lastAttemptAt = this.now();
          await manager.getRepository(RemovalSchedule).save(current);
        }
      );
    } catch (error) {
      if (
        error instanceof RemovalExecutionClaimConflictError ||
        error instanceof RemovalExecutionOwnershipLostError
      ) {
        return 'skipped';
      }
      throw error;
    }

    const heartbeat = new RemovalExecutionHeartbeat(
      ownership,
      this.coordinator,
      this.heartbeatMs
    );
    let providerStarted = false;
    let providerOutcomeRecorded = false;
    try {
      target = await this.gateway.prepareScheduledRemoval(
        this.targetInput(schedule)
      );
      await heartbeat.assert();
      await this.coordinator.beginProvider(
        ownership,
        async (manager, execution) => {
          await this.requireScheduleRevision(manager, schedule);
          await this.gateway.assertResolvedTargetSnapshot(manager, execution);
        }
      );
      providerStarted = true;
      const result = await this.gateway.executeScheduledProviderRemoval(
        target,
        () => heartbeat.assert()
      );
      await heartbeat.assert();
      await heartbeat.stop();
      await this.coordinator.recordProviderOutcome(
        ownership,
        result.providerResult === 'removed' ? 'acknowledged' : 'absent'
      );
      providerOutcomeRecorded = true;
      await this.coordinator.complete(ownership, (manager) =>
        this.completeSchedule(manager, schedule, target)
      );
      return 'completed';
    } catch (error) {
      const details = errorDetails(error);
      if (!providerStarted) {
        try {
          await this.coordinator.endBeforeProvider(
            ownership,
            RemovalExecutionState.FAILED_PRE_PROVIDER,
            details.code,
            details.message
          );
        } catch {
          return 'skipped';
        }
        return this.updateScheduleAfterPreProviderFailure(schedule, error);
      }
      if (providerOutcomeRecorded) {
        await this.coordinator.requireReconciliationIfOwned(
          ownership,
          details.code,
          details.message
        );
      } else {
        await this.coordinator.quarantineProviderOutcomeIfOwned(
          ownership,
          details.code,
          details.message
        );
      }
      logger.error('Scheduled removal requires provider reconciliation', {
        label: 'Removal Scheduler',
        scheduleId: schedule.id,
        executionId: ownership.executionId,
        failureCode: details.code,
      });
      return 'quarantined';
    } finally {
      await heartbeat.stop();
    }
  }

  public async recover(): Promise<{ released: number; reconciled: number }> {
    const expired = await this.coordinator.recoverExpiredClaims();
    const executions = await this.coordinator.listReconciliationRequired();
    let reconciled = 0;
    for (const execution of executions) {
      let ownership: RemovalExecutionOwnership | undefined;
      try {
        ownership = await this.coordinator.acquireReconciliation(
          execution.canonicalMediaId
        );
        const schedule = execution.scheduleId
          ? await this.connection
              .getRepository(RemovalSchedule)
              .findOneBy({ id: execution.scheduleId })
          : null;
        if (
          execution.initiator === RemovalExecutionInitiator.SCHEDULED &&
          (!schedule || schedule.revision !== execution.scheduleRevision)
        ) {
          await this.coordinator.releaseReconciliation(ownership);
          continue;
        }
        const targetInput: RemovalTarget = schedule
          ? this.targetInput(schedule)
          : {
              canonicalMediaId: execution.canonicalMediaId,
              targetType: execution.targetType,
              seasonNumber: execution.seasonNumber ?? undefined,
              sourceScope: execution.sourceScope ?? undefined,
              removalSource: LibraryRemovalSource.MANUAL,
            };
        const target =
          await this.gateway.resolveScheduledRemovalTarget(targetInput);
        const absent =
          await this.gateway.isScheduledProviderTargetAbsent(target);
        if (!absent) {
          await this.coordinator.releaseReconciliation(ownership);
          continue;
        }
        await this.coordinator.confirmPhysicalAbsence(ownership);
        await this.coordinator.complete(ownership, async (manager) => {
          if (schedule) {
            await this.completeSchedule(manager, schedule, target);
          } else {
            await this.gateway.reconcileResolvedRemoval(target, manager);
            await this.gateway.reconcileSchedules(target, manager);
          }
        });
        reconciled += 1;
      } catch (error) {
        if (ownership) {
          try {
            await this.coordinator.releaseReconciliation(ownership);
          } catch {
            // A newer fence or recovery owner won; never force-release it.
          }
        }
        logger.warn('Scheduled removal reconciliation remains pending', {
          label: 'Removal Scheduler',
          executionId: execution.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { released: expired.released, reconciled };
  }
}
