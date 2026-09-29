import Autobrr, {
  type AutobrrFilterOption,
  type FreshRelease,
} from '@server/api/autobrr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbMovieResult,
  TmdbSearchMovieResponse,
  TmdbSearchTvResponse,
  TmdbSeasonWithEpisodes,
  TmdbTvDetails,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import {
  FRESH_SYNC_STATE_ID,
  FreshCandidateStatus,
  FreshContinuityStatus,
} from '@server/constants/fresh';
import dataSource from '@server/datasource';
import FreshAdmissionOverride from '@server/entity/FreshAdmissionOverride';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshDiscoveryHistory from '@server/entity/FreshDiscoveryHistory';
import FreshManualResolution from '@server/entity/FreshManualResolution';
import FreshMedia from '@server/entity/FreshMedia';
import FreshObservation from '@server/entity/FreshObservation';
import { FreshSyncState } from '@server/entity/FreshSyncState';
import {
  evaluateMovieAdmission,
  evaluateTvAdmission,
  freshVisibleUntil,
  recurringIdentityForEvidence,
} from '@server/lib/fresh/history';
import {
  applyFreshMembership,
  evaluateAdmissionEvidence,
  selectContentRating,
  selectMovieAvailabilityDates,
} from '@server/lib/fresh/membership';
import {
  FRESH_COMPARISON_VERSION,
  freshSourceEvidenceKey,
  normalizeFreshTitle,
  validReleaseId,
} from '@server/lib/fresh/normalize';
import type {
  FreshDiagnosticCounts,
  FreshDiagnosticDecision,
  FreshDiagnosticsSnapshot,
  FreshFailureReason,
  FreshRunResult,
  FreshStage,
} from '@server/lib/fresh/types';
import { getSettings, type FreshSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { createHash } from 'crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { In, LessThan } from 'typeorm';

const MAX_SOURCE_PAGES = 10000;
const RESOLUTION_BATCH_SIZE = 100;
const RECONCILIATION_RESOLUTION_BATCH_SIZE = 250;
const TMDB_SEARCH_PAGE_LIMIT = 3;
const DAY = 86400000;
const STALE_RESOLUTION_MS = 30 * 60 * 1000;
const METADATA_REFRESH_MS = 7 * DAY;
const METADATA_REFRESH_BATCH_SIZE = 25;
const MAX_DECISIONS = 100;
const MAX_DECISIONS_PER_REASON = 10;

const stages: FreshStage[] = [
  'configuration',
  'filter_authentication',
  'source_history',
  'observation_persistence',
  'checkpoint_commit',
  'resolution_search',
  'projection_update',
  'retention',
  'reconciliation',
];

const emptyCounts = (): FreshDiagnosticCounts => ({
  newAutobrrReleases: null,
  persistedObservations: null,
  replayedObservations: null,
  uniqueCandidates: null,
  alreadyResolved: null,
  resolutionAttempts: null,
  resolved: null,
  noMatch: null,
  ambiguous: null,
  transientFailures: null,
  outsideFreshWindow: null,
  newFreshMedia: null,
  existingFreshMediaUpdated: null,
  expiredFreshMedia: null,
  currentFreshMedia: null,
});

class FreshRunError extends Error {
  constructor(
    public readonly stage: FreshStage,
    public readonly reason: FreshFailureReason
  ) {
    super(reason);
  }
}

class Diagnostics {
  public readonly snapshot: FreshDiagnosticsSnapshot;
  private readonly perReason = new Map<string, number>();

  constructor(operation: 'sync' | 'reconciliation', now: Date) {
    this.snapshot = {
      operation,
      outcome: 'running',
      startedAt: now.toISOString(),
      stages: Object.fromEntries(
        stages.map((stage) => [stage, 'not_started'])
      ) as FreshDiagnosticsSnapshot['stages'],
      counts: emptyCounts(),
      decisions: [],
      checkpoint: {},
    };
  }

  start(stage: FreshStage): void {
    this.snapshot.stages[stage] = 'running';
  }

  succeed(stage: FreshStage): void {
    this.snapshot.stages[stage] = 'succeeded';
  }

  fail(stage: FreshStage, reason: FreshFailureReason): void {
    this.snapshot.stages[stage] =
      reason === 'cancelled' ? 'cancelled' : 'failed';
    this.snapshot.failingStage = stage;
    this.snapshot.failureReason = reason;
    this.snapshot.outcome = reason === 'cancelled' ? 'cancelled' : 'failed';
  }

  decision(value: FreshDiagnosticDecision): void {
    const count = this.perReason.get(value.reason) ?? 0;
    if (count >= MAX_DECISIONS_PER_REASON) return;
    if (this.snapshot.decisions.length >= MAX_DECISIONS) return;
    this.perReason.set(value.reason, count + 1);
    this.snapshot.decisions.push({ ...value });
  }
}

export interface FreshEngineDependencies {
  database: DataSource;
  autobrr: (settings: FreshSettings) => Pick<Autobrr, 'filters' | 'page'>;
  tmdb: Pick<
    TheMovieDb,
    'searchMoviesStrict' | 'searchTvShowsStrict' | 'getMovie' | 'getTvShow'
  > &
    Partial<Pick<TheMovieDb, 'getTvSeason'>>;
  now: () => Date;
  cancelled: () => boolean;
  region?: () => string;
}

const sourceFingerprint = (settings: FreshSettings): string =>
  createHash('sha256')
    .update(JSON.stringify([settings.baseUrl, settings.filterId]))
    .digest('hex');

const retryAt = (
  status: FreshCandidateStatus,
  attempt: number,
  now: Date
): Date => {
  const minutes =
    status === FreshCandidateStatus.TRANSIENT_FAILURE
      ? [1, 5, 30, 120, 720][Math.min(attempt - 1, 4)]
      : [1440, 4320, 10080][Math.min(attempt - 1, 2)];
  return new Date(now.getTime() + minutes * 60000);
};

const toSafeReason = (error: unknown): FreshFailureReason => {
  if (error instanceof FreshRunError) return error.reason;
  const status = (error as { response?: { status?: number } })?.response
    ?.status;
  if (status === 429) return 'tmdb_rate_limited';
  return 'unexpected_failure';
};

export class FreshEngine {
  private cancelRequested = false;
  constructor(
    private readonly dependencies: FreshEngineDependencies = {
      database: dataSource,
      autobrr: (settings) => new Autobrr(settings.baseUrl, settings.apiToken),
      tmdb: new TheMovieDb(),
      now: () => new Date(),
      cancelled: () => false,
      region: () => getSettings().main.discoverRegion || 'US',
    }
  ) {}

  cancel(): void {
    this.cancelRequested = true;
  }

  async run(
    settings: FreshSettings,
    reconcile = false
  ): Promise<FreshRunResult> {
    this.cancelRequested = false;
    const startedAt = Date.now();
    const now = this.dependencies.now();
    const operation = reconcile ? 'reconciliation' : 'sync';
    const diagnostic = new Diagnostics(operation, now);
    logger.info(`Fresh ${operation} started`, { label: 'Fresh' });
    let state: FreshSyncState | undefined;
    try {
      diagnostic.start('configuration');
      if (!settings.enabled) {
        throw new FreshRunError('configuration', 'invalid_configuration');
      }
      diagnostic.succeed('configuration');

      const client = this.dependencies.autobrr(settings);
      diagnostic.start('filter_authentication');
      const filters = await client.filters();
      this.requireFilter(filters, settings.filterId);
      diagnostic.succeed('filter_authentication');

      state = await this.prepareState(settings, reconcile);
      diagnostic.snapshot.checkpoint.before =
        state.checkpointReleaseId ?? undefined;
      diagnostic.snapshot.continuityStatus = state.continuityStatus;

      diagnostic.start('source_history');
      diagnostic.start('observation_persistence');
      const ingestion = await this.ingest(client, settings, state, diagnostic);
      diagnostic.succeed('source_history');
      diagnostic.succeed('observation_persistence');

      if (this.cancelRequested || this.dependencies.cancelled()) {
        throw new FreshRunError('checkpoint_commit', 'cancelled');
      }

      diagnostic.start('checkpoint_commit');
      state = await this.commitCheckpoint(settings, state, ingestion.runHead);
      diagnostic.snapshot.checkpoint.after =
        state.checkpointReleaseId ?? undefined;
      diagnostic.snapshot.continuityStatus = state.continuityStatus;
      diagnostic.succeed('checkpoint_commit');

      diagnostic.start('resolution_search');
      await this.resolveDue(
        state,
        settings,
        diagnostic,
        reconcile
          ? RECONCILIATION_RESOLUTION_BATCH_SIZE
          : RESOLUTION_BATCH_SIZE,
        reconcile
      );
      if (reconcile) await this.refreshStaleMetadata(state, settings);
      if (state.eligibilitySchemaVersion < 1) {
        await this.reevaluate(settings);
        state = await this.dependencies.database
          .getRepository(FreshSyncState)
          .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
      }
      diagnostic.succeed('resolution_search');

      diagnostic.start('projection_update');
      await this.updateProjection(state, settings, diagnostic);
      diagnostic.succeed('projection_update');

      diagnostic.start('retention');
      await this.applyRetention(settings);
      diagnostic.succeed('retention');

      if (reconcile) {
        diagnostic.start('reconciliation');
        state.lastSuccessfulReconciliationAt = now;
        await this.dependencies.database
          .getRepository(FreshSyncState)
          .save(state);
        diagnostic.succeed('reconciliation');
      }
      diagnostic.snapshot.outcome = 'succeeded';
    } catch (error) {
      const runError =
        error instanceof FreshRunError
          ? error
          : new FreshRunError(
              diagnostic.snapshot.failingStage ??
                stages.find(
                  (stage) => diagnostic.snapshot.stages[stage] === 'running'
                ) ??
                'configuration',
              toSafeReason(error)
            );
      diagnostic.fail(runError.stage, runError.reason);
      if (state) {
        if (state.continuityStatus !== FreshContinuityStatus.GAP_PRESERVED) {
          state.continuityStatus =
            state.lastSuccessfulSyncAt &&
            ['checkpoint_missing', 'source_id_regression'].includes(
              runError.reason
            )
              ? FreshContinuityStatus.GAP_PRESERVED
              : FreshContinuityStatus.RECONCILIATION_REQUIRED;
        }
        await this.dependencies.database
          .getRepository(FreshSyncState)
          .save(state)
          .catch(() => undefined);
        diagnostic.snapshot.continuityStatus = state.continuityStatus;
      }
      logger.error('Fresh synchronization failed', {
        label: 'Fresh',
        stage: runError.stage,
        reason: runError.reason,
      });
    }

    diagnostic.snapshot.completedAt = this.dependencies.now().toISOString();
    const syncState = state
      ? await this.dependencies.database
          .getRepository(FreshSyncState)
          .findOneBy({ id: FRESH_SYNC_STATE_ID })
      : undefined;
    if (syncState?.lastSuccessfulSyncAt) {
      diagnostic.snapshot.lastGood = {
        timestamp: syncState.lastSuccessfulSyncAt.toISOString(),
        itemCount: await this.dependencies.database
          .getRepository(FreshMedia)
          .countBy({ active: true }),
      };
    }
    logger.info(`Fresh ${operation} completed`, {
      label: 'Fresh',
      outcome: diagnostic.snapshot.outcome,
      durationMs: Date.now() - startedAt,
      checkpointBefore: diagnostic.snapshot.checkpoint.before,
      checkpointAfter: diagnostic.snapshot.checkpoint.after,
      continuityStatus: diagnostic.snapshot.continuityStatus,
      newAutobrrReleases: diagnostic.snapshot.counts.newAutobrrReleases,
      uniqueCandidates: diagnostic.snapshot.counts.uniqueCandidates,
      resolutionAttempts: diagnostic.snapshot.counts.resolutionAttempts,
      currentFreshMedia: diagnostic.snapshot.counts.currentFreshMedia,
    });
    return { diagnostics: diagnostic.snapshot };
  }

  async reevaluate(settings: FreshSettings): Promise<number> {
    const state = await this.dependencies.database
      .getRepository(FreshSyncState)
      .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
    state.mediaEligibilityDays = settings.mediaEligibilityDays;
    state.freshVisibilityDays = settings.freshVisibilityDays;
    const repository = this.dependencies.database.getRepository(FreshMedia);
    const media = await repository.find();
    const region = this.dependencies.region?.() ?? 'US';
    const contentRatingFilterConfigured =
      settings.includeContentRatings.length > 0 ||
      settings.excludeContentRatings.length > 0;
    for (const item of media) {
      if (
        contentRatingFilterConfigured &&
        item.contentRatingRegion !== region
      ) {
        try {
          const details =
            item.mediaType === 'movie'
              ? await this.dependencies.tmdb.getMovie({ movieId: item.tmdbId })
              : await this.dependencies.tmdb.getTvShow({ tvId: item.tmdbId });
          this.applyMetadata(item, details, this.dependencies.now());
        } catch {
          // Never evaluate a certification cached for a different region.
          item.contentRating = '';
          item.contentRatingRegion = region;
        }
      }
      if (
        item.lastMatchedGeneration === state.generation ||
        state.continuityStatus === FreshContinuityStatus.GAP_PRESERVED
      ) {
        await this.refreshMediaProjection(item, state, settings);
      } else {
        item.active = false;
        item.membershipReason = 'source_generation_inactive';
      }
    }
    if (media.length) await repository.save(media);
    await this.dependencies.database
      .getRepository(FreshCandidate)
      .createQueryBuilder()
      .update()
      .set({
        status: FreshCandidateStatus.RESOLVED,
        lastFailureReason: null,
        nextAttemptAt: null,
      })
      .where('status = :outside', {
        outside: FreshCandidateStatus.OUTSIDE_WINDOW,
      })
      .andWhere('freshMediaId IS NOT NULL')
      .execute();
    state.eligibilitySchemaVersion = 1;
    await this.dependencies.database.getRepository(FreshSyncState).save(state);
    return repository.countBy({ active: true });
  }

  async resolveManually(
    candidateId: number,
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    expectedRevision: number,
    actorUserId: number | undefined,
    settings: FreshSettings
  ): Promise<{ candidate: FreshCandidate; media: FreshMedia }> {
    if (!Number.isSafeInteger(candidateId) || candidateId < 1) {
      throw new Error('invalid_candidate');
    }
    if (!Number.isSafeInteger(tmdbId) || tmdbId < 1) {
      throw new Error('invalid_tmdb_id');
    }
    if (!['movie', 'tv'].includes(mediaType))
      throw new Error('invalid_media_type');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error('invalid_revision');
    const candidate = await this.dependencies.database
      .getRepository(FreshCandidate)
      .findOneBy({ id: candidateId });
    if (!candidate) throw new Error('candidate_not_found');
    if (!candidate.sourceEvidenceKey) {
      candidate.sourceEvidenceKey = freshSourceEvidenceKey({
        sourceTitle: candidate.displayTitle,
        year: candidate.matchYear,
        seasonNumber: candidate.seasonKey,
        episodeNumber: candidate.specialEpisodeKey,
      });
    }
    if (candidate.revision !== expectedRevision)
      throw new Error('stale_candidate');
    if (
      ![FreshCandidateStatus.NO_MATCH, FreshCandidateStatus.AMBIGUOUS].includes(
        candidate.status
      )
    ) {
      throw new Error('candidate_not_actionable');
    }
    const state = await this.dependencies.database
      .getRepository(FreshSyncState)
      .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
    if (candidate.sourceGeneration !== state.generation) {
      throw new Error('candidate_not_current');
    }
    const details =
      mediaType === 'movie'
        ? await this.dependencies.tmdb.getMovie({ movieId: tmdbId })
        : await this.dependencies.tmdb.getTvShow({ tvId: tmdbId });
    if (details.id !== tmdbId) throw new Error('invalid_tmdb_response');
    const result = await this.finishResolved(
      candidate,
      details,
      state,
      settings,
      this.dependencies.now(),
      await this.seasonDetailsForCandidate(candidate, details.id, mediaType),
      { mediaType, actorUserId, expectedRevision }
    );
    return {
      candidate: await this.dependencies.database
        .getRepository(FreshCandidate)
        .findOneByOrFail({ id: candidate.id }),
      media: result.media,
    };
  }

  async resetManualResolution(
    candidateId: number,
    expectedRevision: number,
    settings: FreshSettings
  ): Promise<FreshCandidate> {
    const result = await this.dependencies.database.transaction(
      async (manager) => {
        const state = await manager
          .getRepository(FreshSyncState)
          .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
        const candidates = manager.getRepository(FreshCandidate);
        const candidate = await candidates.findOneBy({ id: candidateId });
        if (!candidate) throw new Error('candidate_not_found');
        if (
          candidate.revision !== expectedRevision ||
          candidate.sourceGeneration !== state.generation
        )
          throw new Error('stale_candidate');
        const resolution = await manager
          .getRepository(FreshManualResolution)
          .findOneBy({
            sourceEvidenceVersion: 1,
            sourceEvidenceKey: candidate.sourceEvidenceKey,
            active: true,
          });
        if (!resolution) throw new Error('manual_resolution_missing');
        resolution.active = false;
        resolution.revision += 1;
        await manager.getRepository(FreshManualResolution).save(resolution);
        const manualMediaId = candidate.freshMediaId;
        candidate.status =
          candidate.automaticStatus ?? FreshCandidateStatus.UNRESOLVED;
        candidate.tmdbId = candidate.automaticTmdbId ?? null;
        candidate.freshMediaId = candidate.automaticFreshMediaId ?? null;
        candidate.effectiveMediaType = candidate.mediaType;
        candidate.lastFailureReason = candidate.automaticFailureReason ?? null;
        candidate.revision += 1;
        const saved = await candidates.save(candidate);
        const mediaRepository = manager.getRepository(FreshMedia);
        if (manualMediaId && manualMediaId !== candidate.freshMediaId) {
          const stillReferenced = await candidates
            .createQueryBuilder('candidate')
            .where('candidate.sourceGeneration = :generation', {
              generation: state.generation,
            })
            .andWhere('candidate.freshMediaId = :mediaId', {
              mediaId: manualMediaId,
            })
            .getCount();
          if (!stillReferenced) {
            const manualMedia = await mediaRepository.findOneBy({
              id: manualMediaId,
            });
            if (manualMedia) {
              manualMedia.active = false;
              manualMedia.lastMatchedGeneration = 0;
              manualMedia.membershipReason = 'source_generation_inactive';
              await mediaRepository.save(manualMedia);
            }
          }
        }
        const automaticMedia = candidate.freshMediaId
          ? await mediaRepository.findOneBy({ id: candidate.freshMediaId })
          : undefined;
        if (automaticMedia)
          automaticMedia.lastMatchedGeneration = state.generation;
        return { saved, automaticMedia, state };
      }
    );
    if (result.automaticMedia) {
      await this.refreshMediaProjection(
        result.automaticMedia,
        result.state,
        settings
      );
      await this.dependencies.database
        .getRepository(FreshMedia)
        .save(result.automaticMedia);
    }
    return result.saved;
  }

  async setAdmissionOverride(
    candidateId: number,
    expectedRevision: number,
    settings: FreshSettings,
    actorUserId?: number
  ): Promise<FreshCandidate> {
    const now = this.dependencies.now();
    const result = await this.dependencies.database.transaction(
      async (manager) => {
        const state = await manager
          .getRepository(FreshSyncState)
          .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
        const candidates = manager.getRepository(FreshCandidate);
        const candidate = await candidates.findOneBy({ id: candidateId });
        if (!candidate) throw new Error('candidate_not_found');
        if (
          candidate.revision !== expectedRevision ||
          candidate.sourceGeneration !== state.generation
        )
          throw new Error('stale_candidate');
        if (!candidate.tmdbId || !candidate.freshMediaId)
          throw new Error('override_not_actionable');
        const effectiveMediaType =
          candidate.effectiveMediaType ?? candidate.mediaType;
        const identity = recurringIdentityForEvidence({
          ...candidate,
          mediaType: effectiveMediaType,
        });
        if (!identity) throw new Error('override_not_actionable');
        const histories = manager.getRepository(FreshDiscoveryHistory);
        const history = await histories.findOneBy({
          mediaType: effectiveMediaType,
          tmdbId: candidate.tmdbId,
          identityKind: identity.identityKind,
          seasonKey: identity.seasonKey,
          specialEpisodeKey: identity.specialEpisodeKey,
        });
        if (!history) throw new Error('override_not_actionable');
        if (
          history.visibleUntil &&
          history.visibleUntil.getTime() < now.getTime()
        )
          throw new Error('history_expired');
        const media = await manager
          .getRepository(FreshMedia)
          .findOneByOrFail({ id: candidate.freshMediaId });
        if (media.active) throw new Error('already_active');
        const repository = manager.getRepository(FreshAdmissionOverride);
        let override = await repository.findOneBy({
          mediaType: effectiveMediaType,
          tmdbId: candidate.tmdbId,
          identityKind: identity.identityKind,
          seasonKey: identity.seasonKey,
          specialEpisodeKey: identity.specialEpisodeKey,
        });
        if (!history.firstFreshAt) {
          history.firstFreshAt = override?.firstAdmittedAt ?? now;
          history.visibleUntil = freshVisibleUntil(
            history.firstFreshAt,
            settings.freshVisibilityDays
          );
          await histories.save(history);
        }
        override = new FreshAdmissionOverride({
          ...override,
          mediaType: effectiveMediaType,
          tmdbId: candidate.tmdbId,
          identityKind: identity.identityKind,
          seasonKey: identity.seasonKey,
          specialEpisodeKey: identity.specialEpisodeKey,
          active: true,
          revision: (override?.revision ?? 0) + 1,
          actorUserId: actorUserId ?? null,
          firstAdmittedAt: override?.firstAdmittedAt ?? history.firstFreshAt,
        });
        await repository.save(override);
        candidate.revision += 1;
        await candidates.save(candidate);
        return { candidate, media, state };
      }
    );
    await this.refreshMediaProjection(result.media, result.state, settings);
    await this.dependencies.database
      .getRepository(FreshMedia)
      .save(result.media);
    return result.candidate;
  }

  async removeAdmissionOverride(
    candidateId: number,
    expectedRevision: number,
    settings: FreshSettings
  ): Promise<FreshCandidate> {
    const result = await this.dependencies.database.transaction(
      async (manager) => {
        const state = await manager
          .getRepository(FreshSyncState)
          .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
        const candidates = manager.getRepository(FreshCandidate);
        const candidate = await candidates.findOneBy({ id: candidateId });
        if (!candidate) throw new Error('candidate_not_found');
        if (
          candidate.revision !== expectedRevision ||
          candidate.sourceGeneration !== state.generation
        )
          throw new Error('stale_candidate');
        if (!candidate.tmdbId || !candidate.freshMediaId)
          throw new Error('override_not_actionable');
        const mediaType = candidate.effectiveMediaType ?? candidate.mediaType;
        const identity = recurringIdentityForEvidence({
          ...candidate,
          mediaType,
        });
        if (!identity) throw new Error('override_not_actionable');
        const repository = manager.getRepository(FreshAdmissionOverride);
        const override = await repository.findOneBy({
          mediaType,
          tmdbId: candidate.tmdbId,
          identityKind: identity.identityKind,
          seasonKey: identity.seasonKey,
          specialEpisodeKey: identity.specialEpisodeKey,
          active: true,
        });
        if (!override) throw new Error('override_missing');
        override.active = false;
        override.revision += 1;
        await repository.save(override);
        candidate.revision += 1;
        await candidates.save(candidate);
        return {
          candidate,
          media: await manager
            .getRepository(FreshMedia)
            .findOneByOrFail({ id: candidate.freshMediaId }),
          state,
        };
      }
    );
    await this.refreshMediaProjection(result.media, result.state, settings);
    await this.dependencies.database
      .getRepository(FreshMedia)
      .save(result.media);
    return result.candidate;
  }

  private requireFilter(
    filters: AutobrrFilterOption[],
    filterId: number
  ): void {
    const selected = filters.find((filter) => filter.id === filterId);
    if (!selected)
      throw new FreshRunError('filter_authentication', 'filter_missing');
    if (selected.enabled === false)
      throw new FreshRunError('filter_authentication', 'filter_disabled');
  }

  private async prepareState(
    settings: FreshSettings,
    reconcile: boolean
  ): Promise<FreshSyncState> {
    const fingerprint = sourceFingerprint(settings);
    try {
      return await this.dependencies.database.transaction(async (manager) => {
        const repository = manager.getRepository(FreshSyncState);
        let state =
          (await repository.findOneBy({ id: FRESH_SYNC_STATE_ID })) ??
          new FreshSyncState();
        if (
          state.sourceFingerprint !== fingerprint ||
          state.filterId !== settings.filterId
        ) {
          const previousGeneration = state.generation;
          state = new FreshSyncState({
            ...state,
            id: FRESH_SYNC_STATE_ID,
            sourceFingerprint: fingerprint,
            filterId: settings.filterId,
            generation: state.generation + 1,
            checkpointReleaseId: null,
            continuityStatus: FreshContinuityStatus.UNINITIALIZED,
            mediaEligibilityDays: settings.mediaEligibilityDays,
            freshVisibilityDays: settings.freshVisibilityDays,
            lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
          });
          logger.info('Fresh source generation changed', {
            label: 'Fresh',
            previousGeneration,
            generation: state.generation,
            filterId: settings.filterId,
          });
        } else if (
          reconcile &&
          [
            FreshContinuityStatus.RECONCILIATION_REQUIRED,
            FreshContinuityStatus.GAP_PRESERVED,
          ].includes(state.continuityStatus)
        ) {
          state.generation += 1;
          state.checkpointReleaseId = null;
          state.continuityStatus = state.lastSuccessfulSyncAt
            ? FreshContinuityStatus.GAP_PRESERVED
            : FreshContinuityStatus.UNINITIALIZED;
        }
        state.mediaEligibilityDays = settings.mediaEligibilityDays;
        state.freshVisibilityDays = settings.freshVisibilityDays;
        return repository.save(state);
      });
    } catch (error) {
      if (error instanceof FreshRunError) throw error;
      throw new FreshRunError('observation_persistence', 'persistence_failed');
    }
  }

  private async ingest(
    client: Pick<Autobrr, 'page'>,
    settings: FreshSettings,
    state: FreshSyncState,
    diagnostic: Diagnostics
  ): Promise<{ runHead: string }> {
    let cursor = 0;
    let pages = 0;
    let runHead: string | undefined;
    let reachedCheckpoint = false;
    const checkpoint = state.checkpointReleaseId ?? undefined;
    diagnostic.snapshot.counts.newAutobrrReleases = 0;
    diagnostic.snapshot.counts.persistedObservations = 0;
    diagnostic.snapshot.counts.replayedObservations = 0;
    diagnostic.snapshot.counts.uniqueCandidates = 0;

    do {
      if (this.cancelRequested || this.dependencies.cancelled()) {
        throw new FreshRunError('source_history', 'cancelled');
      }
      if (++pages > MAX_SOURCE_PAGES) {
        throw new FreshRunError('source_history', 'invalid_source_response');
      }
      let page;
      try {
        page = await client.page({ id: settings.filterId }, cursor);
      } catch {
        throw new FreshRunError('source_history', 'source_unavailable');
      }
      if (!runHead) {
        runHead = page.newestReleaseId;
        if (!validReleaseId(runHead) && page.releaseIds.length) {
          throw new FreshRunError('source_history', 'invalid_source_response');
        }
        if (checkpoint && runHead && BigInt(runHead) < BigInt(checkpoint)) {
          throw new FreshRunError('source_history', 'source_id_regression');
        }
      }
      if (!runHead) break;

      const acceptedIds: string[] = [];
      for (const releaseId of page.releaseIds) {
        if (!validReleaseId(releaseId)) {
          throw new FreshRunError('source_history', 'invalid_source_response');
        }
        if (BigInt(releaseId) > BigInt(runHead)) continue;
        if (checkpoint && releaseId === checkpoint) {
          reachedCheckpoint = true;
          break;
        }
        acceptedIds.push(releaseId);
      }
      const accepted = new Set(acceptedIds);
      const releases = page.releases.filter((release) =>
        accepted.has(release.releaseId)
      );
      diagnostic.snapshot.counts.newAutobrrReleases! += acceptedIds.length;
      const persisted = await this.persistReleases(
        releases,
        state.generation,
        settings,
        diagnostic
      );
      diagnostic.snapshot.counts.persistedObservations! += persisted.inserted;
      diagnostic.snapshot.counts.replayedObservations! += persisted.replayed;
      diagnostic.snapshot.counts.uniqueCandidates! += persisted.newCandidates;

      if (reachedCheckpoint) break;
      cursor = page.nextCursor;
    } while (cursor);

    if (checkpoint && !reachedCheckpoint) {
      throw new FreshRunError('source_history', 'checkpoint_missing');
    }
    return { runHead: runHead ?? checkpoint ?? '0' };
  }

  private async persistReleases(
    releases: FreshRelease[],
    generation: number,
    settings: FreshSettings,
    diagnostic: Diagnostics
  ): Promise<{ inserted: number; replayed: number; newCandidates: number }> {
    try {
      return await this.dependencies.database.transaction(async (manager) => {
        let inserted = 0;
        let replayed = 0;
        let newCandidates = 0;
        for (const release of releases) {
          const observations = manager.getRepository(FreshObservation);
          if (
            await observations.existsBy({
              sourceGeneration: generation,
              releaseId: release.releaseId,
            })
          ) {
            replayed++;
            continue;
          }
          const normalizedTitle = normalizeFreshTitle(release.title);
          if (!normalizedTitle) continue;
          const matchYear = release.year;
          const seasonKey =
            release.mediaType === 'tv' &&
            (release.explicitSeason || release.explicitSpecial) &&
            release.seasonNumber >= 0
              ? release.seasonNumber
              : -1;
          const specialEpisodeKey =
            release.explicitSpecial && release.episodeNumber > 0
              ? release.episodeNumber
              : -1;
          const sourceEvidenceKey = freshSourceEvidenceKey({
            sourceTitle: release.title,
            year: release.year,
            seasonNumber: seasonKey,
            episodeNumber: specialEpisodeKey,
          });
          const candidates = manager.getRepository(FreshCandidate);
          let candidate = await candidates.findOneBy({
            sourceGeneration: generation,
            mediaType: release.mediaType,
            normalizedTitle,
            matchYear,
            seasonKey,
            specialEpisodeKey,
          });
          const observedAt = new Date(release.observedAt);
          if (!candidate) {
            candidate = await candidates.save(
              new FreshCandidate({
                sourceGeneration: generation,
                mediaType: release.mediaType,
                normalizedTitle,
                displayTitle: release.title,
                matchYear,
                seasonKey,
                specialEpisodeKey,
                explicitSeason: release.explicitSeason,
                explicitSpecial: release.explicitSpecial,
                comparisonVersion: FRESH_COMPARISON_VERSION,
                sourceEvidenceKey,
                effectiveMediaType: release.mediaType,
                firstObservedAt: observedAt,
                lastObservedAt: observedAt,
              })
            );
            newCandidates++;
          } else {
            if (observedAt < candidate.firstObservedAt)
              candidate.firstObservedAt = observedAt;
            if (observedAt > candidate.lastObservedAt)
              candidate.lastObservedAt = observedAt;
            candidate.explicitSeason ||= release.explicitSeason;
            candidate.explicitSpecial ||= release.explicitSpecial;
            candidate.revision += 1;
            await candidates.save(candidate);
            if (candidate.freshMediaId) {
              const mediaRepository = manager.getRepository(FreshMedia);
              const media = await mediaRepository.findOneBy({
                id: candidate.freshMediaId,
              });
              if (media) {
                if (observedAt > media.lastSeenAt)
                  media.lastSeenAt = observedAt;
                media.lastMatchedGeneration = generation;
                await mediaRepository.save(media);
                const identity = recurringIdentityForEvidence(candidate);
                if (identity) {
                  const histories = manager.getRepository(
                    FreshDiscoveryHistory
                  );
                  const history = await histories.findOneBy({
                    mediaType: media.mediaType,
                    tmdbId: media.tmdbId,
                    identityKind: identity.identityKind,
                    seasonKey: identity.seasonKey,
                    specialEpisodeKey: identity.specialEpisodeKey,
                  });
                  if (history) {
                    if (observedAt > history.lastObservedAt)
                      history.lastObservedAt = observedAt;
                    history.lastSeenGeneration = generation;
                    await histories.save(history);
                  }
                }
              }
            }
          }
          await observations.save(
            new FreshObservation({
              sourceGeneration: generation,
              releaseId: release.releaseId,
              filterId: settings.filterId,
              candidateId: candidate.id,
              mediaType: release.mediaType,
              title: release.title,
              sourceTitle: release.sourceTitle,
              normalizedTitle,
              year: release.year,
              seasonNumber: release.seasonNumber,
              episodeNumber: release.episodeNumber,
              explicitSeason: release.explicitSeason,
              explicitSpecial: release.explicitSpecial,
              comparisonVersion: FRESH_COMPARISON_VERSION,
              sourceEvidenceKey,
              availabilityType: release.availabilityType,
              observedAt,
            })
          );
          inserted++;
          diagnostic.decision({
            title: release.title,
            mediaType: release.mediaType,
            year: release.year || undefined,
            normalizedTitle,
            stage: 'observation_persistence',
            outcome: 'accepted',
            reason: 'source_observation_persisted',
          });
        }
        return { inserted, replayed, newCandidates };
      });
    } catch (error) {
      if (error instanceof FreshRunError) throw error;
      throw new FreshRunError('observation_persistence', 'persistence_failed');
    }
  }

  private async commitCheckpoint(
    settings: FreshSettings,
    expected: FreshSyncState,
    runHead: string
  ): Promise<FreshSyncState> {
    try {
      return await this.dependencies.database.transaction(async (manager) => {
        const repository = manager.getRepository(FreshSyncState);
        const current = await repository.findOneByOrFail({
          id: FRESH_SYNC_STATE_ID,
        });
        if (
          current.generation !== expected.generation ||
          current.sourceFingerprint !== expected.sourceFingerprint ||
          current.checkpointReleaseId !== expected.checkpointReleaseId
        ) {
          throw new FreshRunError('checkpoint_commit', 'persistence_failed');
        }
        if (runHead !== '0' && !validReleaseId(runHead)) {
          throw new FreshRunError(
            'checkpoint_commit',
            'invalid_source_response'
          );
        }
        current.checkpointReleaseId = runHead === '0' ? null : runHead;
        current.filterId = settings.filterId;
        current.mediaEligibilityDays = settings.mediaEligibilityDays;
        current.freshVisibilityDays = settings.freshVisibilityDays;
        current.continuityStatus =
          expected.continuityStatus === FreshContinuityStatus.GAP_PRESERVED
            ? FreshContinuityStatus.GAP_PRESERVED
            : FreshContinuityStatus.CURRENT;
        current.lastSuccessfulSyncAt = this.dependencies.now();
        return repository.save(current);
      });
    } catch (error) {
      if (error instanceof FreshRunError) throw error;
      throw new FreshRunError('checkpoint_commit', 'persistence_failed');
    }
  }

  private async resolveDue(
    state: FreshSyncState,
    settings: FreshSettings,
    diagnostic: Diagnostics,
    limit: number,
    includeLongTermRetries: boolean
  ): Promise<void> {
    const now = this.dependencies.now();
    const repository = this.dependencies.database.getRepository(FreshCandidate);
    await repository
      .createQueryBuilder()
      .update()
      .set({
        status: FreshCandidateStatus.TRANSIENT_FAILURE,
        nextAttemptAt: now,
        lastFailureReason: 'stale_resolution_recovered',
        resolutionStartedAt: null,
      })
      .where('status = :status', { status: FreshCandidateStatus.RESOLVING })
      .andWhere('resolutionStartedAt < :stale', {
        stale: new Date(now.getTime() - STALE_RESOLUTION_MS),
      })
      .execute();

    const dueStatuses = [
      FreshCandidateStatus.UNRESOLVED,
      FreshCandidateStatus.TRANSIENT_FAILURE,
      ...(includeLongTermRetries
        ? [FreshCandidateStatus.NO_MATCH, FreshCandidateStatus.AMBIGUOUS]
        : []),
    ];
    const due = await repository
      .createQueryBuilder('candidate')
      .where('candidate.sourceGeneration = :generation', {
        generation: state.generation,
      })
      .andWhere('candidate.status IN (:...dueStatuses)', { dueStatuses })
      .andWhere(
        '(candidate.nextAttemptAt IS NULL OR candidate.nextAttemptAt <= :now)'
      )
      .setParameters({
        now,
      })
      .orderBy('candidate.firstObservedAt', 'ASC')
      .addOrderBy('candidate.id', 'ASC')
      .take(limit)
      .getMany();

    diagnostic.snapshot.counts.alreadyResolved = await repository.countBy({
      sourceGeneration: state.generation,
      status: In([
        FreshCandidateStatus.RESOLVED,
        FreshCandidateStatus.OUTSIDE_WINDOW,
      ]),
    });
    diagnostic.snapshot.counts.resolutionAttempts = 0;
    diagnostic.snapshot.counts.resolved = 0;
    diagnostic.snapshot.counts.noMatch = 0;
    diagnostic.snapshot.counts.ambiguous = 0;
    diagnostic.snapshot.counts.transientFailures = 0;
    diagnostic.snapshot.counts.outsideFreshWindow = 0;
    diagnostic.snapshot.counts.newFreshMedia = 0;
    diagnostic.snapshot.counts.existingFreshMediaUpdated = 0;

    for (const selected of due) {
      if (this.cancelRequested || this.dependencies.cancelled()) {
        throw new FreshRunError('resolution_search', 'cancelled');
      }
      const candidate = await this.claimCandidate(selected.id, now);
      if (!candidate) continue;
      diagnostic.snapshot.counts.resolutionAttempts!++;
      try {
        const match = await this.resolveIdentity(candidate);
        if (match.kind === 'none') {
          await this.finishUnmatched(
            candidate,
            FreshCandidateStatus.NO_MATCH,
            'no_exact_match',
            now
          );
          diagnostic.snapshot.counts.noMatch!++;
          diagnostic.decision({
            title: candidate.displayTitle,
            mediaType: candidate.mediaType,
            year: candidate.matchYear || undefined,
            normalizedTitle: candidate.normalizedTitle,
            stage: 'resolution_search',
            outcome: 'rejected',
            reason: 'no_exact_match',
          });
          await this.reapplyManualResolution(candidate.id, state, settings);
        } else if (match.kind === 'ambiguous') {
          await this.finishUnmatched(
            candidate,
            FreshCandidateStatus.AMBIGUOUS,
            'ambiguous_exact_match',
            now
          );
          diagnostic.snapshot.counts.ambiguous!++;
          diagnostic.decision({
            title: candidate.displayTitle,
            mediaType: candidate.mediaType,
            year: candidate.matchYear || undefined,
            normalizedTitle: candidate.normalizedTitle,
            stage: 'resolution_search',
            outcome: 'rejected',
            reason: 'ambiguous_exact_match',
          });
          await this.reapplyManualResolution(candidate.id, state, settings);
        } else {
          const details =
            candidate.mediaType === 'movie'
              ? await this.dependencies.tmdb.getMovie({
                  movieId: match.result.id,
                })
              : await this.dependencies.tmdb.getTvShow({
                  tvId: match.result.id,
                });
          const saved = await this.finishResolved(
            candidate,
            details,
            state,
            settings,
            now,
            await this.seasonDetailsForCandidate(candidate, details.id)
          );
          if (saved.created) diagnostic.snapshot.counts.newFreshMedia!++;
          else diagnostic.snapshot.counts.existingFreshMediaUpdated!++;
          if (saved.admitted) diagnostic.snapshot.counts.resolved!++;
          else diagnostic.snapshot.counts.outsideFreshWindow!++;
          diagnostic.decision({
            title: candidate.displayTitle,
            mediaType: candidate.mediaType,
            year: candidate.matchYear || undefined,
            normalizedTitle: candidate.normalizedTitle,
            tmdbId: details.id,
            stage: 'resolution_search',
            outcome: 'resolved',
            reason: saved.admitted
              ? 'canonical_identity_resolved'
              : 'outside_eligibility_window',
          });
          await this.reapplyManualResolution(candidate.id, state, settings);
        }
      } catch (error) {
        if (error instanceof FreshRunError) throw error;
        const reason =
          toSafeReason(error) === 'tmdb_rate_limited'
            ? 'tmdb_rate_limited'
            : 'tmdb_unavailable';
        await this.finishUnmatched(
          candidate,
          FreshCandidateStatus.TRANSIENT_FAILURE,
          reason,
          now
        );
        diagnostic.snapshot.counts.transientFailures!++;
        diagnostic.decision({
          title: candidate.displayTitle,
          mediaType: candidate.mediaType,
          year: candidate.matchYear || undefined,
          normalizedTitle: candidate.normalizedTitle,
          stage: 'resolution_search',
          outcome: 'retry',
          reason,
        });
      }
    }
  }

  private async claimCandidate(
    id: number,
    now: Date
  ): Promise<FreshCandidate | undefined> {
    try {
      return await this.dependencies.database.transaction(async (manager) => {
        const repository = manager.getRepository(FreshCandidate);
        const candidate = await repository.findOneBy({ id });
        if (
          !candidate ||
          candidate.status === FreshCandidateStatus.RESOLVED ||
          candidate.status === FreshCandidateStatus.OUTSIDE_WINDOW
        )
          return undefined;
        candidate.status = FreshCandidateStatus.RESOLVING;
        candidate.resolutionStartedAt = now;
        candidate.lastAttemptAt = now;
        candidate.attemptCount += 1;
        return repository.save(candidate);
      });
    } catch (error) {
      if (error instanceof FreshRunError) throw error;
      throw new FreshRunError('resolution_search', 'persistence_failed');
    }
  }

  private async resolveIdentity(
    candidate: FreshCandidate
  ): Promise<
    | { kind: 'none' }
    | { kind: 'ambiguous' }
    | { kind: 'match'; result: TmdbMovieResult | TmdbTvResult }
  > {
    const year = candidate.matchYear || undefined;
    let primary = await this.searchExactIdentity(
      candidate,
      candidate.displayTitle,
      candidate.normalizedTitle,
      candidate.mediaType === 'tv' && candidate.seasonKey >= 0
        ? undefined
        : year
    );
    if (
      candidate.mediaType === 'tv' &&
      candidate.seasonKey >= 0 &&
      year &&
      primary.kind === 'ambiguous'
    ) {
      primary = await this.searchExactIdentity(
        candidate,
        candidate.displayTitle,
        candidate.normalizedTitle,
        year
      );
    }
    if (primary.kind !== 'none' || candidate.mediaType !== 'tv') return primary;
    const volumeFallback = candidate.displayTitle.match(
      /^(.*?)\s+Volume\s+\d+\s*$/i
    );
    if (!volumeFallback?.[1]?.trim()) return primary;
    return this.searchExactIdentity(
      candidate,
      volumeFallback[1].trim(),
      normalizeFreshTitle(volumeFallback[1]),
      undefined
    );
  }

  private async searchExactIdentity(
    candidate: FreshCandidate,
    query: string,
    expectedNormalizedTitle: string,
    year?: number
  ): Promise<
    | { kind: 'none' }
    | { kind: 'ambiguous' }
    | { kind: 'match'; result: TmdbMovieResult | TmdbTvResult }
  > {
    const found = new Map<number, TmdbMovieResult | TmdbTvResult>();
    let page = 1;
    let totalPages = 1;
    do {
      const response =
        candidate.mediaType === 'movie'
          ? await this.dependencies.tmdb.searchMoviesStrict({
              query: candidate.displayTitle,
              year,
              page,
            })
          : await this.dependencies.tmdb.searchTvShowsStrict({
              query,
              ...(year ? { year } : {}),
              page,
            });
      this.validateSearchResponse(response, page);
      totalPages = response.total_pages;
      for (const result of response.results) {
        const titles =
          candidate.mediaType === 'movie'
            ? [
                (result as TmdbMovieResult).title,
                (result as TmdbMovieResult).original_title,
              ]
            : [
                (result as TmdbTvResult).name,
                (result as TmdbTvResult).original_name,
              ];
        if (
          !titles.some(
            (title) => normalizeFreshTitle(title) === expectedNormalizedTitle
          )
        )
          continue;
        if (
          candidate.mediaType === 'movie' &&
          year &&
          (result as TmdbMovieResult).release_date?.slice(0, 4) !== String(year)
        )
          continue;
        if (
          candidate.mediaType === 'tv' &&
          year &&
          (result as TmdbTvResult).first_air_date?.slice(0, 4) !== String(year)
        )
          continue;
        found.set(result.id, result);
      }
      page++;
    } while (
      page <= totalPages &&
      page <= TMDB_SEARCH_PAGE_LIMIT &&
      found.size <= 1
    );
    if (totalPages > TMDB_SEARCH_PAGE_LIMIT) return { kind: 'ambiguous' };
    if (!found.size) return { kind: 'none' };
    if (found.size > 1) return { kind: 'ambiguous' };
    return { kind: 'match', result: [...found.values()][0] };
  }

  private validateSearchResponse(
    response: TmdbSearchMovieResponse | TmdbSearchTvResponse,
    page: number
  ): void {
    if (
      response.page !== page ||
      !Number.isInteger(response.total_pages) ||
      response.total_pages < 0 ||
      !Array.isArray(response.results)
    ) {
      throw new Error('Invalid TMDB search response');
    }
  }

  private async finishUnmatched(
    candidate: FreshCandidate,
    status: FreshCandidateStatus,
    reason: string,
    now: Date
  ): Promise<void> {
    try {
      await this.dependencies.database.transaction(async (manager) => {
        const repository = manager.getRepository(FreshCandidate);
        const current = await repository.findOneByOrFail({ id: candidate.id });
        current.status = status;
        current.automaticStatus = status;
        current.automaticTmdbId = null;
        current.automaticFreshMediaId = null;
        current.automaticFailureReason = reason;
        current.nextAttemptAt = retryAt(status, current.attemptCount, now);
        current.lastFailureReason = reason;
        current.resolutionStartedAt = null;
        current.effectiveMediaType = current.mediaType;
        current.revision += 1;
        await repository.save(current);
      });
    } catch (error) {
      if (error instanceof FreshRunError) throw error;
      if (
        error instanceof Error &&
        ['stale_candidate', 'source_evidence_collision'].includes(error.message)
      )
        throw error;
      throw new FreshRunError('resolution_search', 'persistence_failed');
    }
  }

  private async seasonDetailsForCandidate(
    candidate: FreshCandidate,
    tmdbId: number,
    mediaType: 'movie' | 'tv' = candidate.mediaType
  ): Promise<TmdbSeasonWithEpisodes | undefined> {
    const identity = recurringIdentityForEvidence({ ...candidate, mediaType });
    if (!identity || identity.identityKind === 'movie') return undefined;
    return this.dependencies.tmdb.getTvSeason?.({
      tvId: tmdbId,
      seasonNumber: identity.seasonKey,
    });
  }

  private async reapplyManualResolution(
    candidateId: number,
    state: FreshSyncState,
    settings: FreshSettings
  ): Promise<void> {
    const candidates = this.dependencies.database.getRepository(FreshCandidate);
    const candidate = await candidates.findOneByOrFail({ id: candidateId });
    if (!candidate.sourceEvidenceKey) return;
    const currentMatches = await candidates.countBy({
      sourceGeneration: state.generation,
      sourceEvidenceKey: candidate.sourceEvidenceKey,
    });
    if (currentMatches !== 1) {
      candidate.lastFailureReason = 'source_evidence_collision';
      candidate.revision += 1;
      await candidates.save(candidate);
      return;
    }
    const resolution = await this.dependencies.database
      .getRepository(FreshManualResolution)
      .findOneBy({
        sourceEvidenceVersion: 1,
        sourceEvidenceKey: candidate.sourceEvidenceKey,
        active: true,
      });
    if (!resolution) return;
    const details =
      resolution.mediaType === 'movie'
        ? await this.dependencies.tmdb.getMovie({ movieId: resolution.tmdbId })
        : await this.dependencies.tmdb.getTvShow({ tvId: resolution.tmdbId });
    if (details.id !== resolution.tmdbId)
      throw new Error('invalid_tmdb_response');
    await this.finishResolved(
      candidate,
      details,
      state,
      settings,
      this.dependencies.now(),
      await this.seasonDetailsForCandidate(
        candidate,
        details.id,
        resolution.mediaType
      ),
      {
        mediaType: resolution.mediaType,
        actorUserId: resolution.actorUserId ?? undefined,
        expectedRevision: candidate.revision,
        reapply: true,
      }
    );
  }

  private async upsertDiscoveryHistory(
    manager: EntityManager,
    candidate: FreshCandidate,
    media: FreshMedia,
    observations: FreshObservation[],
    state: FreshSyncState,
    settings: FreshSettings,
    seasonDetails?: TmdbSeasonWithEpisodes
  ): Promise<FreshDiscoveryHistory | undefined> {
    const identity = recurringIdentityForEvidence(candidate);
    if (!identity) return undefined;
    const ordered = [...observations].sort(
      (left, right) => left.observedAt.getTime() - right.observedAt.getTime()
    );
    const first = ordered[0]?.observedAt ?? candidate.firstObservedAt;
    const last = ordered.at(-1)?.observedAt ?? candidate.lastObservedAt;
    const repository = manager.getRepository(FreshDiscoveryHistory);
    let history = await repository.findOneBy({
      mediaType: media.mediaType,
      tmdbId: media.tmdbId,
      identityKind: identity.identityKind,
      seasonKey: identity.seasonKey,
      specialEpisodeKey: identity.specialEpisodeKey,
    });

    if (!history) {
      const decision =
        identity.identityKind === 'movie'
          ? evaluateMovieAdmission(
              media,
              ordered,
              settings.mediaEligibilityDays
            )
          : seasonDetails
            ? evaluateTvAdmission(
                seasonDetails,
                first,
                identity,
                settings.mediaEligibilityDays
              )
            : {
                eligible: false,
                reason: 'tv_activity_unknown',
                firstObservedAt: first,
                activitySource: 'unavailable',
              };
      history = new FreshDiscoveryHistory({
        mediaType: media.mediaType,
        tmdbId: media.tmdbId,
        identityKind: identity.identityKind,
        seasonKey: identity.seasonKey,
        specialEpisodeKey: identity.specialEpisodeKey,
        admitted: decision?.eligible ?? false,
        firstObservedAt: first,
        lastObservedAt: last,
        firstFreshAt: decision?.eligible ? first : null,
        visibleUntil: decision?.eligible
          ? freshVisibleUntil(first, settings.freshVisibilityDays)
          : null,
        activityDate: decision?.activityDate ?? null,
        activitySource: decision?.activitySource ?? 'unavailable',
        admissionReason: decision?.reason ?? 'not_evaluated',
        automaticReasons: [decision?.reason ?? 'not_evaluated'],
        firstSeenGeneration: state.generation,
        lastSeenGeneration: state.generation,
      });
    } else {
      // firstObservedAt/firstFreshAt form the irreversible Fresh clock. A
      // later replay, source generation, PROPER, or quality variant may add
      // evidence, but can never move that clock in either direction.
      if (last > history.lastObservedAt) history.lastObservedAt = last;
      history.lastSeenGeneration = state.generation;
      // Provider/date absence is not a stable exclusion. Permit a later
      // reconciliation to complete it, while stable admission/exclusion is
      // irreversible for this recurring identity.
      if (
        !history.admitted &&
        ['tv_activity_unknown', 'not_evaluated'].includes(
          history.admissionReason
        ) &&
        identity.identityKind !== 'movie' &&
        seasonDetails
      ) {
        const decision = evaluateTvAdmission(
          seasonDetails,
          history.firstObservedAt,
          identity,
          settings.mediaEligibilityDays
        );
        history.activityDate = decision.activityDate ?? null;
        history.activitySource = decision.activitySource;
        history.admissionReason = decision.reason;
        history.automaticReasons = [decision.reason];
        if (decision.eligible) {
          history.admitted = true;
          history.firstFreshAt = history.firstObservedAt;
          history.visibleUntil = freshVisibleUntil(
            history.firstFreshAt,
            settings.freshVisibilityDays
          );
        }
      }
    }
    return repository.save(history);
  }

  private async finishResolved(
    candidate: FreshCandidate,
    details: TmdbMovieDetails | TmdbTvDetails,
    state: FreshSyncState,
    settings: FreshSettings,
    now: Date,
    seasonDetails?: TmdbSeasonWithEpisodes,
    manual?: {
      mediaType: 'movie' | 'tv';
      actorUserId?: number;
      expectedRevision: number;
      reapply?: boolean;
    }
  ): Promise<{ created: boolean; admitted: boolean; media: FreshMedia }> {
    try {
      return await this.dependencies.database.transaction(async (manager) => {
        const mediaRepository = manager.getRepository(FreshMedia);
        const effectiveMediaType = manual?.mediaType ?? candidate.mediaType;
        const currentCandidate = await manager
          .getRepository(FreshCandidate)
          .findOneByOrFail({ id: candidate.id });
        if (
          manual &&
          (currentCandidate.revision !== manual.expectedRevision ||
            currentCandidate.sourceGeneration !== state.generation)
        ) {
          throw new Error('stale_candidate');
        }
        let media = await mediaRepository.findOneBy({
          mediaType: effectiveMediaType,
          tmdbId: details.id,
        });
        const created = !media;
        const observations = await manager
          .getRepository(FreshObservation)
          .findBy({ candidateId: candidate.id });
        const observedFirstSeenAt = observations.reduce(
          (minimum, observation) =>
            observation.observedAt < minimum ? observation.observedAt : minimum,
          candidate.firstObservedAt
        );
        const lastSeenAt = observations.reduce(
          (maximum, observation) =>
            observation.observedAt > maximum ? observation.observedAt : maximum,
          candidate.lastObservedAt
        );
        media = new FreshMedia({
          ...media,
          mediaType: effectiveMediaType,
          tmdbId: details.id,
          active: media?.active ?? false,
          admitted: media?.admitted ?? false,
          lastMatchedGeneration: state.generation,
          firstSeenAt: media?.firstSeenAt ?? observedFirstSeenAt,
          lastSeenAt:
            media?.lastSeenAt && media.lastSeenAt > lastSeenAt
              ? media.lastSeenAt
              : lastSeenAt,
          resolvedAt: media?.resolvedAt ?? now,
          metadataRefreshedAt: now,
          displayTitle: media?.displayTitle ?? candidate.displayTitle,
          sortTitle:
            media?.sortTitle ?? normalizeFreshTitle(candidate.displayTitle),
          originalTitle: media?.originalTitle ?? candidate.displayTitle,
        });
        this.applyMetadata(media, details, now);
        const history = await this.upsertDiscoveryHistory(
          manager,
          new FreshCandidate({ ...candidate, mediaType: effectiveMediaType }),
          media,
          observations,
          state,
          settings,
          seasonDetails
        );
        if (history?.admitted && history.firstFreshAt) {
          media.admitted = true;
          media.firstSeenAt = history.firstFreshAt;
          media.membershipReason = history.admissionReason;
        } else {
          media.admitted = false;
          media.membershipReason =
            history?.admissionReason ??
            (effectiveMediaType === 'tv'
              ? 'season_unknown'
              : 'outside_eligibility_window');
        }
        if (history || effectiveMediaType === 'movie') {
          applyFreshMembership(media, settings, now);
        } else {
          media.active = false;
          media.automaticReasons = ['season_unknown'];
        }
        media = await mediaRepository.save(media);
        const candidates = manager.getRepository(FreshCandidate);
        const current = currentCandidate;
        if (!current.sourceEvidenceKey && candidate.sourceEvidenceKey) {
          current.sourceEvidenceKey = candidate.sourceEvidenceKey;
        }
        current.status = FreshCandidateStatus.RESOLVED;
        current.tmdbId = details.id;
        if (!manual) {
          current.automaticStatus = FreshCandidateStatus.RESOLVED;
          current.automaticTmdbId = details.id;
          current.automaticFreshMediaId = media.id;
          current.automaticFailureReason = null;
        }
        current.effectiveMediaType = candidate.mediaType;
        current.freshMediaId = media.id;
        current.resolvedAt = current.resolvedAt ?? now;
        current.resolutionStartedAt = null;
        current.nextAttemptAt = null;
        current.lastFailureReason = null;
        current.revision += 1;
        await candidates.save(current);
        if (manual) {
          current.effectiveMediaType = manual.mediaType;
          await candidates.save(current);
          const automaticMediaId = current.automaticFreshMediaId;
          if (automaticMediaId && automaticMediaId !== media.id) {
            const stillReferenced = await candidates
              .createQueryBuilder('candidate')
              .where('candidate.sourceGeneration = :generation', {
                generation: state.generation,
              })
              .andWhere('candidate.id != :candidateId', {
                candidateId: current.id,
              })
              .andWhere('candidate.freshMediaId = :mediaId', {
                mediaId: automaticMediaId,
              })
              .getCount();
            if (!stillReferenced) {
              const automaticMedia = await mediaRepository.findOneBy({
                id: automaticMediaId,
              });
              if (automaticMedia) {
                automaticMedia.active = false;
                automaticMedia.lastMatchedGeneration = 0;
                automaticMedia.membershipReason = 'source_generation_inactive';
                await mediaRepository.save(automaticMedia);
              }
            }
          }
        }
        if (manual && !manual.reapply) {
          const resolutions = manager.getRepository(FreshManualResolution);
          const collisionCount = await candidates.countBy({
            sourceEvidenceKey: current.sourceEvidenceKey,
            sourceGeneration: state.generation,
          });
          if (!current.sourceEvidenceKey || collisionCount !== 1)
            throw new Error('source_evidence_collision');
          let resolution = await resolutions.findOneBy({
            sourceEvidenceVersion: 1,
            sourceEvidenceKey: current.sourceEvidenceKey,
          });
          resolution = new FreshManualResolution({
            ...resolution,
            sourceEvidenceVersion: 1,
            sourceEvidenceKey: current.sourceEvidenceKey,
            mediaType: manual.mediaType,
            tmdbId: details.id,
            canonicalTitle:
              manual.mediaType === 'movie'
                ? (details as TmdbMovieDetails).title
                : (details as TmdbTvDetails).name,
            canonicalDate:
              manual.mediaType === 'movie'
                ? (details as TmdbMovieDetails).release_date || null
                : (details as TmdbTvDetails).first_air_date || null,
            active: true,
            revision: (resolution?.revision ?? 0) + 1,
            actorUserId: manual.actorUserId ?? null,
          });
          await resolutions.save(resolution);
        }
        return { created, admitted: media.admitted, media };
      });
    } catch (error) {
      if (error instanceof FreshRunError) throw error;
      if (
        error instanceof Error &&
        ['stale_candidate', 'source_evidence_collision'].includes(error.message)
      )
        throw error;
      throw new FreshRunError('resolution_search', 'persistence_failed');
    }
  }

  private async updateProjection(
    state: FreshSyncState,
    settings: FreshSettings,
    diagnostic: Diagnostics
  ): Promise<void> {
    const candidateRepository =
      this.dependencies.database.getRepository(FreshCandidate);
    const unresolved = await candidateRepository
      .createQueryBuilder('candidate')
      .where('candidate.sourceGeneration = :generation', {
        generation: state.generation,
      })
      .andWhere('candidate.status IN (:...statuses)', {
        statuses: [
          FreshCandidateStatus.UNRESOLVED,
          FreshCandidateStatus.RESOLVING,
          FreshCandidateStatus.TRANSIENT_FAILURE,
        ],
      })
      .getCount();
    const mediaRepository =
      this.dependencies.database.getRepository(FreshMedia);
    const before = await mediaRepository.countBy({ active: true });
    const mediaToEvaluate =
      state.continuityStatus !== FreshContinuityStatus.GAP_PRESERVED &&
      !unresolved
        ? await mediaRepository.find()
        : await mediaRepository.findBy({
            lastMatchedGeneration: state.generation,
          });
    for (const media of mediaToEvaluate) {
      await this.refreshMediaProjection(media, state, settings);
    }
    if (mediaToEvaluate.length) await mediaRepository.save(mediaToEvaluate);
    const after = await mediaRepository.countBy({ active: true });
    diagnostic.snapshot.counts.expiredFreshMedia = Math.max(0, before - after);
    diagnostic.snapshot.counts.currentFreshMedia = after;
  }

  private async refreshMediaProjection(
    media: FreshMedia,
    state: FreshSyncState,
    settings: FreshSettings
  ): Promise<void> {
    const histories = await this.dependencies.database
      .getRepository(FreshDiscoveryHistory)
      .findBy({ mediaType: media.mediaType, tmdbId: media.tmdbId });
    if (media.lastMatchedGeneration !== state.generation) {
      media.active = false;
      media.membershipReason = 'source_generation_inactive';
      media.automaticReasons = ['source_generation_inactive'];
      return;
    }
    if (!histories.length) {
      if (!media.admitted && media.mediaType === 'movie') {
        this.applyAdmissionEvidence(
          media,
          await this.observationsForMedia(media.id),
          settings.mediaEligibilityDays
        );
      }
      if (media.admitted && media.lastMatchedGeneration === state.generation) {
        applyFreshMembership(media, settings, this.dependencies.now());
      } else if (
        !media.admitted &&
        media.membershipReason === 'eligibility_unknown'
      ) {
        media.active = false;
        media.automaticReasons = ['eligibility_unknown'];
      } else {
        media.active = false;
        media.membershipReason = 'source_generation_inactive';
        media.automaticReasons = ['source_generation_inactive'];
      }
      return;
    }
    const overrides = await this.dependencies.database
      .getRepository(FreshAdmissionOverride)
      .findBy({
        mediaType: media.mediaType,
        tmdbId: media.tmdbId,
        active: true,
      });
    const overridden = new Set(
      overrides.map(
        (value) =>
          `${value.identityKind}:${value.seasonKey}:${value.specialEpisodeKey}`
      )
    );
    const now = this.dependencies.now();
    const effective = histories
      .filter((history) => history.lastSeenGeneration === state.generation)
      .filter((history) => history.firstFreshAt && history.visibleUntil)
      .filter(
        (history) => (history.visibleUntil as Date).getTime() >= now.getTime()
      )
      .filter(
        (history) =>
          history.admitted ||
          overridden.has(
            `${history.identityKind}:${history.seasonKey}:${history.specialEpisodeKey}`
          )
      )
      .sort((left, right) => {
        const firstFresh =
          (right.firstFreshAt?.getTime() ?? 0) -
          (left.firstFreshAt?.getTime() ?? 0);
        if (firstFresh) return firstFresh;
        if (right.seasonKey !== left.seasonKey)
          return right.seasonKey - left.seasonKey;
        return right.id - left.id;
      });
    const selected = effective[0];
    if (!selected?.firstFreshAt) {
      media.active = false;
      media.admitted = histories.some((history) => history.admitted);
      media.membershipReason = histories.some(
        (history) => history.lastSeenGeneration === state.generation
      )
        ? histories.some((history) => history.admitted)
          ? 'visibility_expired'
          : (histories[0]?.admissionReason ?? 'outside_eligibility_window')
        : 'source_generation_inactive';
      media.automaticReasons = [media.membershipReason];
      return;
    }
    media.admitted = true;
    media.firstSeenAt = selected.firstFreshAt;
    media.lastSeenAt = histories.reduce(
      (maximum, history) =>
        history.lastObservedAt > maximum ? history.lastObservedAt : maximum,
      selected.lastObservedAt
    );
    const automatic = applyFreshMembership(media, settings, now);
    const overrideActive = overridden.has(
      `${selected.identityKind}:${selected.seasonKey}:${selected.specialEpisodeKey}`
    );
    if (overrideActive && !automatic.active) {
      media.active = true;
      media.membershipReason = 'override_active';
    }
  }

  private async refreshStaleMetadata(
    state: FreshSyncState,
    settings: FreshSettings
  ): Promise<void> {
    const now = this.dependencies.now();
    const repository = this.dependencies.database.getRepository(FreshMedia);
    const stale = await repository.find({
      where: {
        lastMatchedGeneration: state.generation,
        metadataRefreshedAt: LessThan(
          new Date(now.getTime() - METADATA_REFRESH_MS)
        ),
      },
      order: { metadataRefreshedAt: 'ASC', id: 'ASC' },
      take: METADATA_REFRESH_BATCH_SIZE,
    });
    for (const media of stale) {
      if (this.cancelRequested || this.dependencies.cancelled()) {
        throw new FreshRunError('resolution_search', 'cancelled');
      }
      let details: TmdbMovieDetails | TmdbTvDetails;
      try {
        details =
          media.mediaType === 'movie'
            ? await this.dependencies.tmdb.getMovie({ movieId: media.tmdbId })
            : await this.dependencies.tmdb.getTvShow({ tvId: media.tmdbId });
      } catch {
        // Preserve the last-good snapshot and leave it due for a later retry.
        continue;
      }
      this.applyMetadata(media, details, now);
      await this.refreshMediaProjection(media, state, settings);
      try {
        await repository.save(media);
      } catch {
        throw new FreshRunError('resolution_search', 'persistence_failed');
      }
    }
  }

  private applyMetadata(
    media: FreshMedia,
    details: TmdbMovieDetails | TmdbTvDetails,
    now: Date
  ): void {
    if (media.mediaType === 'movie') {
      const movie = details as TmdbMovieDetails;
      media.displayTitle = movie.title;
      media.originalTitle = movie.original_title;
      media.mediaDate = movie.release_date || null;
      const availabilityDates = selectMovieAvailabilityDates(
        movie,
        this.dependencies.region?.() ?? 'US'
      );
      media.digitalReleaseDate = availabilityDates.digital;
      media.physicalReleaseDate = availabilityDates.physical;
      media.adult = movie.adult;
      media.video = movie.video;
      media.originCountries = [];
    } else {
      const tv = details as TmdbTvDetails;
      media.displayTitle = tv.name;
      media.originalTitle = tv.original_name;
      media.mediaDate = tv.first_air_date || null;
      media.digitalReleaseDate = null;
      media.physicalReleaseDate = null;
      media.adult = null;
      media.video = null;
      media.originCountries = tv.origin_country ?? [];
    }
    media.sortTitle = normalizeFreshTitle(media.displayTitle);
    media.posterPath = details.poster_path ?? null;
    media.backdropPath = details.backdrop_path ?? null;
    media.overview = details.overview ?? '';
    media.originalLanguage = details.original_language ?? '';
    media.popularity = details.popularity ?? 0;
    media.voteAverage = details.vote_average ?? 0;
    media.voteCount = details.vote_count ?? 0;
    media.genreIds = details.genres?.map((genre) => genre.id) ?? [];
    media.contentRatingRegion = this.dependencies.region?.() ?? 'US';
    media.contentRating = selectContentRating(
      media.mediaType,
      details,
      media.contentRatingRegion
    );
    media.metadataRefreshedAt = now;
  }

  private applyAdmissionEvidence(
    media: FreshMedia,
    observations: Pick<FreshObservation, 'availabilityType' | 'observedAt'>[],
    mediaEligibilityDays: number
  ): void {
    const evidence = evaluateAdmissionEvidence(
      media,
      observations,
      mediaEligibilityDays
    );
    const qualifying = evidence.selected?.observation;
    if (evidence.status === 'qualifying' && qualifying && !media.admitted) {
      media.admitted = true;
      media.firstSeenAt = qualifying.observedAt;
    } else if (
      evidence.status === 'qualifying' &&
      qualifying &&
      qualifying.observedAt < media.firstSeenAt
    ) {
      media.firstSeenAt = qualifying.observedAt;
    } else if (!media.admitted) {
      media.membershipReason =
        evidence.status === 'unknown'
          ? 'eligibility_unknown'
          : 'outside_eligibility_window';
    }
  }

  private observationsForMedia(mediaId: number): Promise<FreshObservation[]> {
    return this.dependencies.database
      .getRepository(FreshObservation)
      .createQueryBuilder('observation')
      .innerJoin(
        FreshCandidate,
        'candidate',
        'candidate.id = observation.candidateId'
      )
      .where('candidate.freshMediaId = :mediaId', { mediaId })
      .getMany();
  }

  private async applyRetention(settings: FreshSettings): Promise<void> {
    const days = Math.max(180, settings.mediaEligibilityDays + 30);
    const cutoff = new Date(this.dependencies.now().getTime() - days * DAY);
    const observations =
      this.dependencies.database.getRepository(FreshObservation);
    await observations.delete({ observedAt: LessThan(cutoff) });
    const candidates = this.dependencies.database.getRepository(FreshCandidate);
    const expired = await candidates.findBy({
      firstObservedAt: LessThan(cutoff),
    });
    for (const candidate of expired) {
      if (!(await observations.existsBy({ candidateId: candidate.id }))) {
        await candidates.remove(candidate);
      }
    }
  }
}

export const freshEngine = new FreshEngine();
