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
import FreshAdmissionOverride from '@server/entity/FreshAdmissionOverride';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshCandidateVisibility from '@server/entity/FreshCandidateVisibility';
import FreshDiscoveryHistory from '@server/entity/FreshDiscoveryHistory';
import FreshManualResolution from '@server/entity/FreshManualResolution';
import FreshMedia from '@server/entity/FreshMedia';
import FreshObservation from '@server/entity/FreshObservation';
import { FreshSyncState } from '@server/entity/FreshSyncState';
import { freshEngine } from '@server/lib/fresh/engine';
import { evaluateAdmissionEvidence } from '@server/lib/fresh/membership';
import {
  FRESH_SOURCE_EVIDENCE_VERSION,
  normalizeFreshTitle,
} from '@server/lib/fresh/normalize';
import type {
  FreshCandidateDiagnosticQuery,
  FreshCandidateDiagnosticResponse,
  FreshCandidateDiagnosticStatus,
  FreshCandidateVisibilitySelection,
  FreshDiagnosticsSnapshot,
} from '@server/lib/fresh/types';
import type { FreshSettings } from '@server/lib/settings';
import { In, type DataSource, type SelectQueryBuilder } from 'typeorm';

const contentFilterReasons = [
  'excluded_genre',
  'missing_required_genre',
  'excluded_original_language',
  'missing_required_original_language',
  'excluded_content_rating',
  'missing_required_content_rating',
  'below_tmdb_score',
  'below_tmdb_vote_count',
];

const technicalIdentityReasons = [
  'source_evidence_collision',
  'parsed_type_suspect',
  'special_identity_ambiguous',
];

const candidateDiagnosticTitles = (
  candidate: FreshCandidate,
  media?: FreshMedia | null,
  manual?: FreshManualResolution
): { displayTitle: string; parsedTitle: string } => {
  const manualTitle = manual?.canonicalTitle.trim();
  if (manualTitle)
    return {
      displayTitle: manualTitle,
      parsedTitle: candidate.displayTitle,
    };

  const canonicalTitle = media?.displayTitle.trim();
  if (!canonicalTitle)
    return {
      displayTitle: candidate.displayTitle,
      parsedTitle: candidate.displayTitle,
    };

  const candidateTitle = candidate.displayTitle.trim();
  const canonicalHasDisplayCase =
    canonicalTitle !== canonicalTitle.toLocaleLowerCase();
  const candidatePreservesDisplayCase =
    candidateTitle !== candidateTitle.toLocaleLowerCase();
  if (
    !canonicalHasDisplayCase &&
    candidatePreservesDisplayCase &&
    normalizeFreshTitle(canonicalTitle) === candidate.normalizedTitle &&
    normalizeFreshTitle(candidateTitle) === candidate.normalizedTitle
  ) {
    return {
      displayTitle: candidateTitle,
      parsedTitle: candidate.normalizedTitle,
    };
  }

  return {
    displayTitle: canonicalTitle,
    parsedTitle: candidate.displayTitle,
  };
};

const diagnosticStatus = (
  candidate: FreshCandidate,
  history?: FreshDiscoveryHistory,
  now = new Date()
): FreshCandidateDiagnosticStatus => {
  if (candidate.status === FreshCandidateStatus.NO_MATCH) return 'no_match';
  if (candidate.status === FreshCandidateStatus.AMBIGUOUS) return 'ambiguous';
  if (candidate.status === FreshCandidateStatus.TRANSIENT_FAILURE)
    return 'temporary_failure';
  if (candidate.status === FreshCandidateStatus.UNRESOLVED) return 'pending';
  if (candidate.status === FreshCandidateStatus.RESOLVING) return 'resolving';
  if (
    candidate.lastFailureReason &&
    technicalIdentityReasons.includes(candidate.lastFailureReason)
  )
    return 'needs_attention';
  const media = candidate.freshMedia;
  if (
    (candidate.effectiveMediaType ?? candidate.mediaType) === 'tv' &&
    !history
  )
    return candidate.tmdbId ? 'reviewable' : 'needs_attention';
  if (media?.active) return 'active_fresh';
  if (
    history?.firstFreshAt &&
    history.visibleUntil &&
    history.visibleUntil.getTime() < now.getTime()
  )
    return 'historical';
  if (
    media?.membershipReason === 'visibility_expired' ||
    media?.membershipReason === 'source_generation_inactive'
  )
    return 'historical';
  if (
    candidate.status === FreshCandidateStatus.RESOLVED &&
    candidate.tmdbId &&
    media &&
    !media.active
  )
    return 'reviewable';
  if (history && !history.admitted) return 'reviewable';
  if (media?.membershipReason === 'eligibility_unknown')
    return 'eligibility_unknown';
  if (
    candidate.status === FreshCandidateStatus.OUTSIDE_WINDOW ||
    (media && !media.admitted)
  )
    return 'outside_eligibility_window';
  if (
    media?.membershipReason &&
    contentFilterReasons.includes(media.membershipReason)
  )
    return 'excluded_content_filter';
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
          AND (media.membershipReason IS NULL OR media.membershipReason NOT IN (:...nonWindowReasons))))`,
      {
        outsideStatus: FreshCandidateStatus.OUTSIDE_WINDOW,
        resolvedStatus: FreshCandidateStatus.RESOLVED,
        notAdmitted: false,
        nonWindowReasons: [
          'eligibility_unknown',
          'season_unknown',
          ...contentFilterReasons,
        ],
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
    query.andWhere(
      `(candidate.status IN (:...attentionStatuses) OR
        candidate.lastFailureReason IN (:...technicalIdentityReasons) OR
        (candidate.status = :attentionResolved
          AND COALESCE(candidate."effectiveMediaType", candidate."mediaType") = 'tv'
          AND history.id IS NULL
          AND candidate."tmdbId" IS NULL))`,
      {
        attentionStatuses: [
          FreshCandidateStatus.NO_MATCH,
          FreshCandidateStatus.AMBIGUOUS,
        ],
        technicalIdentityReasons,
        attentionResolved: FreshCandidateStatus.RESOLVED,
      }
    );
  else if (status === 'reviewable')
    query
      .andWhere('candidate.status = :resolvedStatus', {
        resolvedStatus: FreshCandidateStatus.RESOLVED,
      })
      .andWhere('media.active = :reviewableActive', { reviewableActive: false })
      .andWhere(
        '(history."visibleUntil" IS NULL OR history."visibleUntil" >= :diagnosticNow)'
      )
      .andWhere(
        '(media.membershipReason IS NULL OR media.membershipReason NOT IN (:...historicalReasons))',
        {
          historicalReasons: [
            'visibility_expired',
            'source_generation_inactive',
          ],
        }
      )
      .andWhere(
        '(history.id IS NOT NULL OR media.membershipReason IN (:...reviewableReasons))',
        {
          reviewableReasons: [
            'outside_eligibility_window',
            'eligibility_unknown',
            'season_unknown',
            ...contentFilterReasons,
          ],
        }
      );
  else if (status === 'historical')
    query.andWhere(
      `(candidate.status IN (:...informationalStatuses) OR
        (candidate.status = :resolvedStatus AND
          (history."visibleUntil" < :diagnosticNow OR
            media.membershipReason IN (:...historicalReasons))))`,
      {
        informationalStatuses: [
          FreshCandidateStatus.TRANSIENT_FAILURE,
          FreshCandidateStatus.UNRESOLVED,
          FreshCandidateStatus.RESOLVING,
        ],
        resolvedStatus: FreshCandidateStatus.RESOLVED,
        historicalReasons: ['visibility_expired', 'source_generation_inactive'],
      }
    );
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

const applyDiagnosticFacets = (
  query: SelectQueryBuilder<FreshCandidate>,
  input: FreshCandidateDiagnosticQuery
) => {
  if (input.reasonFamily === 'resolution') {
    query.andWhere(
      '(candidate.status != :facetResolved OR candidate.lastFailureReason IN (:...facetTechnicalReasons))',
      {
        facetResolved: FreshCandidateStatus.RESOLVED,
        facetTechnicalReasons: technicalIdentityReasons,
      }
    );
  } else if (input.reasonFamily === 'admission') {
    query
      .andWhere('candidate.status = :facetResolved', {
        facetResolved: FreshCandidateStatus.RESOLVED,
      })
      .andWhere('history.id IS NOT NULL')
      .andWhere('history.admitted = :facetNotAdmitted', {
        facetNotAdmitted: false,
      });
  } else if (input.reasonFamily === 'content') {
    query.andWhere('media.membershipReason IN (:...facetContentReasons)', {
      facetContentReasons: contentFilterReasons,
    });
  } else if (input.reasonFamily === 'history') {
    query.andWhere('history.id IS NOT NULL');
  } else if (input.reasonFamily === 'source') {
    query.andWhere('media.membershipReason = :facetSourceReason', {
      facetSourceReason: 'source_generation_inactive',
    });
  }

  const knownSeason = `(candidate."seasonKey" > 0 OR
    (candidate."explicitSpecial" = :facetTrue
      AND candidate."seasonKey" = 0
      AND candidate."specialEpisodeKey" > 0))`;
  if (input.seasonEvidence === 'known') {
    query
      .andWhere(
        `COALESCE(candidate."effectiveMediaType", candidate."mediaType") = 'tv'`
      )
      .andWhere(knownSeason, { facetTrue: true });
  } else if (input.seasonEvidence === 'unknown') {
    query
      .andWhere(
        `COALESCE(candidate."effectiveMediaType", candidate."mediaType") = 'tv'`
      )
      .andWhere(`NOT ${knownSeason}`, { facetTrue: true });
  }

  if (input.manualResolution !== 'all') {
    query.andWhere(
      input.manualResolution === 'present'
        ? 'manual.id IS NOT NULL'
        : 'manual.id IS NULL'
    );
  }
  if (input.admissionOverride !== 'all') {
    query.andWhere(
      input.admissionOverride === 'present'
        ? 'admissionOverride.id IS NOT NULL'
        : 'admissionOverride.id IS NULL'
    );
  }
};

const applyDiagnosticVisibility = (
  query: SelectQueryBuilder<FreshCandidate>,
  visibility: FreshCandidateDiagnosticQuery['visibility']
) => {
  if (visibility === 'visible')
    query.andWhere('COALESCE(candidateVisibility.show, :defaultShow) = :show', {
      defaultShow: true,
      show: true,
    });
  else if (visibility === 'hidden')
    query.andWhere('candidateVisibility.show = :show', { show: false });
};

export interface PublicFreshSettings extends Omit<FreshSettings, 'apiToken'> {
  apiTokenConfigured: boolean;
}

export interface FreshServiceDependencies {
  engine: Pick<typeof freshEngine, 'run' | 'cancel'> &
    Partial<
      Pick<
        typeof freshEngine,
        | 'reevaluate'
        | 'resolveManually'
        | 'resetManualResolution'
        | 'setAdmissionOverride'
        | 'removeAdmissionOverride'
      >
    >;
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
    | 'rebuild'
    | 'manual_resolution'
    | 'resolution_reset'
    | 'admission_override'
    | 'override_removal'
    | 'candidate_visibility';
  private latestAttempt?: FreshDiagnosticsSnapshot;
  private coordinator: Promise<unknown> = Promise.resolve();
  private coordinatorBusy = false;

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

  private coordinate<T>(
    operation: NonNullable<FreshService['activeOperation']>,
    action: () => Promise<T>,
    joinSameOperation = false
  ): Promise<T> {
    if (
      joinSameOperation &&
      this.inFlight &&
      this.activeOperation === operation
    )
      return this.inFlight as unknown as Promise<T>;
    const execute = async () => {
      this.activeOperation = operation;
      const actionPromise = action();
      this.inFlight = actionPromise.then(() => undefined);
      void this.inFlight.catch(() => undefined);
      try {
        return await actionPromise;
      } finally {
        this.inFlight = undefined;
        this.activeOperation = undefined;
      }
    };
    const result = this.coordinatorBusy
      ? this.coordinator.catch(() => undefined).then(execute)
      : execute();
    this.coordinatorBusy = true;
    const tail = result.catch(() => undefined);
    this.coordinator = tail;
    void tail
      .finally(() => {
        if (this.coordinator === tail) this.coordinatorBusy = false;
      })
      .catch(() => undefined);
    return result;
  }

  async sync(reconcile = false): Promise<void> {
    const settings = this.configured();
    if (!settings.enabled) return;
    if (this.inFlight && this.activeOperation === 'rebuild')
      return this.inFlight;
    return this.coordinate(
      reconcile ? 'reconciliation' : 'sync',
      () =>
        this.dependencies.engine
          .run(settings, reconcile)
          .then(({ diagnostics }) => {
            this.latestAttempt = diagnostics;
          }),
      true
    );
  }

  async refresh(): Promise<void> {
    return this.sync(false);
  }

  async reconcile(): Promise<void> {
    return this.sync(true);
  }

  async reevaluate(): Promise<void> {
    const settings = this.configured();
    if (!this.dependencies.engine.reevaluate) {
      throw new Error('Fresh reevaluation is unavailable');
    }
    return this.coordinate('reevaluation', () =>
      this.dependencies.engine.reevaluate!(settings).then(() => undefined)
    );
  }

  async rebuild(): Promise<void> {
    const settings = this.configured();
    if (!settings.enabled) throw new Error('fresh_disabled');
    return this.coordinate(
      'rebuild',
      async () => {
        await this.dependencies.database.transaction(async (manager) => {
          for (const entity of [
            FreshObservation,
            FreshCandidate,
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
      },
      true
    );
  }

  async resolveCandidate(
    candidateId: number,
    mediaType: 'movie' | 'tv',
    tmdbId: number,
    expectedRevision: number,
    actorUserId?: number
  ) {
    const settings = this.configured();
    if (!this.dependencies.engine.resolveManually) {
      throw new Error('Fresh manual resolution is unavailable');
    }
    return this.coordinate('manual_resolution', () =>
      this.dependencies.engine.resolveManually!(
        candidateId,
        mediaType,
        tmdbId,
        expectedRevision,
        actorUserId,
        settings
      )
    );
  }

  async resetCandidateResolution(
    candidateId: number,
    expectedRevision: number
  ) {
    if (!this.dependencies.engine.resetManualResolution)
      throw new Error('Fresh manual resolution reset is unavailable');
    return this.coordinate('resolution_reset', () =>
      this.dependencies.engine.resetManualResolution!(
        candidateId,
        expectedRevision,
        this.configured()
      )
    );
  }

  async admitCandidate(
    candidateId: number,
    expectedRevision: number,
    actorUserId?: number
  ) {
    if (!this.dependencies.engine.setAdmissionOverride)
      throw new Error('Fresh admission override is unavailable');
    return this.coordinate('admission_override', () =>
      this.dependencies.engine.setAdmissionOverride!(
        candidateId,
        expectedRevision,
        this.configured(),
        actorUserId
      )
    );
  }

  async removeCandidateOverride(candidateId: number, expectedRevision: number) {
    if (!this.dependencies.engine.removeAdmissionOverride)
      throw new Error('Fresh admission override removal is unavailable');
    return this.coordinate('override_removal', () =>
      this.dependencies.engine.removeAdmissionOverride!(
        candidateId,
        expectedRevision,
        this.configured()
      )
    );
  }

  async setCandidateVisibility(
    candidateId: number,
    show: boolean,
    expectedRevision: number
  ): Promise<FreshCandidate> {
    const [candidate] = await this.setCandidateVisibilityBulk(
      [{ candidateId, expectedRevision }],
      show
    );
    return candidate;
  }

  async setCandidateVisibilityBulk(
    selections: FreshCandidateVisibilitySelection[],
    show: boolean
  ): Promise<FreshCandidate[]> {
    if (
      selections.length === 0 ||
      selections.length > FRESH_CANDIDATE_PAGE_SIZE ||
      new Set(selections.map(({ candidateId }) => candidateId)).size !==
        selections.length
    )
      throw new Error('invalid_candidate_selection');
    return this.coordinate('candidate_visibility', () =>
      this.dependencies.database.transaction(async (manager) => {
        const state = await manager
          .getRepository(FreshSyncState)
          .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
        const candidates = manager.getRepository(FreshCandidate);
        const byId = new Map(
          (
            await candidates.findBy({
              id: In(selections.map(({ candidateId }) => candidateId)),
            })
          ).map((candidate) => [candidate.id, candidate])
        );
        const ordered = selections.map(({ candidateId, expectedRevision }) => {
          const candidate = byId.get(candidateId);
          if (!candidate) throw new Error('candidate_not_found');
          if (
            candidate.revision !== expectedRevision ||
            candidate.sourceGeneration !== state.generation
          )
            throw new Error('stale_candidate');
          if (!candidate.sourceEvidenceKey)
            throw new Error('source_evidence_collision');
          return candidate;
        });

        const collisionCounts = await Promise.all(
          ordered.map((candidate) =>
            candidates.countBy({
              sourceGeneration: state.generation,
              mediaType: candidate.mediaType,
              sourceEvidenceKey: candidate.sourceEvidenceKey,
            })
          )
        );
        if (collisionCounts.some((count) => count !== 1))
          throw new Error('source_evidence_collision');

        const visibilityRepository = manager.getRepository(
          FreshCandidateVisibility
        );
        const existing = await visibilityRepository.findBy(
          ordered.map((candidate) => ({
            sourceEvidenceVersion: FRESH_SOURCE_EVIDENCE_VERSION,
            mediaType: candidate.mediaType,
            sourceEvidenceKey: candidate.sourceEvidenceKey,
          }))
        );
        const visibilityByKey = new Map(
          existing.map((visibility) => [
            `${visibility.mediaType}:${visibility.sourceEvidenceKey}`,
            visibility,
          ])
        );
        const changedCandidates: FreshCandidate[] = [];
        const changedVisibilities: FreshCandidateVisibility[] = [];
        for (const candidate of ordered) {
          const key = `${candidate.mediaType}:${candidate.sourceEvidenceKey}`;
          const visibility = visibilityByKey.get(key);
          const currentShow = visibility?.show ?? true;
          if (currentShow === show) continue;
          changedVisibilities.push(
            new FreshCandidateVisibility({
              ...visibility,
              sourceEvidenceVersion: FRESH_SOURCE_EVIDENCE_VERSION,
              mediaType: candidate.mediaType,
              sourceEvidenceKey: candidate.sourceEvidenceKey,
              show,
            })
          );
          candidate.revision += 1;
          changedCandidates.push(candidate);
        }
        if (changedVisibilities.length > 0)
          await visibilityRepository.save(changedVisibilities);
        if (changedCandidates.length > 0)
          await candidates.save(changedCandidates);
        return ordered;
      })
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
          reviewable: 0,
          historical: 0,
        },
      };
    }
    const repository = this.dependencies.database.getRepository(FreshCandidate);
    const base = () =>
      repository
        .createQueryBuilder('candidate')
        .leftJoinAndSelect('candidate.freshMedia', 'media')
        .leftJoin(
          FreshDiscoveryHistory,
          'history',
          `history."mediaType" = COALESCE(candidate."effectiveMediaType", candidate."mediaType")
            AND history."tmdbId" = candidate."tmdbId"
            AND history."seasonKey" = CASE
              WHEN COALESCE(candidate."effectiveMediaType", candidate."mediaType") = 'movie' THEN -1
              ELSE candidate."seasonKey" END
            AND history."specialEpisodeKey" = CASE
              WHEN COALESCE(candidate."effectiveMediaType", candidate."mediaType") = 'movie' THEN -1
              ELSE candidate."specialEpisodeKey" END`
        )
        .leftJoin(
          FreshManualResolution,
          'manual',
          `manual."sourceEvidenceVersion" = 1
            AND manual."sourceEvidenceKey" = candidate."sourceEvidenceKey"
            AND manual.active = true`
        )
        .leftJoin(
          FreshAdmissionOverride,
          'admissionOverride',
          `admissionOverride."mediaType" = COALESCE(candidate."effectiveMediaType", candidate."mediaType")
            AND admissionOverride."tmdbId" = candidate."tmdbId"
            AND admissionOverride."seasonKey" = CASE
              WHEN COALESCE(candidate."effectiveMediaType", candidate."mediaType") = 'movie' THEN -1
              ELSE candidate."seasonKey" END
            AND admissionOverride."specialEpisodeKey" = CASE
              WHEN COALESCE(candidate."effectiveMediaType", candidate."mediaType") = 'movie' THEN -1
              ELSE candidate."specialEpisodeKey" END
            AND admissionOverride.active = true`
        )
        .leftJoin(
          FreshCandidateVisibility,
          'candidateVisibility',
          `candidateVisibility."sourceEvidenceVersion" = ${FRESH_SOURCE_EVIDENCE_VERSION}
            AND candidateVisibility."mediaType" = candidate."mediaType"
            AND candidateVisibility."sourceEvidenceKey" = candidate."sourceEvidenceKey"`
        )
        .where('candidate.sourceGeneration = :generation', {
          generation: state.generation,
        })
        .setParameter('diagnosticNow', this.dependencies.now());
    const query = base();
    applyDiagnosticVisibility(query, input.visibility);
    if (input.search?.trim()) {
      const search = input.search.trim().toLowerCase();
      const numeric = /^\d+$/.test(search) ? Number(search) : undefined;
      const typed = search.match(/^(movie|tv)\s*[:/]\s*(\d+)$/);
      query.andWhere(
        `(LOWER(candidate.displayTitle) LIKE :search OR
          LOWER(media.displayTitle) LIKE :search OR
          EXISTS (SELECT 1 FROM fresh_observation observation
            WHERE observation."candidateId" = candidate.id
              AND LOWER(observation."sourceTitle") LIKE :search)
          ${numeric ? 'OR candidate.tmdbId = :numericTmdbId' : ''}
          ${typed ? `OR (COALESCE(candidate.effectiveMediaType, candidate.mediaType) = :typedMediaType AND candidate.tmdbId = :typedTmdbId)` : ''})`,
        {
          search: `%${search}%`,
          ...(numeric ? { numericTmdbId: numeric } : {}),
          ...(typed
            ? {
                typedMediaType: typed[1],
                typedTmdbId: Number(typed[2]),
              }
            : {}),
        }
      );
    }
    if (input.mediaType !== 'all') {
      query.andWhere(
        'COALESCE(candidate.effectiveMediaType, candidate.mediaType) = :mediaType',
        {
          mediaType: input.mediaType,
        }
      );
    }
    applyDiagnosticStatus(query, input.status);
    applyDiagnosticFacets(query, input);
    if (input.sort === 'priority')
      query
        .addSelect(
          `CASE
            WHEN candidate.status = ${FreshCandidateStatus.NO_MATCH} THEN 0
            WHEN candidate.status = ${FreshCandidateStatus.AMBIGUOUS} THEN 1
            WHEN candidate.status IN (${FreshCandidateStatus.TRANSIENT_FAILURE}, ${FreshCandidateStatus.UNRESOLVED}, ${FreshCandidateStatus.RESOLVING}) THEN 2
            WHEN candidate.lastFailureReason IN (:...technicalIdentityReasons) THEN 2
            WHEN candidate.status = ${FreshCandidateStatus.RESOLVED}
              AND COALESCE(candidate."effectiveMediaType", candidate."mediaType") = 'tv'
              AND history.id IS NULL THEN 2
            WHEN candidate.status = ${FreshCandidateStatus.RESOLVED} AND media.active = false
              AND (history."visibleUntil" IS NULL OR history."visibleUntil" >= :diagnosticNow)
              AND (media.membershipReason IS NULL OR media.membershipReason NOT IN ('visibility_expired', 'source_generation_inactive')) THEN 3
            WHEN media.active = true THEN 4
            ELSE 5
          END`,
          'diagnostic_priority'
        )
        .setParameter('technicalIdentityReasons', technicalIdentityReasons)
        .addSelect(
          'LOWER(COALESCE(media.displayTitle, candidate.displayTitle))',
          'diagnostic_title'
        )
        .addSelect(
          'COALESCE(candidate.effectiveMediaType, candidate.mediaType)',
          'diagnostic_media_type'
        )
        .orderBy('diagnostic_priority', 'ASC')
        .addOrderBy('diagnostic_title', 'ASC')
        .addOrderBy('diagnostic_media_type', 'ASC')
        .addOrderBy('candidate.tmdbId', 'ASC')
        .addOrderBy('candidate.id', 'ASC');
    else if (input.sort === 'title.asc')
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
    if (input.sort !== 'priority') query.addOrderBy('candidate.id', 'ASC');
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
    const sourceKeys = [
      ...new Set(
        candidates
          .map((candidate) => candidate.sourceEvidenceKey)
          .filter(Boolean)
      ),
    ];
    const manualResolutions = sourceKeys.length
      ? await this.dependencies.database
          .getRepository(FreshManualResolution)
          .findBy({ sourceEvidenceKey: In(sourceKeys), active: true })
      : [];
    const visibilities = sourceKeys.length
      ? await this.dependencies.database
          .getRepository(FreshCandidateVisibility)
          .findBy({
            sourceEvidenceVersion: FRESH_SOURCE_EVIDENCE_VERSION,
            sourceEvidenceKey: In(sourceKeys),
          })
      : [];
    const visibilityByKey = new Map(
      visibilities.map((visibility) => [
        `${visibility.mediaType}:${visibility.sourceEvidenceKey}`,
        visibility.show,
      ])
    );
    const manualByKey = new Map(
      manualResolutions.map((resolution) => [
        resolution.sourceEvidenceKey,
        resolution,
      ])
    );
    const mediaIdentities = candidates
      .filter((candidate) => candidate.tmdbId)
      .map((candidate) => ({
        mediaType: candidate.effectiveMediaType ?? candidate.mediaType,
        tmdbId: candidate.tmdbId as number,
      }));
    const histories = mediaIdentities.length
      ? await this.dependencies.database
          .getRepository(FreshDiscoveryHistory)
          .createQueryBuilder('history')
          .where(
            mediaIdentities
              .map(
                (_, index) =>
                  `(history.mediaType = :historyType${index} AND history.tmdbId = :historyId${index})`
              )
              .join(' OR '),
            Object.fromEntries(
              mediaIdentities.flatMap((identity, index) => [
                [`historyType${index}`, identity.mediaType],
                [`historyId${index}`, identity.tmdbId],
              ])
            )
          )
          .getMany()
      : [];
    const overrides = mediaIdentities.length
      ? await this.dependencies.database
          .getRepository(FreshAdmissionOverride)
          .findBy({ active: true })
      : [];
    const settings = this.configured();

    const count = async (status: FreshCandidateDiagnosticStatus) => {
      const countQuery = base();
      applyDiagnosticVisibility(countQuery, input.visibility);
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
      needsAttention,
      reviewable,
      historical,
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
      count('needs_attention'),
      count('reviewable'),
      count('historical'),
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
        const manual = manualByKey.get(candidate.sourceEvidenceKey);
        const effectiveMediaType =
          candidate.effectiveMediaType ?? candidate.mediaType;
        const identitySeasonKey =
          effectiveMediaType === 'movie' ? -1 : candidate.seasonKey;
        const identitySpecialEpisodeKey =
          effectiveMediaType === 'movie' ? -1 : candidate.specialEpisodeKey;
        const candidateHistories = histories.filter(
          (history) =>
            history.mediaType === effectiveMediaType &&
            history.tmdbId === candidate.tmdbId
        );
        const history = candidateHistories
          .filter(
            (value) =>
              value.seasonKey === identitySeasonKey &&
              value.specialEpisodeKey === identitySpecialEpisodeKey
          )
          .sort((left, right) => right.id - left.id)[0];
        const override = overrides.find(
          (value) =>
            value.mediaType === effectiveMediaType &&
            value.tmdbId === candidate.tmdbId &&
            value.seasonKey === identitySeasonKey &&
            value.specialEpisodeKey === identitySpecialEpisodeKey
        );
        const evidence =
          media?.mediaType === 'movie'
            ? evaluateAdmissionEvidence(
                media,
                observationsByCandidate.get(candidate.id) ?? [],
                settings.mediaEligibilityDays
              )
            : undefined;
        const selected = evidence?.selected;
        const automaticStatus = candidate.automaticStatus ?? candidate.status;
        const canResolve =
          !manual &&
          !!candidate.sourceEvidenceKey &&
          ([
            FreshCandidateStatus.NO_MATCH,
            FreshCandidateStatus.AMBIGUOUS,
          ].includes(automaticStatus) ||
            !!(
              candidate.lastFailureReason &&
              technicalIdentityReasons.includes(candidate.lastFailureReason)
            ) ||
            (effectiveMediaType === 'tv' && !history) ||
            media?.membershipReason === 'source_generation_inactive');
        const canAdmit =
          !override &&
          !!candidate.tmdbId &&
          !media?.active &&
          (!!manual ||
            ![
              FreshCandidateStatus.NO_MATCH,
              FreshCandidateStatus.AMBIGUOUS,
              FreshCandidateStatus.TRANSIENT_FAILURE,
              FreshCandidateStatus.UNRESOLVED,
              FreshCandidateStatus.RESOLVING,
            ].includes(automaticStatus));
        const diagnosticVisibility =
          visibilityByKey.get(
            `${candidate.mediaType}:${candidate.sourceEvidenceKey}`
          ) !== false;
        const actionable = canResolve || !!manual || canAdmit || !!override;
        const diagnosticTitles = candidateDiagnosticTitles(
          candidate,
          media,
          manual
        );
        const actions = {
          resolve: canResolve,
          resetResolution: !!manual,
          admit: canAdmit,
          removeOverride: !!override,
          dismiss: diagnosticVisibility,
          show: !diagnosticVisibility,
        };
        return {
          candidateId: candidate.id,
          revision: candidate.revision,
          displayTitle: diagnosticTitles.displayTitle,
          parsedTitle: diagnosticTitles.parsedTitle,
          parsedMediaType: candidate.mediaType,
          mediaType: effectiveMediaType,
          matchYear: candidate.matchYear || undefined,
          seasonNumber:
            candidate.seasonKey >= 0 ? candidate.seasonKey : undefined,
          episodeNumber:
            candidate.specialEpisodeKey > 0
              ? candidate.specialEpisodeKey
              : undefined,
          resolutionStatus: candidate.status,
          automaticResolution: {
            status: automaticStatus,
            mediaType: candidate.mediaType,
            tmdbId: candidate.automaticTmdbId ?? undefined,
            failureReason: candidate.automaticFailureReason ?? undefined,
          },
          displayStatus: diagnosticStatus(
            candidate,
            history,
            this.dependencies.now()
          ),
          tmdbId: candidate.tmdbId ?? undefined,
          firstObservedAt: candidate.firstObservedAt.toISOString(),
          lastObservedAt: candidate.lastObservedAt.toISOString(),
          attemptCount: candidate.attemptCount,
          lastAttemptAt: candidate.lastAttemptAt?.toISOString(),
          nextAttemptAt: candidate.nextAttemptAt?.toISOString(),
          resolvedAt: candidate.resolvedAt?.toISOString(),
          failureReason: candidate.lastFailureReason ?? undefined,
          membershipReason: media?.membershipReason ?? undefined,
          automaticReasons: [
            candidate.automaticFailureReason ??
              candidate.lastFailureReason ??
              '',
            ...(history?.automaticReasons ?? []),
            ...(media?.automaticReasons ?? []),
          ].filter(
            (value, index, all) =>
              Boolean(value) && all.indexOf(value) === index
          ),
          sourceTitleSamples: [
            ...new Set(
              (observationsByCandidate.get(candidate.id) ?? [])
                .map(
                  (observation) => observation.sourceTitle || observation.title
                )
                .filter(Boolean)
            ),
          ].slice(0, 5),
          observationCount:
            observationsByCandidate.get(candidate.id)?.length ?? 0,
          ...(manual
            ? {
                manualResolution: {
                  mediaType: manual.mediaType,
                  tmdbId: manual.tmdbId,
                  actorUserId: manual.actorUserId ?? undefined,
                  updatedAt: manual.updatedAt.toISOString(),
                  revision: manual.revision,
                  canonicalTitle: manual.canonicalTitle,
                },
              }
            : {}),
          ...(override
            ? {
                admissionOverride: {
                  actorUserId: override.actorUserId ?? undefined,
                  updatedAt: override.updatedAt.toISOString(),
                  revision: override.revision,
                },
              }
            : {}),
          ...(history
            ? {
                discoveryHistory: {
                  identityKind: history.identityKind,
                  seasonNumber:
                    history.seasonKey >= 0 ? history.seasonKey : undefined,
                  episodeNumber:
                    history.specialEpisodeKey > 0
                      ? history.specialEpisodeKey
                      : undefined,
                  admitted: history.admitted,
                  legacyProjection: history.legacyProjection,
                  admissionReason: history.admissionReason,
                  activityDate: history.activityDate ?? undefined,
                  activitySource: history.activitySource,
                  firstFreshAt: history.firstFreshAt?.toISOString(),
                  visibleUntil: history.visibleUntil?.toISOString(),
                },
              }
            : {}),
          firstSeenAt:
            history?.firstFreshAt?.toISOString() ??
            media?.firstSeenAt?.toISOString(),
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
            history?.visibleUntil?.toISOString() ??
            (media?.admitted && media.firstSeenAt
              ? new Date(
                  media.firstSeenAt.getTime() +
                    settings.freshVisibilityDays * 86_400_000
                ).toISOString()
              : undefined),
          active: media?.active ?? false,
          show: diagnosticVisibility,
          actionable,
          actions,
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
        needsAttention,
        reviewable,
        historical,
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
