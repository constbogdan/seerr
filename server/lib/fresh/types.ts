import type { FreshAvailabilityType } from '@server/api/autobrr';
import type { FreshContinuityStatus } from '@server/constants/fresh';
import type { FreshEligibilityDateSource } from '@server/lib/fresh/membership';

export type FreshStage =
  | 'configuration'
  | 'filter_authentication'
  | 'source_history'
  | 'observation_persistence'
  | 'checkpoint_commit'
  | 'resolution_search'
  | 'projection_update'
  | 'retention'
  | 'reconciliation';

export type FreshStageStatus =
  | 'not_started'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type FreshFailureReason =
  | 'invalid_configuration'
  | 'filter_missing'
  | 'filter_disabled'
  | 'source_unavailable'
  | 'invalid_source_response'
  | 'invalid_source_order'
  | 'checkpoint_missing'
  | 'source_id_regression'
  | 'tmdb_unavailable'
  | 'tmdb_rate_limited'
  | 'persistence_failed'
  | 'cancelled'
  | 'unexpected_failure';

export interface FreshDiagnosticCounts {
  newAutobrrReleases: number | null;
  persistedObservations: number | null;
  replayedObservations: number | null;
  uniqueCandidates: number | null;
  alreadyResolved: number | null;
  resolutionAttempts: number | null;
  resolved: number | null;
  noMatch: number | null;
  ambiguous: number | null;
  transientFailures: number | null;
  outsideFreshWindow: number | null;
  newFreshMedia: number | null;
  existingFreshMediaUpdated: number | null;
  expiredFreshMedia: number | null;
  currentFreshMedia: number | null;
}

export interface FreshDiagnosticDecision {
  title: string;
  mediaType: 'movie' | 'tv';
  year?: number;
  normalizedTitle: string;
  tmdbId?: number;
  stage: FreshStage;
  outcome: 'accepted' | 'resolved' | 'rejected' | 'retry';
  reason: string;
}

export interface FreshDiagnosticsSnapshot {
  operation: 'sync' | 'reconciliation';
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  failingStage?: FreshStage;
  failureReason?: FreshFailureReason;
  stages: Record<FreshStage, FreshStageStatus>;
  counts: FreshDiagnosticCounts;
  decisions: FreshDiagnosticDecision[];
  checkpoint: { before?: string; after?: string };
  continuityStatus?: FreshContinuityStatus;
  lastGood?: { timestamp: string; itemCount: number };
}

export interface FreshRunResult {
  diagnostics: FreshDiagnosticsSnapshot;
}

export type FreshSort =
  | 'freshest'
  | 'oldest'
  | 'title'
  | 'year'
  | 'vote_average.desc'
  | 'vote_average.asc';

export type FreshCandidateDiagnosticStatus =
  | 'all'
  | 'resolved'
  | 'no_match'
  | 'ambiguous'
  | 'temporary_failure'
  | 'pending'
  | 'resolving'
  | 'outside_eligibility_window'
  | 'eligibility_unknown'
  | 'excluded_content_filter'
  | 'visibility_expired'
  | 'active_fresh'
  | 'needs_attention'
  | 'reviewable'
  | 'historical';

export type FreshCandidateDiagnosticSort =
  | 'priority'
  | 'title.asc'
  | 'title.desc'
  | 'status'
  | 'year.desc'
  | 'year.asc'
  | 'first_seen.desc'
  | 'first_seen.asc'
  | 'last_seen.desc'
  | 'last_seen.asc';

export type FreshCandidateReasonFamily =
  | 'all'
  | 'resolution'
  | 'admission'
  | 'content'
  | 'history'
  | 'source';

export type FreshCandidateSeasonEvidence = 'all' | 'known' | 'unknown';
export type FreshCandidatePresenceFilter = 'all' | 'present' | 'absent';

export interface FreshCandidateDiagnosticQuery {
  page: number;
  search?: string;
  mediaType: 'all' | 'movie' | 'tv';
  status: FreshCandidateDiagnosticStatus;
  sort: FreshCandidateDiagnosticSort;
  reasonFamily: FreshCandidateReasonFamily;
  seasonEvidence: FreshCandidateSeasonEvidence;
  manualResolution: FreshCandidatePresenceFilter;
  admissionOverride: FreshCandidatePresenceFilter;
}

export interface FreshCandidateDiagnosticRow {
  candidateId: number;
  revision: number;
  displayTitle: string;
  parsedTitle: string;
  parsedMediaType: 'movie' | 'tv';
  mediaType: 'movie' | 'tv';
  matchYear?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  resolutionStatus: number;
  displayStatus: FreshCandidateDiagnosticStatus;
  automaticResolution?: {
    status: number;
    mediaType: 'movie' | 'tv';
    tmdbId?: number;
    failureReason?: string;
  };
  tmdbId?: number;
  firstObservedAt: string;
  lastObservedAt: string;
  attemptCount: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  resolvedAt?: string;
  failureReason?: string;
  membershipReason?: string;
  automaticReasons: string[];
  sourceTitleSamples: string[];
  observationCount: number;
  manualResolution?: {
    mediaType: 'movie' | 'tv';
    tmdbId: number;
    actorUserId?: number;
    updatedAt: string;
    revision: number;
    canonicalTitle: string;
  };
  admissionOverride?: {
    actorUserId?: number;
    updatedAt: string;
    revision: number;
  };
  discoveryHistory?: {
    identityKind: 'movie' | 'season' | 'special' | 'legacy_tv';
    seasonNumber?: number;
    episodeNumber?: number;
    admitted: boolean;
    legacyProjection: boolean;
    admissionReason: string;
    activityDate?: string;
    activitySource: string;
    firstFreshAt?: string;
    visibleUntil?: string;
  };
  firstSeenAt?: string;
  lastSeenAt?: string;
  mediaDate?: string;
  eligibility?: {
    observationType: FreshAvailabilityType;
    observationAt: string;
    eligibilityDate?: string;
    eligibilityDateSource: FreshEligibilityDateSource;
    firstQualifyingObservation?: string;
    ageDays?: number;
    eligibilityLimitDays: number;
    legacyEvidence: boolean;
  };
  visibleUntil?: string;
  active: boolean;
  actionable: boolean;
  actions: {
    resolve: boolean;
    resetResolution: boolean;
    admit: boolean;
    removeOverride: boolean;
  };
}

export interface FreshCandidateDiagnosticSummary {
  totalCandidates: number;
  activeFresh: number;
  noMatch: number;
  ambiguous: number;
  temporaryFailure: number;
  outsideEligibilityWindow: number;
  eligibilityUnknown: number;
  excludedContentFilter: number;
  visibilityExpired: number;
  needsAttention: number;
  reviewable: number;
  historical: number;
}

export interface FreshCandidateDiagnosticResponse {
  pageInfo: {
    pages: number;
    page: number;
    results: number;
    pageSize: number;
  };
  results: FreshCandidateDiagnosticRow[];
  summary: FreshCandidateDiagnosticSummary;
}
