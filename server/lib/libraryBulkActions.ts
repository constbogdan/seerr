import {
  LibraryMediaType,
  LibraryRemovalSource,
} from '@server/constants/libraryHistory';
import {
  RemovalExecutionInitiator,
  RemovalScheduleStatus,
  type RemovalTargetType,
} from '@server/constants/removal';
import { getRepository } from '@server/datasource';
import { CanonicalMedia, CanonicalSeason } from '@server/entity/CanonicalMedia';
import { RemovalExecutionClaim } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import type {
  LibraryBulkActionEligibilityReason,
  LibraryBulkActionEligibilityResponse,
  LibraryBulkActionOutcome,
  LibraryBulkActionRequest,
  LibraryBulkActionResponse,
  LibraryBulkActionResult,
  LibraryBulkActionTarget,
} from '@server/interfaces/api/libraryInterfaces';
import { resolveCurrentRemovalTargetsForEligibility } from '@server/lib/libraryBulkEligibilityResolver';
import {
  MediaRemovalError,
  assertRemovalTargetAcquisitionInactive,
  default as mediaRemoval,
  refreshRemovalAcquisitionState,
  resolveCurrentRemovalTarget,
  type MediaRemovalErrorCode,
  type RemovalResult,
  type ResolvedRemovalTarget,
} from '@server/lib/mediaRemoval';
import removalExecutionGuard, {
  removalExecutionTargetKey,
} from '@server/lib/removalExecutionGuard';
import removalScheduler, {
  RemovalScheduleConflictError,
  type ExactRemovalScheduleCancellationResult,
  type ManualRemovalScheduleResult,
} from '@server/lib/removalScheduler';
import { In, IsNull, Not } from 'typeorm';

export class LibraryBulkActionValidationError extends Error {}

interface LibraryBulkActionScheduler {
  hasLiveProcessingLease(canonicalMediaId: number): Promise<boolean>;
  createManualWithResult(input: {
    canonicalMediaId: number;
    targetType: RemovalTargetType;
    seasonNumber?: number;
    sourceScope?: string;
  }): Promise<ManualRemovalScheduleResult>;
  cancelExactTarget(input: {
    canonicalMediaId: number;
    targetType: RemovalTargetType;
    seasonNumber?: number;
  }): Promise<ExactRemovalScheduleCancellationResult>;
}

interface LibraryBulkActionDependencies {
  scheduler: LibraryBulkActionScheduler;
  validateTargets: (targets: LibraryBulkActionTarget[]) => Promise<void>;
  resolveTarget: (
    target: LibraryBulkActionTarget
  ) => Promise<ResolvedRemovalTarget>;
  resolveTargets?: (
    targets: LibraryBulkActionTarget[]
  ) => Promise<PromiseSettledResult<ResolvedRemovalTarget>[]>;
  refreshAcquisitionState: () => Promise<void>;
  assertAcquisitionInactive: (target: ResolvedRemovalTarget) => void;
  acquireExecutionGuard: (canonicalMediaId: number) => (() => void) | null;
  removeTarget: (target: LibraryBulkActionTarget) => Promise<RemovalResult>;
  loadActionableSchedules: (
    canonicalMediaIds: number[]
  ) => Promise<RemovalSchedule[]>;
  loadClaimedCanonicalMediaIds?: (
    canonicalMediaIds: number[]
  ) => Promise<Set<number>>;
  isExecutionActive: (canonicalMediaId: number) => boolean;
  now: () => Date;
}

const targetKey = (target: LibraryBulkActionTarget) =>
  target.targetType === 'season'
    ? `season:${target.canonicalMediaId}:${target.seasonNumber}`
    : `${target.targetType}:${target.canonicalMediaId}`;

const findCanonicalMediaInChunks = async (ids: number[]) => {
  const items: CanonicalMedia[] = [];
  for (let index = 0; index < ids.length; index += 400) {
    items.push(
      ...(await getRepository(CanonicalMedia).findBy({
        id: In(ids.slice(index, index + 400)),
      }))
    );
  }
  return items;
};

const findCanonicalSeasonsInChunks = async (seriesIds: number[]) => {
  const seasons: CanonicalSeason[] = [];
  for (let index = 0; index < seriesIds.length; index += 400) {
    seasons.push(
      ...(await getRepository(CanonicalSeason).findBy({
        seriesId: In(seriesIds.slice(index, index + 400)),
      }))
    );
  }
  return seasons;
};

export const validateLibraryBulkActionTargets = async (
  targets: LibraryBulkActionTarget[]
): Promise<void> => {
  const seen = new Set<string>();
  const seriesIds = new Set<number>();
  const seasonSeriesIds = new Set<number>();
  for (const target of targets) {
    const key = targetKey(target);
    if (seen.has(key)) {
      throw new LibraryBulkActionValidationError(
        'Duplicate Library bulk-action target.'
      );
    }
    seen.add(key);
    if (target.targetType === 'series') seriesIds.add(target.canonicalMediaId);
    if (target.targetType === 'season')
      seasonSeriesIds.add(target.canonicalMediaId);
  }
  if ([...seriesIds].some((id) => seasonSeriesIds.has(id))) {
    throw new LibraryBulkActionValidationError(
      'Whole-Series and Season targets cannot overlap.'
    );
  }

  const ids = [
    ...new Set(targets.map(({ canonicalMediaId }) => canonicalMediaId)),
  ];
  const canonical = await findCanonicalMediaInChunks(ids);
  const canonicalById = new Map(canonical.map((item) => [item.id, item]));
  for (const target of targets) {
    const media = canonicalById.get(target.canonicalMediaId);
    if (!media) {
      throw new LibraryBulkActionValidationError(
        `Canonical media ${target.canonicalMediaId} does not exist.`
      );
    }
    const validType =
      (target.targetType === 'movie' &&
        media.mediaType === LibraryMediaType.MOVIE) ||
      (target.targetType !== 'movie' &&
        media.mediaType === LibraryMediaType.SERIES);
    if (!validType) {
      throw new LibraryBulkActionValidationError(
        `Target type does not match canonical media ${target.canonicalMediaId}.`
      );
    }
  }

  const seasonTargets = targets.filter(
    (target): target is LibraryBulkActionTarget & { seasonNumber: number } =>
      target.targetType === 'season' && target.seasonNumber !== undefined
  );
  if (seasonTargets.length === 0) return;
  const seasons = await findCanonicalSeasonsInChunks([
    ...new Set(seasonTargets.map(({ canonicalMediaId }) => canonicalMediaId)),
  ]);
  const seasonKeys = new Set(
    seasons.map((season) => `${season.seriesId}:${season.seasonNumber}`)
  );
  for (const target of seasonTargets) {
    if (!seasonKeys.has(`${target.canonicalMediaId}:${target.seasonNumber}`)) {
      throw new LibraryBulkActionValidationError(
        `Season ${target.seasonNumber} does not exist for canonical Series ${target.canonicalMediaId}.`
      );
    }
  }
};

const defaultDependencies: LibraryBulkActionDependencies = {
  scheduler: removalScheduler,
  validateTargets: validateLibraryBulkActionTargets,
  resolveTarget: (target) =>
    resolveCurrentRemovalTarget({
      ...target,
      targetType: target.targetType as RemovalTargetType,
      removalSource: LibraryRemovalSource.MANUAL,
    }),
  resolveTargets: (targets) =>
    resolveCurrentRemovalTargetsForEligibility(
      targets.map((target) => ({
        ...target,
        targetType: target.targetType as RemovalTargetType,
        removalSource: LibraryRemovalSource.MANUAL,
      }))
    ),
  refreshAcquisitionState: refreshRemovalAcquisitionState,
  assertAcquisitionInactive: assertRemovalTargetAcquisitionInactive,
  acquireExecutionGuard: (canonicalMediaId) =>
    removalExecutionGuard.acquire(removalExecutionTargetKey(canonicalMediaId)),
  removeTarget: (target) =>
    mediaRemoval.remove(
      {
        canonicalMediaId: target.canonicalMediaId,
        targetType: target.targetType as RemovalTargetType,
        seasonNumber: target.seasonNumber,
        removalSource: LibraryRemovalSource.MANUAL,
      },
      RemovalExecutionInitiator.BULK
    ),
  loadActionableSchedules: (canonicalMediaIds) =>
    getRepository(RemovalSchedule).find({
      where: {
        canonicalMediaId: In(canonicalMediaIds),
        status: In([
          RemovalScheduleStatus.ACTIVE,
          RemovalScheduleStatus.DEFERRED,
        ]),
      },
      order: { canonicalMediaId: 'ASC', id: 'ASC' },
    }),
  loadClaimedCanonicalMediaIds: async (canonicalMediaIds) =>
    new Set(
      (
        await getRepository(RemovalExecutionClaim).find({
          where: {
            canonicalMediaId: In(canonicalMediaIds),
            executionId: Not(IsNull()),
          },
          select: { canonicalMediaId: true },
        })
      ).map(({ canonicalMediaId }) => canonicalMediaId)
    ),
  isExecutionActive: (canonicalMediaId) =>
    removalExecutionGuard.isActive(removalExecutionTargetKey(canonicalMediaId)),
  now: () => new Date(),
};

const result = (
  target: LibraryBulkActionTarget,
  values: Omit<LibraryBulkActionResult, 'target'>
): LibraryBulkActionResult => ({ target, ...values });

const mediaRemovalFailure = (
  target: LibraryBulkActionTarget,
  error: MediaRemovalError
): LibraryBulkActionResult => {
  const outcomeByError: Partial<
    Record<MediaRemovalErrorCode, readonly [LibraryBulkActionOutcome, string]>
  > = {
    NOT_FOUND: ['missing', 'missing'] as const,
    NOT_CURRENT: ['not_current', 'not_current'] as const,
    AMBIGUOUS_SOURCE: ['ambiguous_source', 'ambiguous_source'] as const,
    ACTIVE_ACQUISITION: ['active_acquisition', 'active_acquisition'] as const,
    IDENTITY_CONFLICT: ['identity_conflict', 'identity_conflict'] as const,
    EXECUTION_CONFLICT: ['in_progress', 'in_progress'] as const,
    SCHEDULE_CONFLICT: ['in_progress', 'schedule_conflict'] as const,
    CROSS_SEASON_FILE: ['cross_season_file', 'cross_season_file'] as const,
    REMOTE_REMOVED_LOCAL_FAILED: [
      'remote_removed_local_failed',
      'remote_removed_local_failed',
    ] as const,
  };
  const mapped = outcomeByError[error.code];
  return result(target, {
    outcome: mapped?.[0] ?? 'failed',
    code: mapped?.[1] ?? error.code.toLowerCase(),
    retryable:
      error.code !== 'REMOTE_REMOVED_LOCAL_FAILED' &&
      (error.retryable ||
        [
          'AMBIGUOUS_SOURCE',
          'ACTIVE_ACQUISITION',
          'EXECUTION_CONFLICT',
        ].includes(error.code)),
    message:
      error.code === 'REMOTE_REMOVED_LOCAL_FAILED'
        ? 'The provider operation may have completed, but local reconciliation failed. Do not retry this removal automatically.'
        : error.message,
    affectedSchedules: 0,
  });
};

const summarize = (
  request: LibraryBulkActionRequest,
  results: LibraryBulkActionResult[]
): LibraryBulkActionResponse => {
  const succeededOutcomes = new Set([
    'scheduled',
    'cancelled',
    'provider_acknowledged',
    'provider_absent_reconciled',
  ]);
  const unchangedOutcomes = new Set(['already_scheduled', 'not_scheduled']);
  const failedOutcomes = new Set([
    'remote_removed_local_failed',
    'failed',
    'not_attempted',
  ]);
  return {
    action: request.action,
    requested: request.targets.length,
    succeeded: results.filter(({ outcome }) => succeededOutcomes.has(outcome))
      .length,
    unchanged: results.filter(({ outcome }) => unchangedOutcomes.has(outcome))
      .length,
    skipped: results.filter(
      ({ outcome }) =>
        !succeededOutcomes.has(outcome) &&
        !unchangedOutcomes.has(outcome) &&
        !failedOutcomes.has(outcome)
    ).length,
    failed: results.filter(({ outcome }) => failedOutcomes.has(outcome)).length,
    results,
  };
};

const scheduleMatchesTarget = (
  schedule: RemovalSchedule,
  target: LibraryBulkActionTarget
) =>
  schedule.targetType === target.targetType &&
  (target.targetType === 'season'
    ? schedule.seasonNumber === target.seasonNumber
    : schedule.seasonNumber == null);

const previewFailure = (
  error: unknown
): {
  eligibility: 'unavailable' | 'conflict' | 'unknown';
  reason: LibraryBulkActionEligibilityReason;
} => {
  if (!(error instanceof MediaRemovalError)) {
    return { eligibility: 'unknown', reason: 'unavailable' };
  }
  switch (error.code) {
    case 'NOT_FOUND':
      return { eligibility: 'unavailable', reason: 'missing' };
    case 'NOT_CURRENT':
      return { eligibility: 'unavailable', reason: 'not_current' };
    case 'IDENTITY_CONFLICT':
      return { eligibility: 'unavailable', reason: 'identity_conflict' };
    case 'CONFIGURATION':
      return { eligibility: 'unavailable', reason: 'configuration' };
    case 'AMBIGUOUS_SOURCE':
      return { eligibility: 'conflict', reason: 'ambiguous_source' };
    case 'ACTIVE_ACQUISITION':
      return { eligibility: 'conflict', reason: 'active_acquisition' };
    case 'EXECUTION_CONFLICT':
    case 'SCHEDULE_CONFLICT':
      return { eligibility: 'conflict', reason: 'execution_in_progress' };
    default:
      return { eligibility: 'unknown', reason: 'unavailable' };
  }
};

export class LibraryBulkActionService {
  constructor(
    private readonly dependencies: LibraryBulkActionDependencies = defaultDependencies
  ) {}

  public async previewEligibility(
    targets: LibraryBulkActionTarget[]
  ): Promise<LibraryBulkActionEligibilityResponse> {
    await this.dependencies.validateTargets(targets);
    const canonicalMediaIds = [
      ...new Set(targets.map(({ canonicalMediaId }) => canonicalMediaId)),
    ];
    const schedules =
      await this.dependencies.loadActionableSchedules(canonicalMediaIds);
    const claimedCanonicalMediaIds =
      (await this.dependencies.loadClaimedCanonicalMediaIds?.(
        canonicalMediaIds
      )) ?? new Set<number>();
    const schedulesByMedia = new Map<number, RemovalSchedule[]>();
    schedules.forEach((schedule) => {
      const current = schedulesByMedia.get(schedule.canonicalMediaId) ?? [];
      current.push(schedule);
      schedulesByMedia.set(schedule.canonicalMediaId, current);
    });
    const now = this.dependencies.now();

    const results: (
      | LibraryBulkActionEligibilityResponse['results'][number]
      | undefined
    )[] = [];
    const unresolvedTargets: LibraryBulkActionTarget[] = [];
    const unresolvedIndexes: number[] = [];
    for (const [index, target] of targets.entries()) {
      const targetSchedules =
        schedulesByMedia.get(target.canonicalMediaId) ?? [];
      if (this.dependencies.isExecutionActive(target.canonicalMediaId)) {
        results.push({
          target,
          eligibility: 'conflict' as const,
          reason: 'execution_in_progress' as const,
        });
        continue;
      }
      if (claimedCanonicalMediaIds.has(target.canonicalMediaId)) {
        results.push({
          target,
          eligibility: 'conflict' as const,
          reason: 'execution_in_progress' as const,
        });
        continue;
      }
      if (
        targetSchedules.some(
          ({ leaseToken, leaseUntil }) =>
            Boolean(leaseToken) && Boolean(leaseUntil && leaseUntil > now)
        )
      ) {
        results.push({
          target,
          eligibility: 'conflict' as const,
          reason: 'processing_lease' as const,
        });
        continue;
      }
      if (
        target.targetType === 'season' &&
        targetSchedules.some(({ targetType }) => targetType === 'series')
      ) {
        results.push({
          target,
          eligibility: 'conflict' as const,
          reason: 'whole_series_scheduled' as const,
        });
        continue;
      }
      if (
        targetSchedules.some((schedule) =>
          scheduleMatchesTarget(schedule, target)
        )
      ) {
        results.push({
          target,
          eligibility: 'cancel_schedule' as const,
          reason: 'scheduled' as const,
        });
        continue;
      }
      unresolvedTargets.push(target);
      unresolvedIndexes.push(index);
      results.push(undefined);
    }

    let resolvedTargets: PromiseSettledResult<ResolvedRemovalTarget>[];
    try {
      resolvedTargets = this.dependencies.resolveTargets
        ? await this.dependencies.resolveTargets(unresolvedTargets)
        : await Promise.allSettled(
            unresolvedTargets.map((target) =>
              this.dependencies.resolveTarget(target)
            )
          );
    } catch (reason) {
      resolvedTargets = unresolvedTargets.map(() => ({
        status: 'rejected',
        reason,
      }));
    }
    resolvedTargets.forEach((resolution, unresolvedIndex) => {
      const target = unresolvedTargets[unresolvedIndex];
      const resultIndex = unresolvedIndexes[unresolvedIndex];
      try {
        if (resolution.status === 'rejected') throw resolution.reason;
        const resolved = resolution.value;
        this.dependencies.assertAcquisitionInactive(resolved);
        results[resultIndex] = {
          target,
          eligibility: 'schedule' as const,
          reason: 'unscheduled' as const,
        };
      } catch (error) {
        results[resultIndex] = { target, ...previewFailure(error) };
      }
    });
    return {
      results: results.map(
        (item, index) =>
          item ?? {
            target: targets[index],
            eligibility: 'unknown',
            reason: 'unavailable',
          }
      ),
    };
  }

  public async execute(
    request: LibraryBulkActionRequest
  ): Promise<LibraryBulkActionResponse> {
    if (
      !['schedule', 'cancel_schedule', 'remove_now'].includes(request.action)
    ) {
      throw new LibraryBulkActionValidationError('Unsupported bulk action.');
    }
    if (request.action === 'remove_now' && request.targets.length > 10) {
      throw new LibraryBulkActionValidationError(
        'Remove Now supports at most 10 targets per batch.'
      );
    }
    await this.dependencies.validateTargets(request.targets);

    if (request.action === 'schedule') {
      try {
        await this.dependencies.refreshAcquisitionState();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Acquisition state could not be refreshed.';
        return summarize(
          request,
          request.targets.map((target) =>
            result(target, {
              outcome: 'not_attempted',
              code: 'acquisition_state_unavailable',
              retryable: true,
              message,
              affectedSchedules: 0,
            })
          )
        );
      }
    }

    const results: LibraryBulkActionResult[] = [];
    for (let index = 0; index < request.targets.length; index += 1) {
      const target = request.targets[index];
      if (request.action === 'remove_now') {
        try {
          const removed = await this.dependencies.removeTarget(target);
          results.push(
            result(target, {
              outcome:
                removed.providerResult === 'removed'
                  ? 'provider_acknowledged'
                  : 'provider_absent_reconciled',
              code:
                removed.providerResult === 'removed'
                  ? 'provider_acknowledged'
                  : 'provider_absent_reconciled',
              retryable: false,
              message:
                removed.providerResult === 'removed'
                  ? 'The provider acknowledged the removal request. Physical file deletion was not independently verified.'
                  : 'The provider reported the target absent and Library facts were reconciled.',
              affectedSchedules: removed.affectedSchedules ?? 0,
            })
          );
        } catch (error) {
          if (error instanceof MediaRemovalError) {
            results.push(mediaRemovalFailure(target, error));
            if (error.code === 'REMOTE_REMOVED_LOCAL_FAILED') {
              request.targets.slice(index + 1).forEach((pendingTarget) => {
                results.push(
                  result(pendingTarget, {
                    outcome: 'not_attempted',
                    code: 'local_reconciliation_unavailable',
                    retryable: true,
                    message:
                      'This target was not attempted because local reconciliation became unavailable.',
                    affectedSchedules: 0,
                  })
                );
              });
              break;
            }
            continue;
          }
          results.push(
            result(target, {
              outcome: 'failed',
              code: 'batch_infrastructure_failure',
              retryable: true,
              message: 'The removal batch could not continue safely.',
              affectedSchedules: 0,
            })
          );
          request.targets.slice(index + 1).forEach((pendingTarget) => {
            results.push(
              result(pendingTarget, {
                outcome: 'not_attempted',
                code: 'batch_infrastructure_failure',
                retryable: true,
                message:
                  'This target was not attempted because batch infrastructure became unavailable.',
                affectedSchedules: 0,
              })
            );
          });
          break;
        }
        continue;
      }
      const release = this.dependencies.acquireExecutionGuard(
        target.canonicalMediaId
      );
      if (!release) {
        results.push(
          result(target, {
            outcome: 'in_progress',
            code: 'in_progress',
            retryable: true,
            message: 'A removal operation is already in progress.',
            affectedSchedules: 0,
          })
        );
        continue;
      }
      try {
        if (
          await this.dependencies.scheduler.hasLiveProcessingLease(
            target.canonicalMediaId
          )
        ) {
          results.push(
            result(target, {
              outcome: 'in_progress',
              code: 'processing_lease_active',
              retryable: true,
              message: 'A removal operation is currently being processed.',
              affectedSchedules: 0,
            })
          );
          continue;
        }
        if (request.action === 'schedule') {
          const resolved = await this.dependencies.resolveTarget(target);
          this.dependencies.assertAcquisitionInactive(resolved);
          const scheduled =
            await this.dependencies.scheduler.createManualWithResult({
              ...target,
              targetType: target.targetType as RemovalTargetType,
              sourceScope: resolved.sourceScope,
            });
          results.push(
            result(target, {
              outcome: scheduled.created ? 'scheduled' : 'already_scheduled',
              code: scheduled.created
                ? 'schedule_created'
                : 'already_scheduled',
              retryable: false,
              message: scheduled.created
                ? 'Removal was scheduled.'
                : 'A matching removal schedule already exists.',
              affectedSchedules: scheduled.affectedSchedules,
            })
          );
        } else {
          const cancelled = await this.dependencies.scheduler.cancelExactTarget(
            {
              ...target,
              targetType: target.targetType as RemovalTargetType,
            }
          );
          results.push(
            result(target, {
              outcome: cancelled.inProgress
                ? 'in_progress'
                : cancelled.affectedSchedules > 0
                  ? 'cancelled'
                  : 'not_scheduled',
              code: cancelled.inProgress
                ? 'processing_lease_active'
                : cancelled.affectedSchedules > 0
                  ? 'schedules_cancelled'
                  : 'not_scheduled',
              retryable: cancelled.inProgress,
              message: cancelled.inProgress
                ? 'A matching removal schedule is currently being processed.'
                : cancelled.affectedSchedules > 0
                  ? 'Matching removal schedules were cancelled.'
                  : 'No matching actionable removal schedule exists.',
              affectedSchedules: cancelled.affectedSchedules,
            })
          );
        }
      } catch (error) {
        if (error instanceof MediaRemovalError) {
          results.push(mediaRemovalFailure(target, error));
        } else if (error instanceof RemovalScheduleConflictError) {
          results.push(
            result(target, {
              outcome: 'in_progress',
              code: 'schedule_conflict',
              retryable: true,
              message: error.message,
              affectedSchedules: 0,
            })
          );
        } else {
          results.push(
            result(target, {
              outcome: 'failed',
              code: 'unexpected_error',
              retryable: true,
              message: 'The target could not be processed.',
              affectedSchedules: 0,
            })
          );
        }
      } finally {
        release();
      }
    }
    return summarize(request, results);
  }
}

const libraryBulkActions = new LibraryBulkActionService();
export default libraryBulkActions;
