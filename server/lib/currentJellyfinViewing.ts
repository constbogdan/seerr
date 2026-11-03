import JellyfinAPI, {
  type JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import {
  IdentityResolutionState,
  SourceCheckpointStatus,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import type { HydrationRun } from '@server/entity/LibraryHydration';
import { SourceCheckpoint } from '@server/entity/LibraryHydration';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import backgroundDatabaseWriteCoordinator from '@server/lib/backgroundDatabaseWriteCoordinator';
import type { CurrentViewingRunCoordinator } from '@server/lib/currentViewingRunCoordinator';
import currentViewingRunCoordinator, {
  CurrentViewingRunOwnershipLostError,
} from '@server/lib/currentViewingRunCoordinator';
import {
  loadCurrentViewingTargets,
  type CurrentViewingTarget,
} from '@server/lib/currentViewingTargets';
import {
  loadLibraryPreferenceTargets,
  persistJellyfinPreference,
  type JellyfinPreferenceTarget,
} from '@server/lib/jellyfinPreferences';
import {
  JELLYFIN_VIEWING_USER_CONCURRENCY,
  getBatchedUserItems,
  normalizeExactJellyfinId,
  normalizeJellyfinActivityDate,
  runBounded,
  type JellyfinViewingClient,
} from '@server/lib/jellyfinViewingSource';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';
import { IsNull, type EntityManager } from 'typeorm';

const SOURCE = 'jellyfin';
const SOURCE_CLASS = 'current-user-data';
const SOURCE_VERSION = 'current-user-data-v1';

interface ViewerTarget {
  viewer: Viewer;
  sourceUserId: string;
}

interface SuccessfulUserFetch extends ViewerTarget {
  items: Map<string, JellyfinLibraryItemExtended>;
  batches: number;
  durationMs: number;
}

interface FailedUserFetch extends ViewerTarget {
  error: unknown;
  durationMs: number;
}

export interface CurrentJellyfinViewingSummary {
  preferencesUpdated: number;
  preferencesIncomplete: number;
  sourceScope: string;
  sourceGeneration: string;
  startedAt: Date;
  completedAt: Date;
  complete: boolean;
  durationMs: number;
  usersConsidered: number;
  usersSucceeded: number;
  usersIncomplete: number;
  usersFailed: number;
  moviesTargeted: number;
  episodesTargeted: number;
  itemsReturned: number;
  missingItems: number;
  apiBatches: number;
  stateCreated: number;
  stateUpdated: number;
  confirmedEvidenceCreated: number;
  confirmedEvidenceReused: number;
  partialEvidenceCreated: number;
  partialEvidenceUpdated: number;
  partialEvidenceReused: number;
  sentinelStatesNormalized: number;
  sentinelEvidenceNormalized: number;
  currentStatesPruned: number;
  currentStatesPruneBlocked: number;
  playedMovies: number;
  playedEpisodes: number;
  partialMovies: number;
  partialEpisodes: number;
}

export interface CurrentJellyfinViewingDependencies {
  createClient(): Promise<JellyfinViewingClient>;
  now(): Date;
  beforeUserCommit?(sourceUserId: string): Promise<void>;
}

const defaultDependencies: CurrentJellyfinViewingDependencies = {
  createClient: async () => {
    const settings = getSettings();
    const admin = await getRepository(User).findOne({
      where: { id: 1 },
      select: ['id', 'jellyfinDeviceId'],
    });
    return new JellyfinAPI(
      getHostname(),
      settings.jellyfin.apiKey,
      admin?.jellyfinDeviceId ?? ''
    );
  },
  now: () => new Date(),
};

const safeTicks = (value?: number | null): string | null =>
  Number.isSafeInteger(value) && (value ?? -1) >= 0 ? String(value) : null;

const progressBasisPoints = (
  item: JellyfinLibraryItemExtended
): number | null => {
  if (item.UserData?.Played) return 10_000;
  const supplied = item.UserData?.PlayedPercentage;
  if (typeof supplied === 'number' && Number.isFinite(supplied)) {
    return Math.min(10_000, Math.max(0, Math.round(supplied * 100)));
  }
  const position = item.UserData?.PlaybackPositionTicks;
  const runtime = item.RunTimeTicks;
  if (
    typeof position === 'number' &&
    Number.isFinite(position) &&
    position >= 0 &&
    typeof runtime === 'number' &&
    Number.isFinite(runtime) &&
    runtime > 0
  ) {
    return Math.min(10_000, Math.round((position / runtime) * 10_000));
  }
  return position && position > 0 ? 1 : null;
};

const evidenceActivityId = ({
  sourceUserId,
  sourceItemId,
  lastPlayedAt,
}: {
  sourceUserId: string;
  sourceItemId: string;
  lastPlayedAt: Date | null;
}): string =>
  `${sourceUserId}:${sourceItemId}:${lastPlayedAt?.toISOString() ?? 'played'}`;

const partialEvidenceActivityId = ({
  sourceUserId,
  sourceItemId,
}: {
  sourceUserId: string;
  sourceItemId: string;
}): string => `${sourceUserId}:${sourceItemId}:partial`;

export class CurrentJellyfinViewingService {
  private inFlight?: Promise<CurrentJellyfinViewingSummary>;
  private cancelled = false;

  constructor(
    private readonly dependencies: CurrentJellyfinViewingDependencies = defaultDependencies,
    private readonly runCoordinator: CurrentViewingRunCoordinator = currentViewingRunCoordinator
  ) {}

  public running(): boolean {
    return Boolean(this.inFlight);
  }

  public cancel(): void {
    this.cancelled = true;
  }

  public recoverAbandonedRuns(): Promise<number> {
    return this.runCoordinator.recoverExpiredRuns();
  }

  public run(): Promise<CurrentJellyfinViewingSummary> {
    if (this.inFlight) return this.inFlight;
    this.cancelled = false;
    this.inFlight = this.reconcile().finally(() => {
      this.inFlight = undefined;
      this.cancelled = false;
    });
    return this.inFlight;
  }

  public startCatchUp(): void {
    const type = getSettings().main.mediaServerType;
    if (type !== MediaServerType.JELLYFIN && type !== MediaServerType.EMBY) {
      return;
    }
    setImmediate(() => {
      void this.run().catch((error) => {
        logger.error('Current Jellyfin viewing startup sync failed', {
          label: 'Current Jellyfin Viewing',
          errorType: error instanceof Error ? error.name : 'UnknownSyncError',
        });
      });
    });
  }

  private async ensureViewers(
    scope: string,
    manager: EntityManager
  ): Promise<ViewerTarget[]> {
    const users = await manager.getRepository(User).find();
    const grouped = new Map<string, User[]>();
    for (const user of users) {
      const sourceUserId = normalizeExactJellyfinId(user.jellyfinUserId);
      if (!sourceUserId) continue;
      const group = grouped.get(sourceUserId) ?? [];
      group.push(user);
      grouped.set(sourceUserId, group);
    }
    const result: ViewerTarget[] = [];
    for (const [sourceUserId, mapped] of grouped) {
      if (mapped.length !== 1) {
        logger.error('Ambiguous Jellyfin user mapping blocks viewing sync', {
          label: 'Current Jellyfin Viewing',
          mappedSeerrUsers: mapped.length,
        });
        continue;
      }
      let viewer = await manager.getRepository(Viewer).findOneBy({
        source: SOURCE,
        sourceScope: scope,
        sourceUserId,
      });
      viewer ??= new Viewer({
        source: SOURCE,
        sourceScope: scope,
        sourceUserId,
      });
      viewer.userId = mapped[0].id;
      viewer = await manager.getRepository(Viewer).save(viewer);
      result.push({ viewer, sourceUserId });
    }
    return result;
  }

  private newSummary(
    sourceScope: string,
    sourceGeneration: string,
    startedAt: Date,
    targets: CurrentViewingTarget[],
    users: ViewerTarget[]
  ): CurrentJellyfinViewingSummary {
    return {
      preferencesUpdated: 0,
      preferencesIncomplete: 0,
      sourceScope,
      sourceGeneration,
      startedAt,
      completedAt: startedAt,
      complete: false,
      durationMs: 0,
      usersConsidered: users.length,
      usersSucceeded: 0,
      usersIncomplete: 0,
      usersFailed: 0,
      moviesTargeted: targets.filter((target) => target.mediaType === 'movie')
        .length,
      episodesTargeted: targets.filter(
        (target) => target.mediaType === 'episode'
      ).length,
      itemsReturned: 0,
      missingItems: 0,
      apiBatches: 0,
      stateCreated: 0,
      stateUpdated: 0,
      confirmedEvidenceCreated: 0,
      confirmedEvidenceReused: 0,
      partialEvidenceCreated: 0,
      partialEvidenceUpdated: 0,
      partialEvidenceReused: 0,
      sentinelStatesNormalized: 0,
      sentinelEvidenceNormalized: 0,
      currentStatesPruned: 0,
      currentStatesPruneBlocked: 0,
      playedMovies: 0,
      playedEpisodes: 0,
      partialMovies: 0,
      partialEpisodes: 0,
    };
  }

  private async reconcile(): Promise<CurrentJellyfinViewingSummary> {
    const startedAt = this.dependencies.now();
    const settings = getSettings();
    const scope = settings.jellyfin.serverId || 'configured-server';
    const snapshot = await backgroundDatabaseWriteCoordinator.runExclusive(
      async () => {
        await this.runCoordinator.recoverExpiredRuns();
        return this.runCoordinator.begin(scope, async (manager) => {
          const targets = await loadCurrentViewingTargets(scope, manager);
          const preferenceTargets = await loadLibraryPreferenceTargets(
            manager,
            scope
          );
          const viewers = await this.ensureViewers(scope, manager);
          return {
            value: { targets, viewers, preferenceTargets },
            sourceUserIds: viewers.map(({ sourceUserId }) => sourceUserId),
          };
        });
      }
    );
    const { targets, viewers, preferenceTargets } = snapshot.value;
    const summary = this.newSummary(
      scope,
      String(snapshot.libraryGeneration),
      startedAt,
      targets,
      viewers
    );
    const heartbeat = this.runCoordinator.heartbeat(snapshot.run.id);
    const successes: SuccessfulUserFetch[] = [];
    const failures: FailedUserFetch[] = [];
    try {
      let client: JellyfinViewingClient | null = null;
      if (viewers.length > 0) {
        try {
          client = await this.dependencies.createClient();
        } catch (error) {
          failures.push(
            ...viewers.map((viewer) => ({
              ...viewer,
              error,
              durationMs: 0,
            }))
          );
        }
      }
      if (client) {
        await runBounded(
          viewers,
          JELLYFIN_VIEWING_USER_CONCURRENCY,
          async (viewer) => {
            if (this.cancelled || !client) return;
            const userStarted = Date.now();
            let batches = 0;
            try {
              const items = await getBatchedUserItems({
                client,
                ids: [
                  ...targets.map((target) => target.sourceItemId),
                  ...preferenceTargets.flatMap((target) => target.ids),
                ],
                userId: viewer.sourceUserId,
                fields: ['ProviderIds', 'RunTimeTicks'],
                onBatch: () => batches++,
              });
              successes.push({
                ...viewer,
                items,
                batches,
                durationMs: Date.now() - userStarted,
              });
            } catch (error) {
              failures.push({
                ...viewer,
                error,
                durationMs: Date.now() - userStarted,
              });
            }
          }
        );
      }
      heartbeat.assertHealthy();
      await backgroundDatabaseWriteCoordinator.runExclusive(async () => {
        await this.persist(
          snapshot.run,
          summary,
          targets,
          this.cancelled ? [] : successes,
          this.cancelled
            ? [
                ...failures,
                ...viewers
                  .filter(
                    (viewer) =>
                      !failures.some(
                        ({ sourceUserId }) =>
                          sourceUserId === viewer.sourceUserId
                      )
                  )
                  .map((viewer) => ({
                    ...viewer,
                    error: new Error('Viewing synchronization was cancelled'),
                    durationMs: 0,
                  })),
              ]
            : failures,
          preferenceTargets
        );
      });
    } catch (error) {
      if (!(error instanceof CurrentViewingRunOwnershipLostError)) throw error;
      summary.complete = false;
      logger.warn('Discarded stale current-viewing synchronization results', {
        label: 'Current Jellyfin Viewing',
        sourceScope: scope,
      });
    } finally {
      await heartbeat.stop();
    }
    summary.completedAt = this.dependencies.now();
    summary.durationMs = summary.completedAt.getTime() - startedAt.getTime();
    const safeSummary: Partial<CurrentJellyfinViewingSummary> = { ...summary };
    delete safeSummary.sourceScope;
    delete safeSummary.sourceGeneration;
    logger.info('Current Jellyfin viewing sync completed', {
      label: 'Current Jellyfin Viewing',
      ...safeSummary,
    });
    return summary;
  }

  private async persist(
    run: HydrationRun,
    summary: CurrentJellyfinViewingSummary,
    targets: CurrentViewingTarget[],
    successes: SuccessfulUserFetch[],
    failures: FailedUserFetch[],
    preferenceTargets: JellyfinPreferenceTarget[]
  ): Promise<void> {
    const targetById = new Map(
      targets.map((target) => [target.sourceItemId, target])
    );
    const observedAt = this.dependencies.now();
    const normalized = { ...summary };
    await this.runCoordinator.transaction(async (manager) => {
      await this.runCoordinator.assertOwnership(run.id, manager);
      await this.normalizePersistedSentinels(normalized, manager);
    });
    Object.assign(summary, normalized);
    let persistenceFailures = 0;
    for (const success of successes) {
      summary.apiBatches += success.batches;
      const completeItems = targets.filter(
        (target) => success.items.get(target.sourceItemId)?.UserData
      ).length;
      summary.itemsReturned += completeItems;
      const missingItems = targets.length - completeItems;
      summary.missingItems += missingItems;
      const committed = { ...summary };
      try {
        const userComplete = await this.runCoordinator.transaction(
          async (manager) => {
            await this.runCoordinator.assertUserOwnership(
              manager,
              run,
              success.sourceUserId
            );
            for (const [sourceItemId, item] of success.items) {
              const target = targetById.get(sourceItemId);
              if (!target?.canonicalMediaId || !item.UserData) continue;
              await this.persistItem(
                committed,
                success.viewer,
                target,
                item,
                observedAt,
                manager
              );
            }
            // Independently persist preferences. Raw viewing state, evidence,
            // completeness and watched aggregation retain their V1 semantics.
            for (const target of preferenceTargets) {
              const updated = await persistJellyfinPreference({
                manager,
                target,
                items: success.items,
                userId: success.viewer.userId!,
                sourceUserId: success.sourceUserId,
                sourceScope: summary.sourceScope,
                observedAt: summary.startedAt,
              });
              if (updated) committed.preferencesUpdated++;
              else committed.preferencesIncomplete++;
            }
            let complete = missingItems === 0;
            if (complete) {
              const blocked = await this.pruneObsoleteCurrentStates(
                committed,
                success.viewer,
                targets,
                manager
              );
              complete = blocked === 0;
            }
            await this.dependencies.beforeUserCommit?.(success.sourceUserId);
            const checkpoint = await this.runCoordinator.assertUserOwnership(
              manager,
              run,
              success.sourceUserId
            );
            this.updateUserCheckpoint(
              checkpoint,
              summary.sourceGeneration,
              complete
                ? SourceCheckpointStatus.CURRENT
                : SourceCheckpointStatus.FAILED,
              observedAt,
              complete ? observedAt : undefined
            );
            await manager.getRepository(SourceCheckpoint).save(checkpoint);
            return complete;
          }
        );
        Object.assign(summary, committed);
        summary.usersSucceeded++;
        if (!userComplete) summary.usersIncomplete++;
      } catch (error) {
        if (error instanceof CurrentViewingRunOwnershipLostError) throw error;
        persistenceFailures++;
        summary.usersFailed++;
        await this.markUserFailed(run, success, summary, observedAt);
        logger.warn('Unable to persist current Jellyfin viewing for a user', {
          label: 'Current Jellyfin Viewing',
          errorType: error instanceof Error ? error.name : 'UnknownWriteError',
        });
      }
    }
    for (const failure of failures) {
      summary.preferencesIncomplete += preferenceTargets.length;
      summary.usersFailed++;
      logger.warn('Unable to reconcile current Jellyfin viewing for a user', {
        label: 'Current Jellyfin Viewing',
        errorType:
          failure.error instanceof Error
            ? failure.error.name
            : 'UnknownProviderError',
      });
      await this.markUserFailed(run, failure, summary, observedAt);
    }
    const complete =
      failures.length === 0 &&
      persistenceFailures === 0 &&
      summary.usersIncomplete === 0 &&
      summary.usersSucceeded === successes.length;
    await this.runCoordinator.complete(run.id, {
      succeeded: complete,
      completedAt: observedAt,
      rowsInspected: summary.itemsReturned,
      rowsCreated:
        summary.stateCreated +
        summary.confirmedEvidenceCreated +
        summary.partialEvidenceCreated,
      rowsUpdated:
        summary.stateUpdated +
        summary.partialEvidenceUpdated +
        summary.currentStatesPruned,
      unresolvedCount: summary.missingItems,
      failureCode: complete ? null : 'PartialUserSync',
      failureMessage: complete
        ? null
        : 'Current Jellyfin viewing sync was incomplete.',
    });
    summary.complete = complete;
  }

  private async persistItem(
    summary: CurrentJellyfinViewingSummary,
    viewer: Viewer,
    target: CurrentViewingTarget,
    item: JellyfinLibraryItemExtended,
    observedAt: Date,
    manager: EntityManager
  ): Promise<void> {
    const stateRepository = manager.getRepository(CurrentViewingState);
    let state = await stateRepository.findOneBy({
      viewerId: viewer.id,
      sourceScope: summary.sourceScope,
      sourceItemId: target.sourceItemId,
    });
    if (state) summary.stateUpdated++;
    else {
      state = new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: summary.sourceScope,
        sourceItemId: target.sourceItemId,
        canonicalMediaId: target.canonicalMediaId,
        canonicalEpisodeId: target.canonicalEpisodeId,
        mediaType: target.mediaType,
      });
      summary.stateCreated++;
    }
    const progress = progressBasisPoints(item);
    state.canonicalMediaId = target.canonicalMediaId;
    state.canonicalEpisodeId = target.canonicalEpisodeId;
    state.mediaType = target.mediaType;
    state.played = item.UserData!.Played === true;
    state.playCount = Math.max(0, item.UserData!.PlayCount ?? 0);
    state.lastPlayedAt = normalizeJellyfinActivityDate(
      item.UserData!.LastPlayedDate
    );
    state.playbackPositionTicks = safeTicks(
      item.UserData!.PlaybackPositionTicks
    );
    state.runtimeTicks = safeTicks(item.RunTimeTicks);
    state.progressBasisPoints = progress;
    state.observedAt = observedAt;
    await stateRepository.save(state);
    if (state.played) {
      if (target.mediaType === 'movie') summary.playedMovies++;
      else summary.playedEpisodes++;
      await this.ensureConfirmedEvidence(
        summary,
        viewer,
        target,
        state,
        manager
      );
    } else if ((progress ?? 0) > 0) {
      if (target.mediaType === 'movie') summary.partialMovies++;
      else summary.partialEpisodes++;
      await this.ensurePartialEvidence(summary, viewer, target, state, manager);
    }
  }

  private async ensurePartialEvidence(
    summary: CurrentJellyfinViewingSummary,
    viewer: Viewer,
    target: CurrentViewingTarget,
    state: CurrentViewingState,
    manager: EntityManager
  ): Promise<void> {
    const repository = manager.getRepository(ViewingEvidence);
    const sourceActivityId = partialEvidenceActivityId({
      sourceUserId: viewer.sourceUserId,
      sourceItemId: target.sourceItemId,
    });
    const activityAt = state.lastPlayedAt ?? null;
    let evidence = await repository.findOneBy({
      source: SOURCE,
      sourceScope: summary.sourceScope,
      sourceClass: SOURCE_CLASS,
      sourceActivityId,
    });
    if (!evidence) {
      evidence = new ViewingEvidence({
        source: SOURCE,
        sourceScope: summary.sourceScope,
        sourceClass: SOURCE_CLASS,
        sourceActivityId,
        sourceGeneration: summary.sourceGeneration,
        sourceVersion: SOURCE_VERSION,
        sourceUserId: viewer.sourceUserId,
        sourceItemId: target.sourceItemId,
        viewerId: viewer.id,
        canonicalMediaId: target.canonicalMediaId,
        canonicalEpisodeId: target.canonicalEpisodeId,
        observedAt: activityAt,
        observedEndAt: activityAt,
        playbackPositionTicks: state.playbackPositionTicks,
        runtimeTicks: state.runtimeTicks,
        progressBasisPoints: state.progressBasisPoints,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.PARTIAL,
        completionDerivedAt: state.observedAt,
        provenance: 'jellyfin-current-user-data',
      });
      await repository.save(evidence);
      summary.partialEvidenceCreated++;
      return;
    }

    const priorProgress = evidence.progressBasisPoints ?? 0;
    const currentProgress = state.progressBasisPoints ?? 0;
    const strongestChanged = currentProgress > priorProgress;
    const latestActivity = [evidence.observedEndAt, activityAt]
      .filter((value): value is Date => Boolean(value))
      .sort((left, right) => right.getTime() - left.getTime())[0];
    const changed =
      strongestChanged ||
      evidence.viewerId !== viewer.id ||
      evidence.canonicalMediaId !== target.canonicalMediaId ||
      evidence.canonicalEpisodeId !== target.canonicalEpisodeId ||
      latestActivity?.getTime() !== evidence.observedEndAt?.getTime();
    if (!changed) {
      summary.partialEvidenceReused++;
      return;
    }
    evidence.sourceGeneration = summary.sourceGeneration;
    evidence.sourceVersion = SOURCE_VERSION;
    evidence.sourceUserId = viewer.sourceUserId;
    evidence.sourceItemId = target.sourceItemId;
    evidence.viewerId = viewer.id;
    evidence.canonicalMediaId = target.canonicalMediaId;
    evidence.canonicalEpisodeId = target.canonicalEpisodeId;
    evidence.observedEndAt = latestActivity;
    if (strongestChanged) {
      evidence.observedAt = activityAt;
      evidence.playbackPositionTicks = state.playbackPositionTicks;
      evidence.runtimeTicks = state.runtimeTicks;
      evidence.progressBasisPoints = state.progressBasisPoints;
    }
    evidence.identityResolutionState = IdentityResolutionState.RESOLVED;
    evidence.completionClassification = ViewingCompletionClassification.PARTIAL;
    evidence.completionDerivedAt = state.observedAt;
    evidence.provenance = 'jellyfin-current-user-data';
    await repository.save(evidence);
    summary.partialEvidenceUpdated++;
  }

  private async pruneObsoleteCurrentStates(
    summary: CurrentJellyfinViewingSummary,
    viewer: Viewer,
    targets: CurrentViewingTarget[],
    manager: EntityManager
  ): Promise<number> {
    const stateRepository = manager.getRepository(CurrentViewingState);
    const states = await stateRepository.findBy({
      viewerId: viewer.id,
      sourceScope: summary.sourceScope,
    });
    const activeIds = new Set(targets.map((target) => target.sourceItemId));
    const obsolete = states.filter(
      (state) => !activeIds.has(state.sourceItemId)
    );
    if (obsolete.length === 0) return 0;
    const evidence = await manager.getRepository(ViewingEvidence).findBy({
      source: SOURCE,
      sourceScope: summary.sourceScope,
      viewerId: viewer.id,
    });
    const removable: CurrentViewingState[] = [];
    for (const state of obsolete) {
      const meaningfulPartial =
        !state.played && (state.progressBasisPoints ?? 0) > 0;
      const durable = state.played
        ? evidence.some(
            (item) =>
              item.sourceItemId === state.sourceItemId &&
              item.canonicalMediaId === state.canonicalMediaId &&
              item.canonicalEpisodeId === state.canonicalEpisodeId &&
              item.completionClassification ===
                ViewingCompletionClassification.CONFIRMED
          )
        : meaningfulPartial
          ? evidence.some(
              (item) =>
                item.sourceItemId === state.sourceItemId &&
                item.canonicalMediaId === state.canonicalMediaId &&
                item.canonicalEpisodeId === state.canonicalEpisodeId &&
                item.completionClassification ===
                  ViewingCompletionClassification.PARTIAL
            )
          : true;
      if (durable) removable.push(state);
      else summary.currentStatesPruneBlocked++;
    }
    if (removable.length > 0) {
      await stateRepository.remove(removable);
      summary.currentStatesPruned += removable.length;
    }
    return obsolete.length - removable.length;
  }

  private async ensureConfirmedEvidence(
    summary: CurrentJellyfinViewingSummary,
    viewer: Viewer,
    target: CurrentViewingTarget,
    state: CurrentViewingState,
    manager: EntityManager
  ): Promise<void> {
    const repository = manager.getRepository(ViewingEvidence);
    const sourceActivityId = evidenceActivityId({
      sourceUserId: viewer.sourceUserId,
      sourceItemId: target.sourceItemId,
      lastPlayedAt: state.lastPlayedAt ?? null,
    });
    let existing = await repository.findOneBy({
      source: SOURCE,
      sourceScope: summary.sourceScope,
      sourceClass: SOURCE_CLASS,
      sourceActivityId,
    });
    if (!existing && !state.lastPlayedAt) {
      existing = await repository.findOneBy({
        source: SOURCE,
        sourceScope: summary.sourceScope,
        sourceClass: SOURCE_CLASS,
        sourceUserId: viewer.sourceUserId,
        sourceItemId: target.sourceItemId,
        viewerId: viewer.id,
        canonicalMediaId: target.canonicalMediaId,
        canonicalEpisodeId: target.canonicalEpisodeId ?? IsNull(),
        observedAt: IsNull(),
        observedEndAt: IsNull(),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
        provenance: 'jellyfin-current-user-data',
      });
      if (existing) {
        existing.sourceActivityId = sourceActivityId;
        existing.sourceGeneration = summary.sourceGeneration;
        existing.sourceVersion = SOURCE_VERSION;
        existing.completionDerivedAt = state.observedAt;
        await repository.save(existing);
      }
    }
    if (existing) {
      summary.confirmedEvidenceReused++;
      return;
    }
    await repository.save(
      new ViewingEvidence({
        source: SOURCE,
        sourceScope: summary.sourceScope,
        sourceClass: SOURCE_CLASS,
        sourceActivityId,
        sourceGeneration: summary.sourceGeneration,
        sourceVersion: SOURCE_VERSION,
        sourceUserId: viewer.sourceUserId,
        sourceItemId: target.sourceItemId,
        viewerId: viewer.id,
        canonicalMediaId: target.canonicalMediaId,
        canonicalEpisodeId: target.canonicalEpisodeId,
        observedAt: state.lastPlayedAt ?? null,
        observedEndAt: state.lastPlayedAt ?? null,
        playbackPositionTicks: state.playbackPositionTicks,
        runtimeTicks: state.runtimeTicks,
        progressBasisPoints: 10_000,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.CONFIRMED,
        completionDerivedAt: state.observedAt,
        provenance: 'jellyfin-current-user-data',
      })
    );
    summary.confirmedEvidenceCreated++;
  }

  private async normalizePersistedSentinels(
    summary: CurrentJellyfinViewingSummary,
    manager: EntityManager
  ): Promise<void> {
    const epoch = new Date(0);
    const states = await manager
      .getRepository(CurrentViewingState)
      .createQueryBuilder()
      .update(CurrentViewingState)
      .set({ lastPlayedAt: null })
      .where('"sourceScope" = :sourceScope', {
        sourceScope: summary.sourceScope,
      })
      .andWhere('"lastPlayedAt" = :epoch', { epoch })
      .execute();
    summary.sentinelStatesNormalized = states.affected ?? 0;
    const evidence = await manager
      .getRepository(ViewingEvidence)
      .createQueryBuilder()
      .update(ViewingEvidence)
      .set({ observedAt: null, observedEndAt: null })
      .where('"source" = :source', { source: SOURCE })
      .andWhere('"sourceScope" = :sourceScope', {
        sourceScope: summary.sourceScope,
      })
      .andWhere('"sourceClass" = :sourceClass', {
        sourceClass: SOURCE_CLASS,
      })
      .andWhere('"provenance" = :provenance', {
        provenance: 'jellyfin-current-user-data',
      })
      .andWhere('"observedAt" = :epoch', { epoch })
      .andWhere('"observedEndAt" = :epoch', { epoch })
      .execute();
    summary.sentinelEvidenceNormalized = evidence.affected ?? 0;
  }

  private updateUserCheckpoint(
    checkpoint: SourceCheckpoint,
    sourceGeneration: string,
    status: SourceCheckpointStatus,
    attemptedAt: Date,
    successfulAt?: Date
  ): void {
    checkpoint.sourceGeneration = sourceGeneration;
    checkpoint.status = status;
    checkpoint.lastAttemptAt = attemptedAt;
    if (successfulAt) checkpoint.lastSuccessfulAt = successfulAt;
  }

  private async markUserFailed(
    run: HydrationRun,
    viewer: ViewerTarget,
    summary: CurrentJellyfinViewingSummary,
    attemptedAt: Date
  ): Promise<void> {
    await this.runCoordinator.transaction(async (manager) => {
      const checkpoint = await this.runCoordinator.assertUserOwnership(
        manager,
        run,
        viewer.sourceUserId
      );
      this.updateUserCheckpoint(
        checkpoint,
        summary.sourceGeneration,
        SourceCheckpointStatus.FAILED,
        attemptedAt
      );
      await manager.getRepository(SourceCheckpoint).save(checkpoint);
    });
  }
}

const currentJellyfinViewing = new CurrentJellyfinViewingService();

export default currentJellyfinViewing;
