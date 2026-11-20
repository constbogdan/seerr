import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import { synchronizationPolicy } from '@server/job/synchronizationPolicy';
import { currentLibraryPresenceSql } from '@server/lib/libraryActivity';
import libraryCollections from '@server/lib/libraryCollections';
import { movieCollectionMembership } from '@server/lib/movieCollectionMembership';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In } from 'typeorm';

const COLLECTION_CHANGE_DEBOUNCE_MS = 3_000;
const MEMBERSHIP_RETRY_MS = 5 * 60_000;
const MAX_LOOKUPS_PER_BATCH = 20;

type Membership = 'collection' | 'standalone' | 'unresolved';

interface LifecycleDependencies {
  resolve(ids: number[], maxLookups: number): Promise<Map<number, Membership>>;
  hasCurrentPhysicalPresence(tmdbId: number): Promise<boolean>;
  changeSignatures(ids: number[]): Promise<Map<number, string>>;
  invalidate(): void;
  warm(locale: string): void;
  setRefreshReady(ready: boolean): void;
  hasSnapshot(locale: string): boolean;
  hydrateHistory(): Promise<boolean>;
  defaultLocale(): string;
  allowAutomaticWork(): boolean;
  setTimer(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
}

const defaultDependencies = (): LifecycleDependencies => ({
  resolve: async (ids, maxLookups) => {
    const batch = await movieCollectionMembership.resolve(
      ids.map((tmdbId) => ({ mediaType: 'movie', tmdbId })),
      { maxLookups, concurrency: 4, deadlineMs: maxLookups ? 15_000 : 0 }
    );
    return new Map(
      [...batch.results].map(([id, result]) => [id, result.membership.kind])
    );
  },
  hasCurrentPhysicalPresence: async (tmdbId) => {
    const rows = await getRepository(CanonicalMedia)
      .createQueryBuilder('canonical')
      .innerJoin(
        CanonicalMediaIdentity,
        'identity',
        'identity.canonicalMediaId = canonical.id AND identity.provider = :provider ' +
          'AND identity.sourceScope = :scope AND identity.mediaType = :mediaType ' +
          'AND identity.value = :tmdbId',
        {
          provider: 'tmdb',
          scope: '',
          mediaType: LibraryMediaType.MOVIE,
          tmdbId: String(tmdbId),
        }
      )
      .innerJoin(
        LibraryPresence,
        'presence',
        `presence.canonicalMediaId = canonical.id AND ${currentLibraryPresenceSql(
          'presence',
          ':isCurrent'
        )}`,
        { isCurrent: true }
      )
      .select('canonical.id', 'id')
      .limit(1)
      .getRawMany();
    return rows.length > 0;
  },
  changeSignatures: async (ids) => {
    if (!ids.length) return new Map();
    const identities = await getRepository(CanonicalMedia)
      .createQueryBuilder('canonical')
      .innerJoin(
        CanonicalMediaIdentity,
        'identity',
        'identity.canonicalMediaId = canonical.id AND identity.provider = :provider ' +
          'AND identity.sourceScope = :scope AND identity.mediaType = :mediaType ' +
          'AND identity.value IN (:...ids)',
        {
          provider: 'tmdb',
          scope: '',
          mediaType: LibraryMediaType.MOVIE,
          ids: ids.map(String),
        }
      )
      .leftJoin(
        LibraryPresence,
        'presence',
        `presence.canonicalMediaId = canonical.id AND ${currentLibraryPresenceSql(
          'presence',
          ':isCurrent'
        )}`,
        { isCurrent: true }
      )
      .select('identity.value', 'tmdbId')
      .addSelect('canonical.tmdbCollectionId', 'collectionId')
      .addSelect('presence.id', 'presenceId')
      .getRawMany<{
        tmdbId: string;
        collectionId: number | null;
        presenceId: number | null;
      }>();
    const media = await getRepository(Media).find({
      select: { tmdbId: true, status: true },
      where: { mediaType: MediaType.MOVIE, tmdbId: In(ids) },
    });
    const byId = new Map<number, string[]>();
    for (const row of identities) {
      const id = Number(row.tmdbId);
      const entries = byId.get(id) ?? [];
      entries.push(
        `${row.collectionId ?? ''}:${row.presenceId != null ? 1 : 0}`
      );
      byId.set(id, entries);
    }
    const statusById = new Map<number, string[]>();
    for (const row of media) {
      const entries = statusById.get(row.tmdbId) ?? [];
      entries.push(String(row.status));
      statusById.set(row.tmdbId, entries);
    }
    return new Map(
      ids.map((id) => [
        id,
        `${(byId.get(id) ?? []).sort().join(',')}|${(statusById.get(id) ?? []).sort().join(',')}`,
      ])
    );
  },
  invalidate: () => libraryCollections.invalidate(),
  warm: (locale) => libraryCollections.warm(locale),
  setRefreshReady: (ready) => libraryCollections.setRefreshReady(ready),
  hasSnapshot: (locale) => libraryCollections.hasSnapshot(locale),
  hydrateHistory: async () => {
    const { default: libraryHistoryHydration } =
      await import('@server/lib/libraryHistoryHydration');
    const result = await libraryHistoryHydration.run();
    return result.complete && result.collectionMembership?.complete === true;
  },
  defaultLocale: () => getSettings().main.locale,
  allowAutomaticWork: () => synchronizationPolicy.scheduledExecutionAllowed,
  setTimer: setTimeout,
  clearTimer: clearTimeout,
});

/** Collection work starts only after HTTP readiness and a successful history run. */
export class LibraryCollectionsLifecycle {
  private httpReady = false;
  private historyReady = false;
  private membershipReady = false;
  private initialHistoryFailed = false;
  private timer?: NodeJS.Timeout;
  private timerDueAt?: number;
  private running = false;
  private hydrationTimer?: NodeJS.Timeout;
  private hydrating = false;
  private pending = new Set<number>();
  private imported = new Set<number>();
  private physicalPending = new Map<number, boolean>();
  private physicalAssociationChanged = false;
  private readonly lastInvalidatedState = new Map<number, string>();
  private readonly dependencies: LifecycleDependencies;

  constructor(dependencies: Partial<LifecycleDependencies> = {}) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
  }

  public markHttpReady(): void {
    this.httpReady = true;
    this.updateRefreshReadiness();
    this.startIfReady();
    this.schedule();
    this.scheduleHydration(
      this.initialHistoryFailed
        ? MEMBERSHIP_RETRY_MS
        : COLLECTION_CHANGE_DEBOUNCE_MS,
      this.initialHistoryFailed
    );
  }

  public ready(): boolean {
    return (
      this.httpReady &&
      this.historyReady &&
      this.membershipReady &&
      this.dependencies.allowAutomaticWork()
    );
  }

  public onHistoryCommitted(
    complete: boolean,
    associationChanged: boolean,
    membershipComplete = true
  ): void {
    if (!complete || !membershipComplete) {
      this.initialHistoryFailed = true;
      this.membershipReady = false;
      this.updateRefreshReadiness();
      this.scheduleHydration(MEMBERSHIP_RETRY_MS, true);
      return;
    }
    this.initialHistoryFailed = false;
    const hadHistory = this.historyReady;
    this.historyReady = true;
    this.membershipReady = true;
    this.updateRefreshReadiness();
    this.physicalAssociationChanged ||=
      associationChanged &&
      (hadHistory ||
        this.dependencies.hasSnapshot(this.dependencies.defaultLocale()));
    for (const [id, imported] of this.physicalPending) {
      this.pending.add(id);
      if (imported) this.imported.add(id);
    }
    this.physicalPending.clear();
    this.startIfReady();
    this.schedule();
  }

  /** Called only after a targeted import's physical-presence transaction commits. */
  public onConfirmedImport(tmdbId: number): void {
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return;
    this.pending.add(tmdbId);
    this.imported.add(tmdbId);
    this.schedule();
  }

  /** Scanner/sync changes must wait for committed history-presence updates. */
  public onPhysicalChangePending(tmdbId: number, imported: boolean): void {
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return;
    this.physicalPending.set(
      tmdbId,
      imported || this.physicalPending.get(tmdbId) === true
    );
    this.scheduleHydration();
  }

  /** A status-only edit can use already committed physical evidence. */
  public onAvailabilityCommitted(tmdbId: number): void {
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return;
    this.pending.add(tmdbId);
    this.schedule();
  }

  public async onMembershipObserved(tmdbId: number): Promise<void> {
    if (await this.dependencies.hasCurrentPhysicalPresence(tmdbId)) {
      this.pending.add(tmdbId);
      this.schedule();
    }
  }

  private startIfReady(): void {
    if (this.ready()) this.dependencies.warm(this.dependencies.defaultLocale());
  }

  private updateRefreshReadiness(): void {
    this.dependencies.setRefreshReady(
      this.httpReady && this.historyReady && this.membershipReady
    );
  }

  private scheduleHydration(
    delayMs = COLLECTION_CHANGE_DEBOUNCE_MS,
    retryFailedInitial = false
  ): void {
    if (
      !this.httpReady ||
      !this.dependencies.allowAutomaticWork() ||
      this.hydrating ||
      this.hydrationTimer
    )
      return;
    if (!this.physicalPending.size && !retryFailedInitial) return;
    // The initial catch-up is already scheduled by the existing job lifecycle.
    if (!this.historyReady && !retryFailedInitial) return;
    this.hydrationTimer = this.dependencies.setTimer(() => {
      this.hydrationTimer = undefined;
      void this.hydratePending(retryFailedInitial);
    }, delayMs);
    this.hydrationTimer.unref?.();
  }

  private async hydratePending(retryFailedInitial: boolean): Promise<void> {
    if (this.hydrating) return;
    this.hydrating = true;
    let retryNeeded = false;
    try {
      const ids = [...this.physicalPending.keys()];
      if (ids.length && !retryFailedInitial) {
        const known = await this.dependencies.resolve(ids, 0);
        if (ids.every((id) => known.get(id) === 'standalone')) {
          this.physicalPending.clear();
          return;
        }
      }
      retryNeeded = !(await this.dependencies.hydrateHistory());
    } catch (error) {
      logger.warn('Collection-related Library History catch-up failed', {
        label: 'Library Collections',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      retryNeeded = true;
    } finally {
      this.hydrating = false;
      if (retryNeeded || this.physicalPending.size)
        this.scheduleHydration(MEMBERSHIP_RETRY_MS, retryNeeded);
    }
  }

  private schedule(delayMs = COLLECTION_CHANGE_DEBOUNCE_MS): void {
    if (!this.ready() || this.running) return;
    if (!this.pending.size && !this.physicalAssociationChanged) return;
    const dueAt = Date.now() + delayMs;
    if (this.timer && this.timerDueAt !== undefined && this.timerDueAt <= dueAt)
      return;
    if (this.timer) this.dependencies.clearTimer(this.timer);
    this.timerDueAt = dueAt;
    this.timer = this.dependencies.setTimer(() => {
      this.timer = undefined;
      this.timerDueAt = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    let retryNeeded = false;
    const ids = [...this.pending];
    const imported = new Set(this.imported);
    const associationChanged = this.physicalAssociationChanged;
    this.pending.clear();
    this.imported.clear();
    this.physicalAssociationChanged = false;
    try {
      const known = await this.dependencies.resolve(ids, 0);
      const unresolvedImports = ids.filter(
        (id) => imported.has(id) && known.get(id) === 'unresolved'
      );
      const bounded = unresolvedImports.slice(0, MAX_LOOKUPS_PER_BATCH);
      const discovered = bounded.length
        ? await this.dependencies.resolve(bounded, bounded.length)
        : new Map<number, Membership>();
      const remaining = unresolvedImports.slice(MAX_LOOKUPS_PER_BATCH);
      const unresolved = bounded.filter(
        (id) => discovered.get(id) === 'unresolved'
      );
      for (const id of [...remaining, ...unresolved]) {
        this.pending.add(id);
        this.imported.add(id);
      }
      retryNeeded = remaining.length > 0 || unresolved.length > 0;
      const signatures = await this.dependencies.changeSignatures(ids);
      const changedIds = ids.filter(
        (id) => signatures.get(id) !== this.lastInvalidatedState.get(id)
      );
      if (
        associationChanged ||
        changedIds.some(
          (id) =>
            this.lastInvalidatedState.has(id) ||
            known.get(id) === 'collection' ||
            discovered.get(id) === 'collection'
        )
      ) {
        this.dependencies.invalidate();
        for (const id of ids) {
          const signature = signatures.get(id);
          if (signature !== undefined)
            this.lastInvalidatedState.set(id, signature);
        }
      }
    } catch (error) {
      for (const id of ids) this.pending.add(id);
      for (const id of imported) this.imported.add(id);
      this.physicalAssociationChanged ||= associationChanged;
      logger.warn('Unable to process collection-related movie changes', {
        label: 'Library Collections',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      retryNeeded = true;
    } finally {
      this.running = false;
      this.schedule(
        retryNeeded ? MEMBERSHIP_RETRY_MS : COLLECTION_CHANGE_DEBOUNCE_MS
      );
    }
  }
}

const libraryCollectionsLifecycle = new LibraryCollectionsLifecycle();
export default libraryCollectionsLifecycle;
