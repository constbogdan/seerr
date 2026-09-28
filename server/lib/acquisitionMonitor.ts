import downloadTracker, {
  type ConfirmedServarrImport,
  type DownloadTrackerUpdateOutcome,
} from '@server/lib/downloadtracker';
import jellyfinAvailabilityReconciler from '@server/lib/jellyfinAvailabilityReconciler';
import logger from '@server/logger';

export enum AcquisitionMonitorState {
  IDLE = 'IDLE',
  WARM = 'WARM',
  ACTIVE = 'ACTIVE',
  COOLDOWN = 'COOLDOWN',
}

export type AcquisitionRefreshSource = 'adaptive' | 'background' | 'reset';
export type AcquisitionWakeReason = 'seerr-request';

export const ACQUISITION_ACTIVE_INTERVAL_MS = 15_000;
// Five background-sync periods cover ordinary Servarr search/grab latency while
// bounding no-release polling to twenty active-cadence observations per wake.
export const ACQUISITION_WARM_DURATION_MS = 5 * 60_000;
// One additional authoritative empty refresh observes final queue/import settling.
export const ACQUISITION_COOLDOWN_EMPTY_CONFIRMATIONS = 1;
export const ACQUISITION_FAILURE_BACKOFF_BASE_MS = 15_000;
export const ACQUISITION_FAILURE_BACKOFF_MAX_MS = 60_000;

interface AcquisitionTracker {
  updateDownloads(): Promise<DownloadTrackerUpdateOutcome>;
  resetDownloadTracker(): Promise<void>;
}

interface AcquisitionMonitorOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  onConfirmedImports?: (
    imports: ConfirmedServarrImport[]
  ) => Promise<void> | void;
}

export interface AcquisitionMonitorStatus {
  state: AcquisitionMonitorState;
  refreshing: boolean;
  lastWakeReason?: AcquisitionWakeReason;
  lastRefreshSource?: AcquisitionRefreshSource;
  lastRefreshStartedAt?: string;
  lastRefreshCompletedAt?: string;
  lastSuccessfulRefreshAt?: string;
  lastFailedRefreshAt?: string;
  lastRefreshDurationMs?: number;
  lastQueueCount?: number;
  consecutiveFailures: number;
  cadenceMs?: number;
  nextRunAt?: string;
}

export class AcquisitionMonitor {
  private state = AcquisitionMonitorState.IDLE;
  private refreshPromise?: Promise<DownloadTrackerUpdateOutcome>;
  private timer?: NodeJS.Timeout;
  private warmUntil = 0;
  private wakeSequence = 0;
  private consumedWakeSequence = 0;
  private cooldownEmptyConfirmations = 0;
  private lastWakeReason?: AcquisitionWakeReason;
  private lastRefreshSource?: AcquisitionRefreshSource;
  private lastRefreshStartedAt?: number;
  private lastRefreshCompletedAt?: number;
  private lastSuccessfulRefreshAt?: number;
  private lastFailedRefreshAt?: number;
  private lastRefreshDurationMs?: number;
  private lastQueueCount?: number;
  private consecutiveFailures = 0;
  private cadenceMs?: number;
  private nextRunAt?: number;
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delay: number
  ) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly onConfirmedImports?: AcquisitionMonitorOptions['onConfirmedImports'];

  constructor(
    private readonly tracker: AcquisitionTracker,
    options: AcquisitionMonitorOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onConfirmedImports = options.onConfirmedImports;
  }

  public wake(reason: AcquisitionWakeReason): void {
    const now = this.now();
    this.wakeSequence += 1;
    this.lastWakeReason = reason;
    this.warmUntil = Math.max(
      this.warmUntil,
      now + ACQUISITION_WARM_DURATION_MS
    );

    if (
      this.state === AcquisitionMonitorState.IDLE ||
      this.state === AcquisitionMonitorState.COOLDOWN
    ) {
      this.transition(AcquisitionMonitorState.WARM);
    }

    logger.info('Adaptive acquisition monitor wake requested', {
      label: 'Acquisition Monitor',
      reason,
      state: this.state,
    });

    if (!this.refreshPromise) {
      this.schedule(0);
    }
  }

  public refresh(
    source: AcquisitionRefreshSource
  ): Promise<DownloadTrackerUpdateOutcome> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.cancelTimer();
    const startedAt = this.now();
    const wakeSequenceAtStart = this.wakeSequence;
    this.lastRefreshSource = source;
    this.lastRefreshStartedAt = startedAt;

    const refreshPromise = this.runRefresh(
      source,
      startedAt,
      wakeSequenceAtStart
    ).finally(() => {
      if (this.refreshPromise === refreshPromise) {
        this.refreshPromise = undefined;
      }
    });
    this.refreshPromise = refreshPromise;

    return refreshPromise;
  }

  public async resetAndReconcile(): Promise<DownloadTrackerUpdateOutcome> {
    if (this.refreshPromise) {
      try {
        await this.refreshPromise;
      } catch {
        // The reset still requires a fresh authoritative reconciliation after
        // an in-flight failure; runRefresh has already recorded that failure.
      }
    }
    await this.tracker.resetDownloadTracker();
    return this.refresh('reset');
  }

  public getStatus(): AcquisitionMonitorStatus {
    return {
      state: this.state,
      refreshing: !!this.refreshPromise,
      lastWakeReason: this.lastWakeReason,
      lastRefreshSource: this.lastRefreshSource,
      lastRefreshStartedAt: this.toISOString(this.lastRefreshStartedAt),
      lastRefreshCompletedAt: this.toISOString(this.lastRefreshCompletedAt),
      lastSuccessfulRefreshAt: this.toISOString(this.lastSuccessfulRefreshAt),
      lastFailedRefreshAt: this.toISOString(this.lastFailedRefreshAt),
      lastRefreshDurationMs: this.lastRefreshDurationMs,
      lastQueueCount: this.lastQueueCount,
      consecutiveFailures: this.consecutiveFailures,
      cadenceMs: this.cadenceMs,
      nextRunAt: this.toISOString(this.nextRunAt),
    };
  }

  private async runRefresh(
    source: AcquisitionRefreshSource,
    startedAt: number,
    wakeSequenceAtStart: number
  ): Promise<DownloadTrackerUpdateOutcome> {
    try {
      const outcome = await this.tracker.updateDownloads();
      const completedAt = this.now();
      this.lastRefreshCompletedAt = completedAt;
      this.lastRefreshDurationMs = completedAt - startedAt;
      this.lastQueueCount = outcome.queueCount;

      if (outcome.providersFailed > 0) {
        this.consecutiveFailures += 1;
        this.lastFailedRefreshAt = completedAt;
      } else {
        this.consecutiveFailures = 0;
      }
      if (outcome.providersSucceeded > 0 || outcome.providersAttempted === 0) {
        this.lastSuccessfulRefreshAt = completedAt;
      }

      this.applyOutcome(outcome, completedAt, wakeSequenceAtStart);
      if (outcome.confirmedImports?.length && this.onConfirmedImports) {
        void Promise.resolve(
          this.onConfirmedImports(outcome.confirmedImports)
        ).catch((error) => {
          logger.error(
            'Unable to request Jellyfin availability reconciliation',
            {
              label: 'Acquisition Monitor',
              imports: outcome.confirmedImports?.length,
              errorType: error instanceof Error ? error.name : 'UnknownError',
            }
          );
        });
      }
      const delay = this.nextDelay(outcome);
      if (delay !== undefined) {
        this.schedule(delay);
      }

      logger.debug('Adaptive acquisition monitor refresh completed', {
        label: 'Acquisition Monitor',
        source,
        state: this.state,
        queueCount: outcome.queueCount,
        changed: outcome.changed,
        providersAttempted: outcome.providersAttempted,
        providersSucceeded: outcome.providersSucceeded,
        providersFailed: outcome.providersFailed,
        consecutiveFailures: this.consecutiveFailures,
        durationMs: this.lastRefreshDurationMs,
        cadenceMs: delay,
        nextRunAt: this.toISOString(this.nextRunAt),
      });

      return outcome;
    } catch (error) {
      const completedAt = this.now();
      this.lastRefreshCompletedAt = completedAt;
      this.lastFailedRefreshAt = completedAt;
      this.lastRefreshDurationMs = completedAt - startedAt;
      this.consecutiveFailures += 1;
      const delay =
        this.state === AcquisitionMonitorState.IDLE
          ? undefined
          : this.failureBackoff();
      if (delay !== undefined) {
        this.schedule(delay);
      }

      logger.error('Adaptive acquisition monitor refresh failed', {
        label: 'Acquisition Monitor',
        source,
        state: this.state,
        durationMs: this.lastRefreshDurationMs,
        consecutiveFailures: this.consecutiveFailures,
        cadenceMs: delay,
        nextRunAt: this.toISOString(this.nextRunAt),
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });

      throw error;
    }
  }

  private applyOutcome(
    outcome: DownloadTrackerUpdateOutcome,
    completedAt: number,
    wakeSequenceAtStart: number
  ): void {
    if (outcome.queueCount > 0) {
      this.consumedWakeSequence = Math.max(
        this.consumedWakeSequence,
        wakeSequenceAtStart
      );
      this.transition(AcquisitionMonitorState.ACTIVE);
      return;
    }

    if (!outcome.authoritative) {
      return;
    }

    switch (this.state) {
      case AcquisitionMonitorState.WARM:
        this.transition(
          completedAt < this.warmUntil
            ? AcquisitionMonitorState.WARM
            : AcquisitionMonitorState.COOLDOWN
        );
        break;
      case AcquisitionMonitorState.ACTIVE:
        this.transition(
          this.wakeSequence > this.consumedWakeSequence &&
            completedAt < this.warmUntil
            ? AcquisitionMonitorState.WARM
            : AcquisitionMonitorState.COOLDOWN
        );
        break;
      case AcquisitionMonitorState.COOLDOWN:
        this.cooldownEmptyConfirmations += 1;
        if (
          this.cooldownEmptyConfirmations >=
          ACQUISITION_COOLDOWN_EMPTY_CONFIRMATIONS
        ) {
          this.transition(AcquisitionMonitorState.IDLE);
        }
        break;
      case AcquisitionMonitorState.IDLE:
        break;
    }
  }

  private nextDelay(outcome: DownloadTrackerUpdateOutcome): number | undefined {
    if (outcome.providersFailed > 0) {
      return this.state === AcquisitionMonitorState.IDLE
        ? undefined
        : this.failureBackoff();
    }

    if (this.state === AcquisitionMonitorState.IDLE) {
      return undefined;
    }

    return ACQUISITION_ACTIVE_INTERVAL_MS;
  }

  private failureBackoff(): number {
    return Math.min(
      ACQUISITION_FAILURE_BACKOFF_BASE_MS *
        2 ** Math.max(0, this.consecutiveFailures - 1),
      ACQUISITION_FAILURE_BACKOFF_MAX_MS
    );
  }

  private schedule(delay: number): void {
    this.cancelTimer();
    this.cadenceMs = delay;
    this.nextRunAt = this.now() + delay;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.nextRunAt = undefined;
      void this.refresh('adaptive').catch(() => undefined);
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.cadenceMs = undefined;
    this.nextRunAt = undefined;
  }

  private transition(nextState: AcquisitionMonitorState): void {
    if (this.state === nextState) {
      return;
    }

    const previousState = this.state;
    this.state = nextState;
    if (nextState !== AcquisitionMonitorState.COOLDOWN) {
      this.cooldownEmptyConfirmations = 0;
    } else if (previousState !== AcquisitionMonitorState.COOLDOWN) {
      this.cooldownEmptyConfirmations = 0;
    }
    logger.info('Adaptive acquisition monitor state changed', {
      label: 'Acquisition Monitor',
      previousState,
      state: nextState,
    });
  }

  private toISOString(value?: number): string | undefined {
    return value === undefined ? undefined : new Date(value).toISOString();
  }
}

const acquisitionMonitor = new AcquisitionMonitor(downloadTracker, {
  onConfirmedImports: (imports) =>
    jellyfinAvailabilityReconciler.request(imports),
});

export default acquisitionMonitor;
