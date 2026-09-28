import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import type { ConfirmedServarrImport } from '@server/lib/downloadtracker';
import jellyfinRecentScanCoordinator from '@server/lib/jellyfinRecentScanCoordinator';
import type { JellyfinScanOutcome } from '@server/lib/scanners/jellyfin';
import logger from '@server/logger';

export const JELLYFIN_RECONCILIATION_DEBOUNCE_MS = 5_000;
export const JELLYFIN_RECONCILIATION_RETRY_DELAYS_MS = [
  15_000, 30_000, 60_000, 120_000,
] as const;

export interface JellyfinAvailabilityTarget {
  mediaId: number;
  mediaType: MediaType;
  is4k: boolean;
  seasonNumbers: number[];
}

interface PendingTarget extends JellyfinAvailabilityTarget {
  attempts: number;
}

interface ReconcilerOptions {
  scanner?: { run(): Promise<JellyfinScanOutcome> };
  resolveImports?: (
    imports: ConfirmedServarrImport[]
  ) => Promise<JellyfinAvailabilityTarget[]>;
  isAvailable?: (target: JellyfinAvailabilityTarget) => Promise<boolean>;
  setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
}

const targetKey = (target: JellyfinAvailabilityTarget): string =>
  `${target.mediaId}:${target.is4k ? '4k' : 'standard'}`;

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
        seasonNumbers: [
          ...new Set(imported.episodes.map((episode) => episode.seasonNumber)),
        ],
      };
      const key = targetKey(target);
      const existing = targets.get(key);
      targets.set(key, {
        ...target,
        seasonNumbers: [
          ...new Set([
            ...(existing?.seasonNumbers ?? []),
            ...target.seasonNumbers,
          ]),
        ],
      });
    }
  }

  return [...targets.values()];
};

export const hasExpectedAvailability = (
  media: Pick<Media, 'status' | 'status4k' | 'seasons'>,
  target: JellyfinAvailabilityTarget
): boolean => {
  const status = target.is4k ? media.status4k : media.status;
  if (target.mediaType === MediaType.MOVIE) {
    return status === MediaStatus.AVAILABLE;
  }
  if (!target.seasonNumbers.length) {
    return (
      status === MediaStatus.AVAILABLE ||
      status === MediaStatus.PARTIALLY_AVAILABLE
    );
  }

  return target.seasonNumbers.every((seasonNumber) => {
    const season = media.seasons.find(
      (candidate) => candidate.seasonNumber === seasonNumber
    );
    const seasonStatus = target.is4k ? season?.status4k : season?.status;
    return (
      seasonStatus === MediaStatus.AVAILABLE ||
      seasonStatus === MediaStatus.PARTIALLY_AVAILABLE
    );
  });
};

const isTargetAvailable = async (
  target: JellyfinAvailabilityTarget
): Promise<boolean> => {
  const media = await getRepository(Media).findOne({
    where: { id: target.mediaId },
    relations: { seasons: true },
  });
  if (!media) return false;

  return hasExpectedAvailability(media, target);
};

export class JellyfinAvailabilityReconciler {
  private readonly pending = new Map<string, PendingTarget>();
  private timer?: NodeJS.Timeout;
  private activeRun?: Promise<void>;
  private readonly scanner: { run(): Promise<JellyfinScanOutcome> };
  private readonly resolveImports: NonNullable<
    ReconcilerOptions['resolveImports']
  >;
  private readonly isAvailable: NonNullable<ReconcilerOptions['isAvailable']>;
  private readonly setTimer: NonNullable<ReconcilerOptions['setTimer']>;

  constructor(options: ReconcilerOptions = {}) {
    this.scanner = options.scanner ?? jellyfinRecentScanCoordinator;
    this.resolveImports = options.resolveImports ?? resolveImports;
    this.isAvailable = options.isAvailable ?? isTargetAvailable;
    this.setTimer = options.setTimer ?? setTimeout;
  }

  public async request(imports: ConfirmedServarrImport[]): Promise<void> {
    const targets = await this.resolveImports(imports);
    for (const target of targets) {
      const key = targetKey(target);
      const existing = this.pending.get(key);
      this.pending.set(key, {
        ...target,
        seasonNumbers: [
          ...new Set([
            ...(existing?.seasonNumbers ?? []),
            ...target.seasonNumbers,
          ]),
        ],
        attempts: existing?.attempts ?? 0,
      });
    }
    if (targets.length) {
      logger.info('Jellyfin availability reconciliation requested', {
        label: 'Jellyfin Availability Reconciler',
        importedAcquisitions: imports.length,
        targetsAdded: targets.length,
        pendingTargets: this.pending.size,
      });
      this.scheduleNext();
    }
  }

  public getStatus(): { pendingTargets: number; running: boolean } {
    return { pendingTargets: this.pending.size, running: !!this.activeRun };
  }

  private scheduleNext(): void {
    if (this.activeRun || this.timer || !this.pending.size) return;
    const attempts = Math.min(
      ...[...this.pending.values()].map((target) => target.attempts)
    );
    const delay =
      attempts === 0
        ? JELLYFIN_RECONCILIATION_DEBOUNCE_MS
        : JELLYFIN_RECONCILIATION_RETRY_DELAYS_MS[attempts - 1];
    if (delay === undefined) {
      for (const [key, target] of this.pending) {
        if (target.attempts > JELLYFIN_RECONCILIATION_RETRY_DELAYS_MS.length) {
          this.pending.delete(key);
        }
      }
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.run();
    }, delay);
  }

  private run(): Promise<void> {
    if (this.activeRun) return this.activeRun;
    const attemptedKeys = [...this.pending.keys()];
    const run = this.reconcile(attemptedKeys).finally(() => {
      if (this.activeRun === run) this.activeRun = undefined;
      this.scheduleNext();
    });
    this.activeRun = run;
    return run;
  }

  private async reconcile(attemptedKeys: string[]): Promise<void> {
    const retryNumber = Math.max(
      0,
      ...attemptedKeys.map((key) => this.pending.get(key)?.attempts ?? 0)
    );
    logger.info('Starting coalesced Jellyfin recent scan for imports', {
      label: 'Jellyfin Availability Reconciler',
      targets: attemptedKeys.length,
      retryNumber,
    });
    const outcome = await this.scanner.run();
    let resolved = 0;
    for (const key of attemptedKeys) {
      const target = this.pending.get(key);
      if (!target) continue;
      if (await this.isAvailable(target)) {
        this.pending.delete(key);
        resolved += 1;
      } else {
        target.attempts += 1;
        if (target.attempts > JELLYFIN_RECONCILIATION_RETRY_DELAYS_MS.length) {
          this.pending.delete(key);
          logger.warn(
            'Jellyfin availability reconciliation exhausted its retry budget',
            {
              label: 'Jellyfin Availability Reconciler',
              mediaId: target.mediaId,
              mediaType: target.mediaType,
              is4k: target.is4k,
            }
          );
        }
      }
    }

    logger.info('Jellyfin availability reconciliation completed', {
      label: 'Jellyfin Availability Reconciler',
      scanStatus: outcome.status,
      scanDurationMs: outcome.durationMs,
      targetsAttempted: attemptedKeys.length,
      targetsResolved: resolved,
      pendingTargets: this.pending.size,
      retryNumber,
    });
  }
}

const jellyfinAvailabilityReconciler = new JellyfinAvailabilityReconciler();

export default jellyfinAvailabilityReconciler;
