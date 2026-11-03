import { LibraryRemovalSource } from '@server/constants/libraryHistory';
import {
  RemovalScheduleOrigin,
  RemovalScheduleStatus,
  RemovalTargetType,
  type AutomaticRemovalPolicy,
  type RemovalSettings,
} from '@server/constants/removal';
import dataSource, { getRepository } from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import { RemovalExecutionClaim } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import downloadTracker from '@server/lib/downloadtracker';
import {
  currentLibraryAddedSql,
  currentLibraryLastActiveSql,
  normalizeLibraryDatabaseDate,
} from '@server/lib/libraryActivity';
import mediaRemoval, {
  resolveCurrentRemovalTarget,
  type MediaRemovalService,
} from '@server/lib/mediaRemoval';
import { ScheduledRemovalExecutor } from '@server/lib/scheduledRemovalExecutor';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  In,
  IsNull,
  LessThanOrEqual,
  type DataSource,
  type EntityManager,
} from 'typeorm';

const ACTIVE_STATUSES = [
  RemovalScheduleStatus.ACTIVE,
  RemovalScheduleStatus.DEFERRED,
];
const DAY_MS = 86_400_000;

export interface RemovalCandidate {
  canonicalMediaId: number;
  mediaType: 'movie' | 'series';
  title: string;
  year: number | null;
  addedAt: Date;
  lastActiveAt: Date | null;
  sourceSystem: 'radarr' | 'sonarr';
  sourceScope: string;
  serviceId: number | null;
  externalServiceId: number | null;
}

export interface RemovalSelectionPool {
  eligibleUnscheduled: number;
  itemsPerRun: number;
  selectedCandidates: number[];
}

export interface CandidateSelectionResult {
  movie: RemovalSelectionPool;
  series: RemovalSelectionPool;
}

export interface ScheduledRemovalProcessingResult {
  completed: number;
  cancelledForActivity: number;
  deferred: number;
  failed: number;
}

export interface RemovalPreviewCandidate {
  canonicalMediaId: number;
  title: string;
  year: number | null;
  addedAt: string;
  lastActiveAt: string | null;
}

export interface RemovalPreviewPool extends Omit<
  RemovalSelectionPool,
  'selectedCandidates'
> {
  oldestCurrentAddedAt: string | null;
  maximumSelectableMonths: number;
  candidates: RemovalPreviewCandidate[];
}

export interface RemovalPreviewResult {
  actionableScheduleCount: number;
  movie: RemovalPreviewPool;
  series: RemovalPreviewPool;
}

export class RemovalScheduleConflictError extends Error {}

const retryableClearContention = (error: unknown): boolean => {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : undefined;
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    code === '40001' ||
    code === '40P01'
  );
};

export const clearAllScheduledRemovalRecords = async (
  connection: DataSource,
  now: Date
): Promise<{ cancelled: number }> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await connection.transaction('SERIALIZABLE', async (manager) => {
        const repository = manager.getRepository(RemovalSchedule);
        if (connection.options.type !== 'postgres') {
          await repository
            .createQueryBuilder()
            .update(RemovalSchedule)
            .set({ revision: () => '"revision"' })
            .where('status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
            .execute();
        }
        const schedules = await repository.find({
          where: { status: In(ACTIVE_STATUSES) },
          order: { canonicalMediaId: 'ASC', id: 'ASC' },
        });
        const canonicalMediaIds = [
          ...new Set(schedules.map(({ canonicalMediaId }) => canonicalMediaId)),
        ];
        for (const canonicalMediaId of canonicalMediaIds) {
          const query = manager
            .getRepository(CanonicalMedia)
            .createQueryBuilder('canonical')
            .where('canonical.id = :canonicalMediaId', { canonicalMediaId });
          if (connection.options.type === 'postgres') {
            query.setLock('pessimistic_write');
          }
          await query.getOneOrFail();
        }
        const hasLegacyLease = schedules.some(
          (schedule) =>
            Boolean(schedule.leaseToken) &&
            Boolean(schedule.leaseUntil && schedule.leaseUntil > now)
        );
        const claimed =
          canonicalMediaIds.length === 0
            ? []
            : await manager.getRepository(RemovalExecutionClaim).find({
                where: { canonicalMediaId: In(canonicalMediaIds) },
              });
        if (
          hasLegacyLease ||
          claimed.some((claim) => Boolean(claim.executionId))
        ) {
          throw new RemovalScheduleConflictError(
            'A scheduled removal is currently being processed'
          );
        }
        for (const schedule of schedules) {
          schedule.status = RemovalScheduleStatus.CANCELLED;
          schedule.activeKey = null;
          schedule.leaseToken = null;
          schedule.leaseUntil = null;
          schedule.revision += 1;
        }
        if (schedules.length > 0) await repository.save(schedules);
        return { cancelled: schedules.length };
      });
    } catch (error) {
      if (
        error instanceof RemovalScheduleConflictError ||
        !retryableClearContention(error)
      ) {
        throw error;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  throw lastError;
};

export interface ManualRemovalScheduleResult {
  schedule: RemovalSchedule;
  created: boolean;
  affectedSchedules: number;
}

export interface ExactRemovalScheduleCancellationResult {
  affectedSchedules: number;
  inProgress: boolean;
}

export const removalBatchSize = (
  eligiblePopulation: number,
  policy: AutomaticRemovalPolicy
) => (policy.enabled ? Math.min(policy.itemsPerRun, eligiblePopulation) : 0);

export const subtractCalendarMonths = (value: Date, months: number): Date => {
  const targetYear = value.getUTCFullYear();
  const targetMonth = value.getUTCMonth() - months;
  const lastTargetDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0)
  ).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(value.getUTCDate(), lastTargetDay),
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds()
    )
  );
};

export const completeCalendarMonthsBetween = (start: Date, end: Date) => {
  if (start > end) return 0;
  const roughMonths =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth();
  return Math.max(
    0,
    start <= subtractCalendarMonths(end, roughMonths)
      ? roughMonths
      : roughMonths - 1
  );
};

export const currentMonthBounds = (
  candidates: RemovalCandidate[],
  mediaType: 'movie' | 'series',
  now: Date
) => {
  const oldestCurrentAddedAt = candidates
    .filter((candidate) => candidate.mediaType === mediaType)
    .reduce<Date | null>(
      (value, candidate) =>
        !value || candidate.addedAt < value ? candidate.addedAt : value,
      null
    );
  return {
    oldestCurrentAddedAt,
    maximumSelectableMonths: oldestCurrentAddedAt
      ? completeCalendarMonthsBetween(oldestCurrentAddedAt, now)
      : 0,
  };
};

export const isAutomaticallyEligible = (
  candidate: RemovalCandidate,
  policy: AutomaticRemovalPolicy,
  now: Date
) => {
  if (!policy.enabled) return false;
  return meetsAutomaticRemovalCriteria(candidate, policy, now);
};

export const meetsAutomaticRemovalCriteria = (
  candidate: RemovalCandidate,
  policy: AutomaticRemovalPolicy,
  now: Date
) => {
  const inactivityStart = candidate.lastActiveAt ?? candidate.addedAt;
  return (
    candidate.addedAt <= subtractCalendarMonths(now, policy.minimumAgeMonths) &&
    inactivityStart <= subtractCalendarMonths(now, policy.inactivityMonths)
  );
};

export const rankRemovalCandidates = (candidates: RemovalCandidate[]) =>
  [...candidates].sort((left, right) => {
    const leftInactive = (left.lastActiveAt ?? left.addedAt).getTime();
    const rightInactive = (right.lastActiveAt ?? right.addedAt).getTime();
    return (
      leftInactive - rightInactive ||
      left.addedAt.getTime() - right.addedAt.getTime() ||
      left.canonicalMediaId - right.canonicalMediaId
    );
  });

export const planAutomaticRemovalPool = ({
  mediaType,
  candidates,
  active,
  policy,
  now,
}: {
  mediaType: 'movie' | 'series';
  candidates: RemovalCandidate[];
  active: Pick<RemovalSchedule, 'canonicalMediaId' | 'origin' | 'targetType'>[];
  policy: AutomaticRemovalPolicy;
  now: Date;
}) => {
  const scheduledIds = new Set(active.map((item) => item.canonicalMediaId));
  const eligibleUnscheduled = rankRemovalCandidates(
    candidates
      .filter((candidate) => !scheduledIds.has(candidate.canonicalMediaId))
      .filter(
        (candidate) =>
          candidate.mediaType === mediaType &&
          meetsAutomaticRemovalCriteria(candidate, policy, now)
      )
  );
  const selected = eligibleUnscheduled.slice(
    0,
    removalBatchSize(eligibleUnscheduled.length, policy)
  );
  return {
    eligibleUnscheduled,
    selected,
    scheduledIds,
    eligibleUnscheduledCount: eligibleUnscheduled.length,
  };
};

const activeKey = (
  canonicalMediaId: number,
  targetType: RemovalTargetType,
  seasonNumber: number | undefined,
  sourceScope: string
) => `${sourceScope}:${canonicalMediaId}:${targetType}:${seasonNumber ?? '-'}`;

const asDate = (value: string | Date | null | undefined): Date | null => {
  return normalizeLibraryDatabaseDate(value);
};

export const parseServarrSourceItemId = (
  value: unknown,
  sourceSystem: 'radarr' | 'sonarr'
): number | null => {
  const expectedPrefix = sourceSystem === 'radarr' ? 'movie:' : 'series:';
  const sourceItemId = String(value ?? '');
  const numericValue = sourceItemId.startsWith(expectedPrefix)
    ? sourceItemId.slice(expectedPrefix.length)
    : sourceItemId;
  const parsed = Number(numericValue);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const hasExactRemovalTarget = (candidate: RemovalCandidate) =>
  candidate.serviceId !== null && candidate.externalServiceId !== null;

const acquisitionInactive = (candidate: RemovalCandidate) =>
  hasExactRemovalTarget(candidate) &&
  (candidate.sourceSystem === 'radarr'
    ? downloadTracker.getMovieProgress(
        candidate.serviceId!,
        candidate.externalServiceId!
      ).length === 0
    : downloadTracker.getSeriesProgress(
        candidate.serviceId!,
        candidate.externalServiceId!
      ).length === 0);

export class RemovalScheduler {
  private candidateSelectionRunning?: Promise<CandidateSelectionResult>;
  private scheduledRemovalProcessingRunning?: Promise<ScheduledRemovalProcessingResult>;
  private clearingSchedules = false;
  private readonly scheduledExecutor: Pick<
    ScheduledRemovalExecutor,
    'execute' | 'recover'
  >;

  constructor(
    remover: Pick<MediaRemovalService, 'remove'> = mediaRemoval,
    private readonly now: () => Date = () => new Date(),
    scheduledExecutor?: Pick<ScheduledRemovalExecutor, 'execute' | 'recover'>
  ) {
    if (remover !== mediaRemoval && !scheduledExecutor) {
      throw new Error(
        'A custom removal service requires a fenced scheduled executor'
      );
    }
    this.scheduledExecutor =
      scheduledExecutor ??
      new ScheduledRemovalExecutor(
        dataSource,
        mediaRemoval,
        undefined,
        this.now
      );
  }

  private async candidates(): Promise<RemovalCandidate[]> {
    const addedAtSql = currentLibraryAddedSql({ currentExpression: 'TRUE' });
    const lastActiveAtSql = currentLibraryLastActiveSql({
      currentExpression: 'TRUE',
    });
    const rows = await getRepository(CanonicalMedia).query(`
      SELECT canonical.id AS "canonicalMediaId", canonical."mediaType" AS "mediaType",
        canonical."titleSnapshot" AS title, canonical.year AS year,
        presence."sourceSystem" AS "sourceSystem", presence."sourceScope" AS "sourceScope",
        presence."sourceItemId" AS "sourceItemId",
        ${addedAtSql} AS "addedAt",
        ${lastActiveAtSql} AS "lastActiveAt"
      FROM "canonical_media" canonical
      INNER JOIN "library_presence" presence ON presence."canonicalMediaId" = canonical.id
        AND presence."isCurrent" = TRUE AND presence."sourceSystem" IN ('radarr', 'sonarr')
        AND presence."servarrHasFile" = TRUE
        AND ((canonical."mediaType" = 'movie' AND presence."sourceSystem" = 'radarr')
          OR (canonical."mediaType" = 'series' AND presence."sourceSystem" = 'sonarr'))
      GROUP BY canonical.id, canonical."mediaType", canonical."titleSnapshot", canonical.year,
        presence."sourceSystem", presence."sourceScope", presence."sourceItemId"
      ORDER BY canonical.id ASC, presence."sourceScope" ASC
    `);
    const grouped = new Map<number, Record<string, unknown>[]>();
    for (const row of rows as Record<string, unknown>[]) {
      const id = Number(row.canonicalMediaId);
      if (!Number.isSafeInteger(id)) continue;
      const group = grouped.get(id) ?? [];
      group.push(row);
      grouped.set(id, group);
    }
    return [...grouped.entries()].flatMap(([id, matches]) => {
      const distinctSources = new Set(
        matches.map(
          (row) =>
            `${String(row.sourceSystem)}:${String(row.sourceScope)}:${String(
              row.sourceItemId
            )}`
        )
      );
      if (distinctSources.size !== 1) {
        logger.warn('Skipping ambiguous automatic removal candidate', {
          label: 'Removal Scheduler',
          canonicalMediaId: id,
          sourceCount: distinctSources.size,
        });
        return [];
      }
      const row = matches[0];
      const addedAt = asDate(row.addedAt as string | Date | null);
      const sourceSystem = row.sourceSystem as 'radarr' | 'sonarr';
      if (!addedAt) return [];
      return [
        {
          canonicalMediaId: id,
          mediaType: row.mediaType as 'movie' | 'series',
          title: String(row.title ?? 'Untitled'),
          year: row.year == null ? null : Number(row.year),
          addedAt,
          lastActiveAt: asDate(row.lastActiveAt as string | Date | null),
          sourceSystem,
          sourceScope: String(row.sourceScope),
          serviceId: /^service:\d+$/.test(String(row.sourceScope))
            ? Number(String(row.sourceScope).slice('service:'.length))
            : null,
          externalServiceId: parseServarrSourceItemId(
            row.sourceItemId,
            sourceSystem
          ),
        },
      ];
    });
  }

  private async activityAt(schedule: RemovalSchedule): Promise<Date | null> {
    const canonicalMediaId = Number(schedule.canonicalMediaId);
    const seasonNumber =
      schedule.targetType === RemovalTargetType.SEASON
        ? Number(schedule.seasonNumber)
        : undefined;
    const activitySql = currentLibraryLastActiveSql({
      currentExpression: 'TRUE',
      seasonNumber,
    });
    const rows = await getRepository(CanonicalMedia).query(
      `SELECT ${activitySql} AS "activityAt"
        FROM "canonical_media" canonical WHERE canonical.id = ${canonicalMediaId}`
    );
    return asDate(rows[0]?.activityAt);
  }

  public async hasLiveProcessingLease(
    canonicalMediaId: number
  ): Promise<boolean> {
    const durableClaim = await getRepository(RemovalExecutionClaim).findOne({
      where: { canonicalMediaId },
      select: { executionId: true },
    });
    if (durableClaim?.executionId) return true;
    const schedules = await getRepository(RemovalSchedule).find({
      where: {
        canonicalMediaId,
        status: In(ACTIVE_STATUSES),
      },
    });
    const now = this.now();
    return schedules.some(
      (schedule) =>
        Boolean(schedule.leaseToken) &&
        Boolean(schedule.leaseUntil && schedule.leaseUntil > now)
    );
  }

  private async hasDurableExecutionClaim(
    manager: EntityManager,
    canonicalMediaId: number
  ): Promise<boolean> {
    const claim = await manager.getRepository(RemovalExecutionClaim).findOne({
      where: { canonicalMediaId },
      select: { executionId: true },
    });
    return Boolean(claim?.executionId);
  }

  public async createManual(input: {
    canonicalMediaId: number;
    targetType: RemovalTargetType;
    seasonNumber?: number;
    sourceScope?: string;
  }): Promise<RemovalSchedule> {
    return (await this.createManualWithResult(input)).schedule;
  }

  public async createManualWithResult(input: {
    canonicalMediaId: number;
    targetType: RemovalTargetType;
    seasonNumber?: number;
    sourceScope?: string;
  }): Promise<ManualRemovalScheduleResult> {
    const target = await resolveCurrentRemovalTarget({
      canonicalMediaId: input.canonicalMediaId,
      targetType: input.targetType,
      seasonNumber: input.seasonNumber,
      sourceScope: input.sourceScope,
      removalSource: LibraryRemovalSource.MANUAL,
    });
    const now = this.now();
    const delay = getSettings().removal.removalDelayDays * DAY_MS;
    const scheduleValues: Partial<RemovalSchedule> = {
      canonicalMediaId: input.canonicalMediaId,
      targetType: input.targetType,
      seasonNumber: input.seasonNumber ?? null,
      sourceSystem: target.sourceSystem,
      sourceScope: target.sourceScope,
      origin: RemovalScheduleOrigin.MANUAL,
      status: RemovalScheduleStatus.ACTIVE,
      activeKey: activeKey(
        input.canonicalMediaId,
        input.targetType,
        input.seasonNumber,
        target.sourceScope
      ),
      scheduledAt: now,
      removeAt: new Date(now.getTime() + delay),
      activityBaselineAt: null,
    };
    scheduleValues.activityBaselineAt = await this.activityAt(
      new RemovalSchedule(scheduleValues)
    );

    return dataSource.transaction('SERIALIZABLE', async (manager) => {
      const canonicalQuery = manager
        .getRepository(CanonicalMedia)
        .createQueryBuilder('canonical')
        .where('canonical.id = :canonicalMediaId', {
          canonicalMediaId: input.canonicalMediaId,
        });
      if (dataSource.options.type === 'postgres') {
        canonicalQuery.setLock('pessimistic_write');
      }
      await canonicalQuery.getOneOrFail();

      const repository = manager.getRepository(RemovalSchedule);
      const active = await repository.find({
        where: {
          canonicalMediaId: input.canonicalMediaId,
          status: In(ACTIVE_STATUSES),
        },
        order: { id: 'ASC' },
      });
      if (
        await this.hasDurableExecutionClaim(manager, input.canonicalMediaId)
      ) {
        throw new RemovalScheduleConflictError(
          'A removal for this media is currently being processed'
        );
      }
      const exact = active.find(
        (schedule) =>
          schedule.targetType === input.targetType &&
          schedule.seasonNumber === (input.seasonNumber ?? null) &&
          schedule.sourceScope === target.sourceScope
      );
      if (exact)
        return { schedule: exact, created: false, affectedSchedules: 0 };
      if (
        input.targetType === RemovalTargetType.SEASON &&
        active.some(
          (schedule) => schedule.targetType === RemovalTargetType.SERIES
        )
      ) {
        throw new RemovalScheduleConflictError(
          'A whole-Series removal is already scheduled'
        );
      }
      if (input.targetType === RemovalTargetType.SERIES) {
        const children = active.filter(
          (schedule) => schedule.targetType === RemovalTargetType.SEASON
        );
        if (
          children.some((child) => child.leaseUntil && child.leaseUntil > now)
        ) {
          throw new RemovalScheduleConflictError(
            'A Season removal is currently being processed'
          );
        }
        for (const child of children) {
          child.status = RemovalScheduleStatus.CANCELLED;
          child.activeKey = null;
          child.leaseToken = null;
          child.leaseUntil = null;
          child.revision += 1;
        }
        if (children.length > 0) await repository.save(children);
      }
      return {
        schedule: await repository.save(repository.create(scheduleValues)),
        created: true,
        affectedSchedules:
          1 +
          (input.targetType === RemovalTargetType.SERIES
            ? active.filter(
                (schedule) => schedule.targetType === RemovalTargetType.SEASON
              ).length
            : 0),
      };
    });
  }

  public async cancelExactTarget(input: {
    canonicalMediaId: number;
    targetType: RemovalTargetType;
    seasonNumber?: number;
  }): Promise<ExactRemovalScheduleCancellationResult> {
    const now = this.now();
    return dataSource.transaction('SERIALIZABLE', async (manager) => {
      const canonicalQuery = manager
        .getRepository(CanonicalMedia)
        .createQueryBuilder('canonical')
        .where('canonical.id = :canonicalMediaId', {
          canonicalMediaId: input.canonicalMediaId,
        });
      if (dataSource.options.type === 'postgres') {
        canonicalQuery.setLock('pessimistic_write');
      }
      await canonicalQuery.getOneOrFail();

      const repository = manager.getRepository(RemovalSchedule);
      const schedules = await repository.find({
        where: {
          canonicalMediaId: input.canonicalMediaId,
          targetType: input.targetType,
          seasonNumber:
            input.targetType === RemovalTargetType.SEASON
              ? input.seasonNumber
              : IsNull(),
          status: In(ACTIVE_STATUSES),
        },
        order: { sourceScope: 'ASC', id: 'ASC' },
      });
      if (
        await this.hasDurableExecutionClaim(manager, input.canonicalMediaId)
      ) {
        return { affectedSchedules: 0, inProgress: true };
      }
      if (
        schedules.some(
          (schedule) =>
            Boolean(schedule.leaseToken) &&
            Boolean(schedule.leaseUntil && schedule.leaseUntil > now)
        )
      ) {
        return { affectedSchedules: 0, inProgress: true };
      }
      for (const schedule of schedules) {
        schedule.status = RemovalScheduleStatus.CANCELLED;
        schedule.activeKey = null;
        schedule.leaseToken = null;
        schedule.leaseUntil = null;
        schedule.revision += 1;
      }
      if (schedules.length > 0) await repository.save(schedules);
      return {
        affectedSchedules: schedules.length,
        inProgress: false,
      };
    });
  }

  public async cancel(id: number): Promise<RemovalSchedule | null> {
    return this.cancelActionableById(id);
  }

  public async cancelActionableById(
    id: number
  ): Promise<RemovalSchedule | null> {
    const now = this.now();
    return dataSource.transaction('SERIALIZABLE', async (manager) => {
      const repository = manager.getRepository(RemovalSchedule);
      const observed = await repository.findOneBy({ id });
      if (!observed) return null;
      const canonicalQuery = manager
        .getRepository(CanonicalMedia)
        .createQueryBuilder('canonical')
        .where('canonical.id = :canonicalMediaId', {
          canonicalMediaId: observed.canonicalMediaId,
        });
      if (dataSource.options.type === 'postgres') {
        canonicalQuery.setLock('pessimistic_write');
      }
      await canonicalQuery.getOneOrFail();
      const query = repository
        .createQueryBuilder('schedule')
        .where('schedule.id = :id', { id });
      if (dataSource.options.type === 'postgres') {
        query.setLock('pessimistic_write');
      }
      const schedule = await query.getOne();
      if (!schedule || !ACTIVE_STATUSES.includes(schedule.status)) {
        return schedule;
      }
      if (
        await this.hasDurableExecutionClaim(manager, schedule.canonicalMediaId)
      ) {
        throw new RemovalScheduleConflictError(
          'This scheduled removal is currently being processed'
        );
      }
      if (
        schedule.leaseToken &&
        schedule.leaseUntil &&
        schedule.leaseUntil > now
      ) {
        throw new RemovalScheduleConflictError(
          'This scheduled removal is currently being processed'
        );
      }
      schedule.status = RemovalScheduleStatus.CANCELLED;
      schedule.activeKey = null;
      schedule.leaseToken = null;
      schedule.leaseUntil = null;
      schedule.revision += 1;
      return repository.save(schedule);
    });
  }

  public async completeForTarget(input: {
    canonicalMediaId: number;
    targetType: RemovalTargetType;
    seasonNumber?: number;
  }): Promise<number> {
    return dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(RemovalSchedule);
      const schedules = await repository.find({
        where: {
          canonicalMediaId: input.canonicalMediaId,
          status: In(ACTIVE_STATUSES),
        },
      });
      const completedAt = this.now();
      const completed = schedules.filter(
        (item) =>
          (item.targetType === input.targetType &&
            item.seasonNumber === (input.seasonNumber ?? null)) ||
          (input.targetType === RemovalTargetType.SERIES &&
            item.targetType === RemovalTargetType.SEASON)
      );
      for (const schedule of completed) {
        schedule.status = RemovalScheduleStatus.COMPLETED;
        schedule.completedAt = completedAt;
        schedule.activeKey = null;
        schedule.leaseToken = null;
        schedule.leaseUntil = null;
        schedule.revision += 1;
      }
      if (completed.length > 0) await repository.save(completed);
      return completed.length;
    });
  }

  public async leavingSoon(): Promise<RemovalSchedule[]> {
    return getRepository(RemovalSchedule).find({
      where: { status: In(ACTIVE_STATUSES) },
      relations: { canonicalMedia: true },
      order: { removeAt: 'ASC', id: 'ASC' },
    });
  }

  public async preview(
    settings: RemovalSettings
  ): Promise<RemovalPreviewResult> {
    const candidates = await this.candidates();
    const active = await this.leavingSoon();
    const safeCandidates = candidates.filter(
      (candidate) =>
        hasExactRemovalTarget(candidate) && acquisitionInactive(candidate)
    );
    const now = this.now();
    const previewPool = (mediaType: 'movie' | 'series') => {
      const bounds = currentMonthBounds(candidates, mediaType, now);
      const policy = { ...settings[mediaType], enabled: true };
      const plan = planAutomaticRemovalPool({
        mediaType,
        candidates: safeCandidates,
        active,
        policy,
        now,
      });
      return {
        eligibleUnscheduled: plan.eligibleUnscheduledCount,
        itemsPerRun: policy.itemsPerRun,
        oldestCurrentAddedAt:
          bounds.oldestCurrentAddedAt?.toISOString() ?? null,
        maximumSelectableMonths: bounds.maximumSelectableMonths,
        candidates: plan.selected.map((candidate) => ({
          canonicalMediaId: candidate.canonicalMediaId,
          title: candidate.title,
          year: candidate.year,
          addedAt: candidate.addedAt.toISOString(),
          lastActiveAt: candidate.lastActiveAt?.toISOString() ?? null,
        })),
      };
    };
    return {
      actionableScheduleCount: active.length,
      movie: previewPool('movie'),
      series: previewPool('series'),
    };
  }

  private async reconcileActivity(): Promise<number> {
    const schedules = await this.leavingSoon();
    let cancelled = 0;
    for (const schedule of schedules) {
      const activityAt = await this.activityAt(schedule);
      if (activityAt && activityAt > schedule.scheduledAt) {
        await this.cancel(schedule.id);
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private async executeDue(): Promise<{
    completed: number;
    deferred: number;
    failed: number;
  }> {
    const repository = getRepository(RemovalSchedule);
    const due = await repository.find({
      where: {
        status: In(ACTIVE_STATUSES),
        removeAt: LessThanOrEqual(this.now()),
      },
      order: { removeAt: 'ASC', id: 'ASC' },
    });
    let completed = 0;
    let deferred = 0;
    let failed = 0;
    for (const schedule of due) {
      const result = await this.scheduledExecutor.execute(schedule);
      if (result === 'completed') completed += 1;
      if (result === 'deferred') deferred += 1;
      if (result === 'failed') failed += 1;
    }
    return { completed, deferred, failed };
  }

  private async fillPool(
    mediaType: 'movie' | 'series',
    candidates: RemovalCandidate[],
    active: RemovalSchedule[],
    acquisitionAuthoritative: boolean,
    settings: RemovalSettings
  ): Promise<RemovalSelectionPool> {
    const policy = {
      ...settings[mediaType],
      enabled: settings.removalScanEnabled && settings[mediaType].enabled,
    };
    const now = this.now();
    const safeCandidates = candidates.filter(
      (candidate) =>
        acquisitionAuthoritative &&
        acquisitionInactive(candidate) &&
        hasExactRemovalTarget(candidate)
    );
    const plan = planAutomaticRemovalPool({
      mediaType,
      candidates: safeCandidates,
      active,
      policy,
      now,
    });
    const repository = getRepository(RemovalSchedule);
    const createdCandidateIds: number[] = [];
    for (const candidate of plan.selected) {
      const targetType =
        mediaType === 'movie'
          ? RemovalTargetType.MOVIE
          : RemovalTargetType.SERIES;
      const schedule = repository.create({
        canonicalMediaId: candidate.canonicalMediaId,
        targetType,
        seasonNumber: null,
        sourceSystem: candidate.sourceSystem,
        sourceScope: candidate.sourceScope,
        origin: RemovalScheduleOrigin.AUTOMATIC,
        status: RemovalScheduleStatus.ACTIVE,
        activeKey: activeKey(
          candidate.canonicalMediaId,
          targetType,
          undefined,
          candidate.sourceScope
        ),
        scheduledAt: now,
        removeAt: new Date(now.getTime() + settings.removalDelayDays * DAY_MS),
        activityBaselineAt: candidate.lastActiveAt,
      });
      try {
        await repository.save(schedule);
        createdCandidateIds.push(candidate.canonicalMediaId);
      } catch {
        logger.debug('Concurrent removal schedule already exists', {
          label: 'Removal Scheduler',
          canonicalMediaId: candidate.canonicalMediaId,
        });
      }
    }
    return {
      eligibleUnscheduled: plan.eligibleUnscheduledCount,
      itemsPerRun: policy.itemsPerRun,
      selectedCandidates: createdCandidateIds,
    };
  }

  private async selectCandidatesInternal(): Promise<CandidateSelectionResult> {
    const settings = getSettings().removal;
    const candidates = await this.candidates();
    const active = await this.leavingSoon();
    const automaticEnabled =
      settings.removalScanEnabled &&
      (settings.movie.enabled || settings.series.enabled);
    let acquisitionAuthoritative = !automaticEnabled;
    if (automaticEnabled) {
      try {
        acquisitionAuthoritative = (
          await acquisitionMonitor.refresh('background')
        ).authoritative;
      } catch {
        acquisitionAuthoritative = false;
      }
    }
    const movie = await this.fillPool(
      'movie',
      candidates,
      active,
      acquisitionAuthoritative,
      settings
    );
    const refreshedActive = await this.leavingSoon();
    const series = await this.fillPool(
      'series',
      candidates,
      refreshedActive,
      acquisitionAuthoritative,
      settings
    );
    return { movie, series };
  }

  public runCandidateSelection(): Promise<CandidateSelectionResult> {
    if (this.clearingSchedules)
      throw new RemovalScheduleConflictError(
        'Scheduled removals are currently being cleared'
      );
    if (this.candidateSelectionRunning) return this.candidateSelectionRunning;
    this.candidateSelectionRunning = this.selectCandidatesInternal().finally(
      () => (this.candidateSelectionRunning = undefined)
    );
    return this.candidateSelectionRunning;
  }

  private async processScheduledRemovalsInternal(): Promise<ScheduledRemovalProcessingResult> {
    await this.scheduledExecutor.recover();
    const cancelledForActivity = await this.reconcileActivity();
    const execution = await this.executeDue();
    return { ...execution, cancelledForActivity };
  }

  public runScheduledRemovalProcessing(): Promise<ScheduledRemovalProcessingResult> {
    if (this.clearingSchedules)
      throw new RemovalScheduleConflictError(
        'Scheduled removals are currently being cleared'
      );
    if (this.scheduledRemovalProcessingRunning)
      return this.scheduledRemovalProcessingRunning;
    this.scheduledRemovalProcessingRunning =
      this.processScheduledRemovalsInternal().finally(
        () => (this.scheduledRemovalProcessingRunning = undefined)
      );
    return this.scheduledRemovalProcessingRunning;
  }

  public async clearAllScheduledRemovals(): Promise<{ cancelled: number }> {
    if (
      this.clearingSchedules ||
      this.candidateSelectionRunning ||
      this.scheduledRemovalProcessingRunning
    ) {
      throw new RemovalScheduleConflictError(
        'A removal scheduling operation is already running'
      );
    }
    this.clearingSchedules = true;
    try {
      return await clearAllScheduledRemovalRecords(dataSource, this.now());
    } finally {
      this.clearingSchedules = false;
    }
  }

  public isCandidateSelectionRunning(): boolean {
    return Boolean(this.candidateSelectionRunning);
  }

  public isScheduledRemovalProcessingRunning(): boolean {
    return Boolean(this.scheduledRemovalProcessingRunning);
  }
}

const removalScheduler = new RemovalScheduler();
export default removalScheduler;
