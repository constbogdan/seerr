import Autobrr, { type AutobrrFilterOption } from '@server/api/autobrr';
import {
  FRESH_CANDIDATE_PAGE_SIZE,
  FRESH_SYNC_STATE_ID,
  FreshCandidateStatus,
  FreshContinuityStatus,
  MAX_FRESH_VISIBILITY_DAYS,
  MAX_MEDIA_ELIGIBILITY_DAYS,
  MIN_FRESH_VISIBILITY_DAYS,
  MIN_MEDIA_ELIGIBILITY_DAYS,
} from '@server/constants/fresh';
import dataSource from '@server/datasource';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshMedia from '@server/entity/FreshMedia';
import FreshObservation from '@server/entity/FreshObservation';
import { FreshSyncState } from '@server/entity/FreshSyncState';
import { freshEngine } from '@server/lib/fresh/engine';
import { evaluateAdmissionEvidence } from '@server/lib/fresh/membership';
import type {
  FreshCandidateDiagnosticQuery,
  FreshCandidateDiagnosticResponse,
  FreshCandidateDiagnosticStatus,
  FreshDiagnosticsSnapshot,
} from '@server/lib/fresh/types';
import type { FreshSettings } from '@server/lib/settings';
import { In, type DataSource, type SelectQueryBuilder } from 'typeorm';

const contentFilterReasons = [
  'excluded_genre',
  'excluded_original_language',
  'excluded_content_rating',
  'below_tmdb_score',
  'below_tmdb_vote_count',
];

const diagnosticStatus = (
  candidate: FreshCandidate
): FreshCandidateDiagnosticStatus => {
  if (candidate.status === FreshCandidateStatus.NO_MATCH) return 'no_match';
  if (candidate.status === FreshCandidateStatus.AMBIGUOUS) return 'ambiguous';
  if (candidate.status === FreshCandidateStatus.TRANSIENT_FAILURE)
    return 'temporary_failure';
  if (candidate.status === FreshCandidateStatus.UNRESOLVED) return 'pending';
  if (candidate.status === FreshCandidateStatus.RESOLVING) return 'resolving';
  const media = candidate.freshMedia;
  if (media?.membershipReason === 'eligibility_unknown')
    return 'eligibility_unknown';
  if (
    candidate.status === FreshCandidateStatus.OUTSIDE_WINDOW ||
    (media && !media.admitted)
  )
    return 'outside_eligibility_window';
  if (media?.membershipReason === 'visibility_expired')
    return 'visibility_expired';
  if (
    media?.membershipReason &&
    contentFilterReasons.includes(media.membershipReason)
  )
    return 'excluded_content_filter';
  if (media?.active) return 'active_fresh';
  return 'resolved';
};

const applyDiagnosticStatus = (
  query: SelectQueryBuilder<FreshCandidate>,
  status: FreshCandidateDiagnosticStatus
) => {
  if (status === 'all') return;
  if (status === 'no_match')
    query.andWhere('candidate.status = :candidateStatus', {
      candidateStatus: FreshCandidateStatus.NO_MATCH,
    });
  else if (status === 'ambiguous')
    query.andWhere('candidate.status = :candidateStatus', {
      candidateStatus: FreshCandidateStatus.AMBIGUOUS,
    });
  else if (status === 'temporary_failure')
    query.andWhere('candidate.status = :candidateStatus', {
      candidateStatus: FreshCandidateStatus.TRANSIENT_FAILURE,
    });
  else if (status === 'pending')
    query.andWhere('candidate.status = :candidateStatus', {
      candidateStatus: FreshCandidateStatus.UNRESOLVED,
    });
  else if (status === 'resolving')
    query.andWhere('candidate.status = :candidateStatus', {
      candidateStatus: FreshCandidateStatus.RESOLVING,
    });
  else if (status === 'resolved')
    query.andWhere('candidate.status = :candidateStatus', {
      candidateStatus: FreshCandidateStatus.RESOLVED,
    });
  else if (status === 'outside_eligibility_window')
    query.andWhere(
      `(candidate.status = :outsideStatus OR
        (candidate.status = :resolvedStatus AND media.admitted = :notAdmitted
          AND (media.membershipReason IS NULL OR media.membershipReason != :unknownReason)))`,
      {
        outsideStatus: FreshCandidateStatus.OUTSIDE_WINDOW,
        resolvedStatus: FreshCandidateStatus.RESOLVED,
        notAdmitted: false,
        unknownReason: 'eligibility_unknown',
      }
    );
  else if (status === 'eligibility_unknown')
    query
      .andWhere('candidate.status = :resolvedStatus', {
        resolvedStatus: FreshCandidateStatus.RESOLVED,
      })
      .andWhere('media.membershipReason = :membershipReason', {
        membershipReason: 'eligibility_unknown',
      });
  else if (status === 'needs_attention')
    query.andWhere('candidate.status IN (:...attentionStatuses)', {
      attentionStatuses: [
        FreshCandidateStatus.NO_MATCH,
        FreshCandidateStatus.AMBIGUOUS,
      ],
    });
  else if (status === 'excluded_content_filter')
    query
      .andWhere('candidate.status = :resolvedStatus', {
        resolvedStatus: FreshCandidateStatus.RESOLVED,
      })
      .andWhere('media.membershipReason IN (:...contentFilterReasons)', {
        contentFilterReasons,
      });
  else if (status === 'visibility_expired')
    query
      .andWhere('candidate.status = :resolvedStatus', {
        resolvedStatus: FreshCandidateStatus.RESOLVED,
      })
      .andWhere('media.membershipReason = :membershipReason', {
        membershipReason: 'visibility_expired',
      });
  else if (status === 'active_fresh')
    query
      .andWhere('candidate.status = :resolvedStatus', {
        resolvedStatus: FreshCandidateStatus.RESOLVED,
      })
      .andWhere('media.active = :active', { active: true });
};

export interface PublicFreshSettings extends Omit<FreshSettings, 'apiToken'> {
  apiTokenConfigured: boolean;
}

export interface FreshServiceDependencies {
  engine: Pick<typeof freshEngine, 'run' | 'cancel'> &
    Partial<Pick<typeof freshEngine, 'reevaluate' | 'resolveManually'>>;
  database: DataSource;
  createAutobrr: (
    baseUrl: string,
    apiToken: string
  ) => Pick<Autobrr, 'filters'>;
  now: () => Date;
}

const positiveInteger = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

const uniqueIntegers = (value: number[]): number[] =>
  [...new Set(value)].sort((left, right) => left - right);

const uniqueStrings = (value: string[]): string[] =>
  [...new Set(value.map((item) => item.trim()).filter(Boolean))].sort();

const normalizeBaseUrl = (value: string): string => {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    url.pathname =
      url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('Invalid Fresh connection configuration');
  }
};

const validateConnection = (baseUrl: string, apiToken: string) => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (
    !normalizedBaseUrl ||
    !apiToken.trim() ||
    apiToken.length > 1024 ||
    /[\r\n]/.test(apiToken)
  )
    throw new Error('Fresh connection configuration is incomplete');
  return { baseUrl: normalizedBaseUrl, apiToken: apiToken.trim() };
};

export const normalizeFreshSettings = (value: FreshSettings): FreshSettings => {
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.baseUrl !== 'string' ||
    typeof value.apiToken !== 'string' ||
    value.apiToken.length > 1024 ||
    /[\r\n]/.test(value.apiToken) ||
    !positiveInteger(
      value.filterId,
      value.enabled ? 1 : 0,
      Number.MAX_SAFE_INTEGER
    ) ||
    typeof value.cachedFilterName !== 'string' ||
    value.cachedFilterName.length > 200 ||
    /[\r\n]/.test(value.cachedFilterName) ||
    !positiveInteger(
      value.mediaEligibilityDays,
      MIN_MEDIA_ELIGIBILITY_DAYS,
      MAX_MEDIA_ELIGIBILITY_DAYS
    ) ||
    !positiveInteger(
      value.freshVisibilityDays,
      MIN_FRESH_VISIBILITY_DAYS,
      MAX_FRESH_VISIBILITY_DAYS
    ) ||
    !Array.isArray(value.includeGenreIds) ||
    !Array.isArray(value.excludeGenreIds) ||
    ![...value.includeGenreIds, ...value.excludeGenreIds].every(
      (id) => Number.isSafeInteger(id) && id > 0
    ) ||
    !Array.isArray(value.includeOriginalLanguages) ||
    !Array.isArray(value.excludeOriginalLanguages) ||
    ![
      ...value.includeOriginalLanguages,
      ...value.excludeOriginalLanguages,
    ].every((code) => /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(code)) ||
    !Array.isArray(value.includeContentRatings) ||
    !Array.isArray(value.excludeContentRatings) ||
    ![...value.includeContentRatings, ...value.excludeContentRatings].every(
      (rating) => /^(movie|tv):[^\r\n:]{1,32}$/.test(rating)
    ) ||
    !Number.isFinite(value.minimumTmdbScore) ||
    value.minimumTmdbScore < 0 ||
    value.minimumTmdbScore > 10 ||
    !Number.isSafeInteger(value.minimumTmdbVotes) ||
    value.minimumTmdbVotes < 0 ||
    value.minimumTmdbVotes > 10_000_000
  )
    throw new Error('Invalid Fresh settings');
  const normalized: FreshSettings = {
    enabled: value.enabled,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    apiToken: value.apiToken.trim(),
    filterId: value.filterId,
    cachedFilterName: value.cachedFilterName.trim(),
    mediaEligibilityDays: value.mediaEligibilityDays,
    freshVisibilityDays: value.freshVisibilityDays,
    includeGenreIds: uniqueIntegers(value.includeGenreIds),
    excludeGenreIds: uniqueIntegers(value.excludeGenreIds),
    includeOriginalLanguages: uniqueStrings(value.includeOriginalLanguages),
    excludeOriginalLanguages: uniqueStrings(value.excludeOriginalLanguages),
    includeContentRatings: uniqueStrings(value.includeContentRatings),
    excludeContentRatings: uniqueStrings(value.excludeContentRatings),
    minimumTmdbScore: value.minimumTmdbScore,
    minimumTmdbVotes: value.minimumTmdbVotes,
  };
  if (normalized.enabled)
    validateConnection(normalized.baseUrl, normalized.apiToken);
  return normalized;
};

export const publicFreshSettings = (
  settings: FreshSettings
): PublicFreshSettings => ({
  enabled: settings.enabled,
  baseUrl: settings.baseUrl,
  filterId: settings.filterId,
  cachedFilterName: settings.cachedFilterName,
  mediaEligibilityDays: settings.mediaEligibilityDays,
  freshVisibilityDays: settings.freshVisibilityDays,
  includeGenreIds: [...settings.includeGenreIds],
  excludeGenreIds: [...settings.excludeGenreIds],
  includeOriginalLanguages: [...settings.includeOriginalLanguages],
  excludeOriginalLanguages: [...settings.excludeOriginalLanguages],
  includeContentRatings: [...settings.includeContentRatings],
  excludeContentRatings: [...settings.excludeContentRatings],
  minimumTmdbScore: settings.minimumTmdbScore,
  minimumTmdbVotes: settings.minimumTmdbVotes,
  apiTokenConfigured: settings.apiToken.trim().length > 0,
});

export class FreshService {
  private settings?: FreshSettings;
  private inFlight?: Promise<void>;
  private activeOperation?:
    | 'sync'
    | 'reconciliation'
    | 'reevaluation'
    | 'rebuild';
  private latestAttempt?: FreshDiagnosticsSnapshot;

  constructor(
    private readonly dependencies: FreshServiceDependencies = {
      engine: freshEngine,
      database: dataSource,
      createAutobrr: (baseUrl, apiToken) => new Autobrr(baseUrl, apiToken),
      now: () => new Date(),
    }
  ) {}

  configure(settings: FreshSettings): void {
    this.settings = normalizeFreshSettings(settings);
  }

  private configured(): FreshSettings {
    if (!this.settings) throw new Error('Fresh is not configured');
    return this.settings;
  }

  async sync(reconcile = false): Promise<void> {
    const settings = this.configured();
    if (!settings.enabled) return;
    if (this.inFlight) return this.inFlight;
    this.activeOperation = reconcile ? 'reconciliation' : 'sync';
    this.inFlight = this.dependencies.engine
      .run(settings, reconcile)
      .then(({ diagnostics }) => {
        this.latestAttempt = diagnostics;
      })
      .finally(() => {
        this.inFlight = undefined;
        this.activeOperation = undefined;
      });
    return this.inFlight;
  }

  async refresh(): Promise<void> {
    return this.sync(false);
  }

  async reconcile(): Promise<void> {
    return this.sync(true);
  }

  async reevaluate(): Promise<void> {
    const settings = this.configured();
    if (this.inFlight) await this.inFlight;
    if (this.inFlight) return this.inFlight;
    if (!this.dependencies.engine.reevaluate) {
      throw new Error('Fresh reevaluation is unavailable');
    }
    this.activeOperation = 'reevaluation';
    this.inFlight = this.dependencies.engine
      .reevaluate(settings)
      .then(() => undefined)
      .finally(() => {
        this.inFlight = undefined;
        this.activeOperation = undefined;
      });
    return this.inFlight;
  }

  async rebuild(): Promise<void> {
    const settings = this.configured();
    if (!settings.enabled) throw new Error('fresh_disabled');
    if (this.inFlight && this.activeOperation === 'rebuild') {
      return this.inFlight;
    }
    if (this.inFlight) await this.inFlight;
    if (this.inFlight) return this.inFlight;

    this.activeOperation = 'rebuild';
    this.inFlight = (async () => {
      await this.dependencies.database.transaction(async (manager) => {
        for (const entity of [
          FreshObservation,
          FreshCandidate,
          FreshMedia,
          FreshSyncState,
        ]) {
          await manager
            .getRepository(entity)
            .createQueryBuilder()
            .delete()
            .execute();
        }
      });
      this.latestAttempt = undefined;
      const { diagnostics } = await this.dependencies.engine.run(
        settings,
        false
      );
      this.latestAttempt = diagnostics;
      if (diagnostics.outcome !== 'succeeded') {
        throw new Error('fresh_rebuild_failed');
      }
    })().finally(() => {
      this.inFlight = undefined;
      this.activeOperation = undefined;
    });
    return this.inFlight;
  }

  async resolveCandidate(candidateId: number, tmdbId: number) {
    const settings = this.configured();
    if (this.inFlight) await this.inFlight;
    if (!this.dependencies.engine.resolveManually) {
      throw new Error('Fresh manual resolution is unavailable');
    }
    return this.dependencies.engine.resolveManually(
      candidateId,
      tmdbId,
      settings
    );
  }

  cancel(): void {
    this.dependencies.engine.cancel();
  }

  running(): boolean {
    return !!this.inFlight;
  }

  startCatchUp(): void {
    if (!this.settings?.enabled) return;
    setImmediate(() => void this.sync());
  }

  async status() {
    const settings = this.configured();
    if (!settings.enabled) {
      return { status: 'disabled' as const, refreshing: false, itemCount: 0 };
    }
    const [state, itemCount] = await Promise.all([
      this.dependencies.database
        .getRepository(FreshSyncState)
        .findOneBy({ id: FRESH_SYNC_STATE_ID }),
      this.dependencies.database
        .getRepository(FreshMedia)
        .countBy({ active: true }),
    ]);
    const failed = ['failed', 'cancelled'].includes(
      this.latestAttempt?.outcome ?? ''
    );
    const continuityStale =
      state?.continuityStatus ===
        FreshContinuityStatus.RECONCILIATION_REQUIRED ||
      state?.continuityStatus === FreshContinuityStatus.GAP_PRESERVED;
    return {
      status:
        this.activeOperation === 'rebuild'
          ? ('rebuilding' as const)
          : this.inFlight
            ? ('refreshing' as const)
            : !state?.lastSuccessfulSyncAt
              ? failed
                ? ('unavailable' as const)
                : ('preparing' as const)
              : failed || continuityStale
                ? ('stale' as const)
                : ('ready' as const),
      refreshing: !!this.inFlight,
      lastRefresh: state?.lastSuccessfulSyncAt?.toISOString(),
      lastReconciliation: state?.lastSuccessfulReconciliationAt?.toISOString(),
      checkpoint: state?.checkpointReleaseId ?? undefined,
      itemCount,
      continuityStatus: state?.continuityStatus,
      error: failed ? 'Fresh synchronization failed.' : undefined,
    };
  }

  async diagnostics() {
    return {
      latestAttempt: this.latestAttempt
        ? {
            ...this.latestAttempt,
            stages: { ...this.latestAttempt.stages },
            counts: { ...this.latestAttempt.counts },
            decisions: this.latestAttempt.decisions.map((decision) => ({
              ...decision,
            })),
            checkpoint: { ...this.latestAttempt.checkpoint },
            ...(this.latestAttempt.lastGood
              ? { lastGood: { ...this.latestAttempt.lastGood } }
              : {}),
          }
        : null,
      currentProjection: await this.status(),
    };
  }

  async candidateDiagnostics(
    input: FreshCandidateDiagnosticQuery
  ): Promise<FreshCandidateDiagnosticResponse> {
    const state = await this.dependencies.database
      .getRepository(FreshSyncState)
      .findOneBy({ id: FRESH_SYNC_STATE_ID });
    if (!state) {
      return {
        pageInfo: {
          pages: 0,
          page: input.page,
          results: 0,
          pageSize: FRESH_CANDIDATE_PAGE_SIZE,
        },
        results: [],
        summary: {
          totalCandidates: 0,
          activeFresh: 0,
          noMatch: 0,
          ambiguous: 0,
          temporaryFailure: 0,
          outsideEligibilityWindow: 0,
          eligibilityUnknown: 0,
          excludedContentFilter: 0,
          visibilityExpired: 0,
          needsAttention: 0,
        },
      };
    }
    const repository = this.dependencies.database.getRepository(FreshCandidate);
    const base = () =>
      repository
        .createQueryBuilder('candidate')
        .leftJoinAndSelect('candidate.freshMedia', 'media')
        .where('candidate.sourceGeneration = :generation', {
          generation: state.generation,
        });
    const query = base();
    if (input.search?.trim()) {
      query.andWhere('LOWER(candidate.displayTitle) LIKE :search', {
        search: `%${input.search.trim().toLowerCase()}%`,
      });
    }
    if (input.mediaType !== 'all') {
      query.andWhere('candidate.mediaType = :mediaType', {
        mediaType: input.mediaType,
      });
    }
    applyDiagnosticStatus(query, input.status);
    if (input.sort === 'title.asc')
      query.orderBy('candidate.displayTitle', 'ASC');
    else if (input.sort === 'title.desc')
      query.orderBy('candidate.displayTitle', 'DESC');
    else if (input.sort === 'status')
      query
        .orderBy('candidate.status', 'ASC')
        .addOrderBy('media.membershipReason', 'ASC');
    else if (input.sort === 'year.desc')
      query.orderBy('candidate.matchYear', 'DESC');
    else if (input.sort === 'year.asc')
      query.orderBy('candidate.matchYear', 'ASC');
    else if (input.sort === 'first_seen.desc')
      query.orderBy('candidate.firstObservedAt', 'DESC');
    else if (input.sort === 'first_seen.asc')
      query.orderBy('candidate.firstObservedAt', 'ASC');
    else if (input.sort === 'last_seen.asc')
      query.orderBy('candidate.lastObservedAt', 'ASC');
    else query.orderBy('candidate.lastObservedAt', 'DESC');
    query.addOrderBy('candidate.id', 'ASC');
    const [candidates, total] = await query
      .skip((input.page - 1) * FRESH_CANDIDATE_PAGE_SIZE)
      .take(FRESH_CANDIDATE_PAGE_SIZE)
      .getManyAndCount();
    const candidateIds = candidates.map((candidate) => candidate.id);
    const observations = candidateIds.length
      ? await this.dependencies.database
          .getRepository(FreshObservation)
          .findBy({
            candidateId: In(candidateIds),
          })
      : [];
    const observationsByCandidate = new Map<number, FreshObservation[]>();
    observations.forEach((observation) => {
      const values = observationsByCandidate.get(observation.candidateId) ?? [];
      values.push(observation);
      observationsByCandidate.set(observation.candidateId, values);
    });
    const settings = this.configured();

    const count = async (status: FreshCandidateDiagnosticStatus) => {
      const countQuery = base();
      applyDiagnosticStatus(countQuery, status);
      return countQuery.getCount();
    };
    const [
      totalCandidates,
      activeFresh,
      noMatch,
      ambiguous,
      temporaryFailure,
      outsideEligibilityWindow,
      eligibilityUnknown,
      excludedContentFilter,
      visibilityExpired,
    ] = await Promise.all([
      count('all'),
      count('active_fresh'),
      count('no_match'),
      count('ambiguous'),
      count('temporary_failure'),
      count('outside_eligibility_window'),
      count('eligibility_unknown'),
      count('excluded_content_filter'),
      count('visibility_expired'),
    ]);
    return {
      pageInfo: {
        pages: Math.ceil(total / FRESH_CANDIDATE_PAGE_SIZE),
        page: input.page,
        results: total,
        pageSize: FRESH_CANDIDATE_PAGE_SIZE,
      },
      results: candidates.map((candidate) => {
        const media = candidate.freshMedia;
        const evidence = media
          ? evaluateAdmissionEvidence(
              media,
              observationsByCandidate.get(candidate.id) ?? [],
              settings.mediaEligibilityDays
            )
          : undefined;
        const selected = evidence?.selected;
        return {
          candidateId: candidate.id,
          displayTitle: candidate.displayTitle,
          mediaType: candidate.mediaType,
          matchYear: candidate.matchYear || undefined,
          resolutionStatus: candidate.status,
          displayStatus: diagnosticStatus(candidate),
          tmdbId: candidate.tmdbId ?? undefined,
          firstObservedAt: candidate.firstObservedAt.toISOString(),
          lastObservedAt: candidate.lastObservedAt.toISOString(),
          attemptCount: candidate.attemptCount,
          lastAttemptAt: candidate.lastAttemptAt?.toISOString(),
          nextAttemptAt: candidate.nextAttemptAt?.toISOString(),
          resolvedAt: candidate.resolvedAt?.toISOString(),
          failureReason: candidate.lastFailureReason ?? undefined,
          membershipReason: media?.membershipReason ?? undefined,
          firstSeenAt: media?.firstSeenAt?.toISOString(),
          lastSeenAt: media?.lastSeenAt?.toISOString(),
          mediaDate: media?.mediaDate ?? undefined,
          ...(selected
            ? {
                eligibility: {
                  observationType: selected.observation.availabilityType,
                  observationAt: selected.observation.observedAt.toISOString(),
                  eligibilityDate: selected.eligibilityDate,
                  eligibilityDateSource: selected.eligibilityDateSource,
                  firstQualifyingObservation: selected.qualifies
                    ? selected.observation.observedAt.toISOString()
                    : undefined,
                  ageDays: selected.ageDays,
                  eligibilityLimitDays: settings.mediaEligibilityDays,
                  legacyEvidence: evidence?.legacyUnknown ?? false,
                },
              }
            : {}),
          visibleUntil:
            media?.admitted && media.firstSeenAt
              ? new Date(
                  media.firstSeenAt.getTime() +
                    settings.freshVisibilityDays * 86_400_000
                ).toISOString()
              : undefined,
          active: media?.active ?? false,
          actionable: [
            FreshCandidateStatus.NO_MATCH,
            FreshCandidateStatus.AMBIGUOUS,
          ].includes(candidate.status),
        };
      }),
      summary: {
        totalCandidates,
        activeFresh,
        noMatch,
        ambiguous,
        temporaryFailure,
        outsideEligibilityWindow,
        eligibilityUnknown,
        excludedContentFilter,
        visibilityExpired,
        needsAttention: noMatch + ambiguous,
      },
    };
  }

  async filters(settings = this.configured()): Promise<AutobrrFilterOption[]> {
    const connection = validateConnection(settings.baseUrl, settings.apiToken);
    return this.dependencies
      .createAutobrr(connection.baseUrl, connection.apiToken)
      .filters();
  }

  async test(settings = this.configured()): Promise<void> {
    await this.filters(settings);
  }
}

const freshService = new FreshService();
export default freshService;
