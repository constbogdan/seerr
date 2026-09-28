import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import downloadTracker, {
  type ConfirmedServarrImport,
  type EpisodeNumberResult,
  type FinalizingAcquisitionTarget,
} from '@server/lib/downloadtracker';
import jellyfinTargetedAvailability, {
  type JellyfinTargetedMediaTarget,
  type TargetedReadiness,
} from '@server/lib/jellyfinTargetedAvailability';
import logger from '@server/logger';

export const JELLYFIN_RECONCILIATION_DEBOUNCE_MS = 5_000;
export const JELLYFIN_RECONCILIATION_RETRY_INTERVAL_MS = 15_000;
export const JELLYFIN_RECONCILIATION_ACTIVE_WINDOW_MS = 4 * 60_000;
export const JELLYFIN_RECONCILIATION_CONCURRENCY = 3;
const COMPLETED_GENERATION_CACHE_LIMIT = 1_000;

export interface JellyfinAvailabilityTarget extends JellyfinTargetedMediaTarget {
  presentationTargets: FinalizingAcquisitionTarget[];
}

interface PendingTarget extends JellyfinAvailabilityTarget {
  attempts: number;
  phaseStartedAt: string;
  nextAttemptAt: number;
  expiresAt: number;
  revision: number;
}

interface PendingSnapshot extends JellyfinAvailabilityTarget {
  key: string;
  revision: number;
}

interface FinalizingPresentation {
  startFinalizing(
    target: FinalizingAcquisitionTarget,
    phaseStartedAt: string
  ): void;
  clearFinalizing(target: FinalizingAcquisitionTarget): void;
}

interface ReconcilerOptions {
  resolveImports?: (
    imports: ConfirmedServarrImport[]
  ) => Promise<JellyfinAvailabilityTarget[]>;
  reconcileTarget?: (
    target: JellyfinTargetedMediaTarget
  ) => Promise<TargetedReadiness>;
  setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  now?: () => number;
  presentation?: FinalizingPresentation;
  concurrency?: number;
}

const presentationKey = (target: FinalizingAcquisitionTarget): string =>
  `${target.serverId}:${target.downloadId}`;

const episodeKey = (episode: EpisodeNumberResult): string =>
  `${episode.seasonNumber}:${episode.episodeNumber}:${episode.id}`;

const targetKey = (target: JellyfinAvailabilityTarget): string => {
  const downloadIds = [
    ...new Set(target.presentationTargets.map((item) => item.downloadId)),
  ].sort();
  return `${target.mediaId}:${target.is4k ? '4k' : 'standard'}:${downloadIds.join(',')}`;
};

const completedGenerationKey = (target: JellyfinAvailabilityTarget): string =>
  `${targetKey(target)}:${target.episodes.map(episodeKey).sort().join(',')}`;

const mergeTargets = (
  current: JellyfinAvailabilityTarget | undefined,
  incoming: JellyfinAvailabilityTarget
): JellyfinAvailabilityTarget => ({
  ...incoming,
  episodes: [
    ...new Map(
      [...(current?.episodes ?? []), ...incoming.episodes].map((episode) => [
        episodeKey(episode),
        episode,
      ])
    ).values(),
  ],
  presentationTargets: [
    ...new Map(
      [
        ...(current?.presentationTargets ?? []),
        ...incoming.presentationTargets,
      ].map((target) => [presentationKey(target), target])
    ).values(),
  ],
});

const resolveImports = async (
  imports: ConfirmedServarrImport[]
): Promise<JellyfinAvailabilityTarget[]> => {
  const mediaRepository = getRepository(Media);
  const targets = new Map<string, JellyfinAvailabilityTarget>();

  for (const imported of imports) {
    for (const alias of imported.serverAliases) {
      const media = await mediaRepository.findOne({
        where: alias.is4k
          ? {
              mediaType: imported.mediaType,
              serviceId4k: alias.id,
              externalServiceId4k: imported.externalId,
            }
          : {
              mediaType: imported.mediaType,
              serviceId: alias.id,
              externalServiceId: imported.externalId,
            },
        relations: { seasons: true },
      });
      if (!media) continue;

      const target: JellyfinAvailabilityTarget = {
        mediaId: media.id,
        mediaType: imported.mediaType,
        is4k: alias.is4k,
        tmdbId: media.tmdbId,
        tvdbId: media.tvdbId,
        imdbId: media.imdbId,
        jellyfinMediaId: alias.is4k
          ? (media.jellyfinMediaId4k ?? undefined)
          : (media.jellyfinMediaId ?? undefined),
        episodes: imported.episodes,
        presentationTargets: [
          {
            mediaType: imported.mediaType,
            externalId: imported.externalId,
            downloadId: imported.downloadId,
            serverId: alias.id,
            is4k: alias.is4k,
            episodes: imported.episodes,
          },
        ],
      };
      const key = targetKey(target);
      targets.set(key, mergeTargets(targets.get(key), target));
    }
  }

  return [...targets.values()];
};

export class JellyfinAvailabilityReconciler {
  private readonly pending = new Map<string, PendingTarget>();
  private readonly completedGenerations = new Set<string>();
  private timer?: NodeJS.Timeout;
  private timerDueAt?: number;
  private activeRun?: Promise<void>;
  private readonly resolveImports: NonNullable<
    ReconcilerOptions['resolveImports']
  >;
  private readonly reconcileTarget: NonNullable<
    ReconcilerOptions['reconcileTarget']
  >;
  private readonly setTimer: NonNullable<ReconcilerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<ReconcilerOptions['clearTimer']>;
  private readonly now: NonNullable<ReconcilerOptions['now']>;
  private readonly presentation: FinalizingPresentation;
  private readonly concurrency: number;

  constructor(options: ReconcilerOptions = {}) {
    this.resolveImports = options.resolveImports ?? resolveImports;
    this.reconcileTarget =
      options.reconcileTarget ??
      ((target) => jellyfinTargetedAvailability.reconcile(target));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.now = options.now ?? Date.now;
    this.presentation = options.presentation ?? downloadTracker;
    this.concurrency = Math.max(
      1,
      options.concurrency ?? JELLYFIN_RECONCILIATION_CONCURRENCY
    );
  }

  public async request(imports: ConfirmedServarrImport[]): Promise<void> {
    const targets = await this.resolveImports(imports);
    const requestedAt = this.now();
    let targetsAdded = 0;

    for (const target of targets) {
      const key = targetKey(target);
      if (this.completedGenerations.has(completedGenerationKey(target))) {
        continue;
      }
      targetsAdded += 1;
      const existing = this.pending.get(key);
      const merged = mergeTargets(existing, target);
      const pendingTarget: PendingTarget = {
        ...merged,
        attempts: existing?.attempts ?? 0,
        phaseStartedAt:
          existing?.phaseStartedAt ?? new Date(requestedAt).toISOString(),
        nextAttemptAt:
          existing?.nextAttemptAt ??
          requestedAt + JELLYFIN_RECONCILIATION_DEBOUNCE_MS,
        expiresAt:
          existing?.expiresAt ??
          requestedAt + JELLYFIN_RECONCILIATION_ACTIVE_WINDOW_MS,
        revision: (existing?.revision ?? 0) + 1,
      };
      this.pending.set(key, pendingTarget);
      for (const presentationTarget of pendingTarget.presentationTargets) {
        this.presentation.startFinalizing(
          presentationTarget,
          pendingTarget.phaseStartedAt
        );
      }
    }

    if (targetsAdded) {
      logger.info('Targeted Jellyfin availability reconciliation requested', {
        label: 'Jellyfin Availability Reconciler',
        importedAcquisitions: imports.length,
        targetsAdded,
        pendingTargets: this.pending.size,
      });
      this.scheduleNext();
    }
  }

  public getStatus(): { pendingTargets: number; running: boolean } {
    return { pendingTargets: this.pending.size, running: !!this.activeRun };
  }

  private scheduleNext(): void {
    if (this.activeRun || !this.pending.size) return;
    this.expireTargets();
    if (!this.pending.size) return;

    const dueAt = Math.min(
      ...[...this.pending.values()].flatMap((target) => [
        target.nextAttemptAt,
        target.expiresAt,
      ])
    );
    if (
      this.timer &&
      this.timerDueAt !== undefined &&
      this.timerDueAt <= dueAt
    ) {
      return;
    }
    if (this.timer) this.clearTimer(this.timer);

    this.timerDueAt = dueAt;
    this.timer = this.setTimer(
      () => {
        this.timer = undefined;
        this.timerDueAt = undefined;
        void this.run();
      },
      Math.max(0, dueAt - this.now())
    );
  }

  private run(): Promise<void> {
    if (this.activeRun) return this.activeRun;
    this.expireTargets();
    const now = this.now();
    const due = [...this.pending.entries()]
      .filter(([, target]) => target.nextAttemptAt <= now)
      .map(([key, target]) => ({
        ...target,
        key,
        revision: target.revision,
      }));
    if (!due.length) {
      this.scheduleNext();
      return Promise.resolve();
    }

    const run = this.reconcile(due).finally(() => {
      if (this.activeRun === run) this.activeRun = undefined;
      this.scheduleNext();
    });
    this.activeRun = run;
    return run;
  }

  private async reconcile(targets: PendingSnapshot[]): Promise<void> {
    logger.debug('Starting targeted Jellyfin availability reconciliation', {
      label: 'Jellyfin Availability Reconciler',
      targets: targets.length,
      concurrency: this.concurrency,
    });

    let cursor = 0;
    let resolved = 0;
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const target = targets[cursor++];
        const startedAt = this.now();
        const result = await this.reconcileTarget(target);
        const completedAt = this.now();
        const current = this.pending.get(target.key);

        // A repeated import notification can update the target while a lookup is
        // in flight. Only the generation that was actually inspected may clear
        // or advance that target.
        if (!current || current.revision !== target.revision) continue;

        if (result.state === 'ready') {
          this.rememberCompletedGeneration(completedGenerationKey(current));
          this.clearTarget(target.key, current);
          resolved += 1;
        } else {
          current.attempts += 1;
          current.nextAttemptAt =
            completedAt + JELLYFIN_RECONCILIATION_RETRY_INTERVAL_MS;
        }

        logger.debug('Targeted Jellyfin availability attempt completed', {
          label: 'Jellyfin Availability Reconciler',
          mediaId: target.mediaId,
          mediaType: target.mediaType,
          is4k: target.is4k,
          state: result.state,
          ...(result.state !== 'ready' && { reason: result.reason }),
          ...(result.state === 'unknown' && {
            errorType: result.errorType,
          }),
          lookupMethod: result.lookupMethod,
          jellyfinRequestCount: result.jellyfinRequestCount,
          lookupDurationMs: result.lookupDurationMs,
          ...(result.state === 'ready' && {
            processingDurationMs: result.processingDurationMs,
          }),
          targetSatisfied: result.state === 'ready',
          ...(result.state !== 'ready' && {
            nextRetryAt: new Date(current.nextAttemptAt).toISOString(),
          }),
          attemptDurationMs: completedAt - startedAt,
          attempt: current.attempts,
        });
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, targets.length) }, () =>
        worker()
      )
    );
    this.expireTargets();

    const completionDetails = {
      label: 'Jellyfin Availability Reconciler',
      targetsAttempted: targets.length,
      targetsResolved: resolved,
      pendingTargets: this.pending.size,
    };
    if (resolved > 0) {
      logger.info(
        'Targeted Jellyfin availability reconciliation established availability',
        completionDetails
      );
    } else {
      logger.debug(
        'Targeted Jellyfin availability reconciliation completed',
        completionDetails
      );
    }
  }

  private expireTargets(): void {
    const now = this.now();
    for (const [key, target] of this.pending) {
      if (target.expiresAt > now) continue;
      this.clearTarget(key, target);
      logger.warn(
        'Targeted Jellyfin availability reconciliation exhausted its active window',
        {
          label: 'Jellyfin Availability Reconciler',
          mediaId: target.mediaId,
          mediaType: target.mediaType,
          is4k: target.is4k,
          attempts: target.attempts,
        }
      );
    }
  }

  private clearTarget(key: string, target: PendingTarget): void {
    this.pending.delete(key);
    for (const presentationTarget of target.presentationTargets) {
      this.presentation.clearFinalizing(presentationTarget);
    }
  }

  private rememberCompletedGeneration(key: string): void {
    this.completedGenerations.add(key);
    if (this.completedGenerations.size <= COMPLETED_GENERATION_CACHE_LIMIT) {
      return;
    }
    const oldest = this.completedGenerations.values().next().value;
    if (oldest) this.completedGenerations.delete(oldest);
  }
}

const jellyfinAvailabilityReconciler = new JellyfinAvailabilityReconciler();

export default jellyfinAvailabilityReconciler;
