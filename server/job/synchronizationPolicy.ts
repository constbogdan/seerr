import type {
  SynchronizationContainmentStatus,
  SynchronizationMode,
} from '@server/interfaces/api/settingsInterfaces';
import type { JobId } from '@server/lib/settings';
import logger from '@server/logger';

export const SYNCHRONIZATION_MODE_ENVIRONMENT_VARIABLE =
  'SEERR_SYNCHRONIZATION_MODE';

export const COMMISSIONING_JOB_SEQUENCE = [
  'library-history-hydration',
  'current-jellyfin-viewing-sync',
  'watchlist-play-state-sync',
  'fresh-sync',
] as const satisfies readonly JobId[];

type CommissioningJobId = (typeof COMMISSIONING_JOB_SEQUENCE)[number];

export class SynchronizationExecutionBlockedError extends Error {
  public readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'SynchronizationExecutionBlockedError';
  }
}

export const parseSynchronizationMode = (
  value: string | undefined
): SynchronizationMode => {
  if (value === undefined) return 'normal';
  if (
    value === 'normal' ||
    value === 'contained' ||
    value === 'commissioning'
  ) {
    return value;
  }
  throw new Error(
    `${SYNCHRONIZATION_MODE_ENVIRONMENT_VARIABLE} must be exactly one of normal, contained, or commissioning; received ${JSON.stringify(
      value
    )}.`
  );
};

const isCommissioningJob = (jobId: JobId): jobId is CommissioningJobId =>
  COMMISSIONING_JOB_SEQUENCE.includes(jobId as CommissioningJobId);

export class SynchronizationPolicy {
  private commissioningIndex = 0;
  private activeCommissioningJob?: CommissioningJobId;
  private readonly completedCommissioningJobs: CommissioningJobId[] = [];
  private lastFailedCommissioningJob?: CommissioningJobId;
  private readonly loggedScheduledSuppressions = new Set<JobId>();

  constructor(public readonly mode: SynchronizationMode) {}

  public get startupCatchUpsAllowed(): boolean {
    return this.mode === 'normal';
  }

  public get scheduledExecutionAllowed(): boolean {
    return this.mode === 'normal';
  }

  public get manualSynchronizationAllowed(): boolean {
    return this.mode !== 'contained';
  }

  public status(freshSyncEnabled: boolean): SynchronizationContainmentStatus {
    return {
      mode: this.mode,
      startupCatchUpsAllowed: this.startupCatchUpsAllowed,
      scheduledExecutionAllowed: this.scheduledExecutionAllowed,
      manualSynchronizationAllowed: this.manualSynchronizationAllowed,
      manualExecutionPolicy:
        this.mode === 'normal'
          ? 'all'
          : this.mode === 'contained'
            ? 'blocked'
            : 'commissioning-sequence',
      restartRequired: true,
      commissioning:
        this.mode === 'commissioning'
          ? {
              activeJobId: this.activeCommissioningJob ?? null,
              nextRequiredJobId:
                COMMISSIONING_JOB_SEQUENCE[this.commissioningIndex] ?? null,
              completedJobIds: [...this.completedCommissioningJobs],
              lastFailedJobId: this.lastFailedCommissioningJob ?? null,
              freshSyncEnabled,
            }
          : null,
    };
  }

  public manualExecutionAllowed(
    jobId: JobId,
    freshSyncEnabled: boolean
  ): boolean {
    if (this.mode === 'normal') return true;
    if (this.mode === 'contained' || this.activeCommissioningJob) return false;
    if (!isCommissioningJob(jobId)) return false;
    if (
      jobId === 'fresh-sync' &&
      (!freshSyncEnabled ||
        COMMISSIONING_JOB_SEQUENCE[this.commissioningIndex] !== 'fresh-sync')
    ) {
      return false;
    }
    return COMMISSIONING_JOB_SEQUENCE[this.commissioningIndex] === jobId;
  }

  public executeScheduled<T>(jobId: JobId, execute: () => T): T | undefined {
    if (this.scheduledExecutionAllowed) return execute();
    if (!this.loggedScheduledSuppressions.has(jobId)) {
      this.loggedScheduledSuppressions.add(jobId);
      logger.info('Suppressed scheduled job due to synchronization mode', {
        label: 'Synchronization Containment',
        jobId,
        mode: this.mode,
      });
    }
    return undefined;
  }

  public assertDirectManualExecutionAllowed(): void {
    if (this.mode !== 'normal') {
      throw new SynchronizationExecutionBlockedError(
        `Direct synchronization is unavailable while ${SYNCHRONIZATION_MODE_ENVIRONMENT_VARIABLE}=${this.mode}.`
      );
    }
  }

  public startCommissioningJob(
    jobId: JobId,
    freshSyncEnabled: boolean,
    execute: () => Promise<unknown>
  ): void {
    if (this.mode !== 'commissioning') {
      throw new SynchronizationExecutionBlockedError(
        'Commissioning execution is only available in commissioning mode.'
      );
    }
    if (!isCommissioningJob(jobId)) {
      throw new SynchronizationExecutionBlockedError(
        `${jobId} is not permitted during synchronization commissioning.`
      );
    }
    if (this.activeCommissioningJob) {
      throw new SynchronizationExecutionBlockedError(
        `${this.activeCommissioningJob} must finish before another commissioning job starts.`
      );
    }
    const requiredJob = COMMISSIONING_JOB_SEQUENCE[this.commissioningIndex];
    if (requiredJob !== jobId) {
      throw new SynchronizationExecutionBlockedError(
        requiredJob
          ? `${requiredJob} must complete successfully before ${jobId} can run.`
          : 'The commissioning synchronization sequence is already complete.'
      );
    }
    if (jobId === 'fresh-sync' && !freshSyncEnabled) {
      throw new SynchronizationExecutionBlockedError(
        'Fresh Sync is unavailable because Fresh is disabled.'
      );
    }

    this.activeCommissioningJob = jobId;
    this.lastFailedCommissioningJob = undefined;
    let execution: Promise<unknown>;
    try {
      execution = execute();
    } catch (error) {
      this.activeCommissioningJob = undefined;
      this.lastFailedCommissioningJob = jobId;
      throw error;
    }

    void execution.then(
      () => {
        if (this.activeCommissioningJob !== jobId) return;
        this.completedCommissioningJobs.push(jobId);
        this.commissioningIndex += 1;
        this.activeCommissioningJob = undefined;
        logger.info('Commissioning synchronization phase completed', {
          label: 'Synchronization Containment',
          jobId,
        });
      },
      (error: unknown) => {
        if (this.activeCommissioningJob !== jobId) return;
        this.activeCommissioningJob = undefined;
        this.lastFailedCommissioningJob = jobId;
        logger.error('Commissioning synchronization phase failed', {
          label: 'Synchronization Containment',
          jobId,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    );
  }
}

export const synchronizationPolicy = new SynchronizationPolicy(
  parseSynchronizationMode(
    process.env[SYNCHRONIZATION_MODE_ENVIRONMENT_VARIABLE]
  )
);

export const logSynchronizationMode = (): void => {
  logger.info('Synchronization execution mode initialized', {
    label: 'Synchronization Containment',
    mode: synchronizationPolicy.mode,
    startupCatchUpsAllowed: synchronizationPolicy.startupCatchUpsAllowed,
    scheduledExecutionAllowed: synchronizationPolicy.scheduledExecutionAllowed,
    restartRequired: true,
  });
};
