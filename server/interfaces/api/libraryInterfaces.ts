import type { MediaRequestStatus, MediaType } from '@server/constants/media';

import type { PaginatedResponse } from './common';

export type LibraryMediaType = 'movie' | 'series';
export type LibraryScope = 'current' | 'archive' | 'all';
export type LibraryMediaTypeFilter = 'all' | LibraryMediaType;
export type LibraryCollectionMembershipFilter = 'any' | 'in' | 'none';
export type LibraryCollectionCompletenessFilter =
  | 'all'
  | 'complete'
  | 'incomplete';
export type LibraryCollectionSort = 'name' | 'completeness' | 'available';
export type LibraryCollectionHydrationState =
  | 'pending'
  | 'complete'
  | 'partial'
  | 'unavailable';
export type LibraryAnimationFilter = 'any' | 'yes' | 'no';
export type LibraryWatchlistFilter = 'any' | 'yes' | 'no';
export type LibraryWatchedFilter = 'any' | 'yes' | 'no';
export type LibraryRequestedFilter = 'any' | 'yes' | 'no';
export type LibraryActivityFilter = 'any' | 'present' | 'none';
export type LibrarySort =
  | 'title'
  | 'added'
  | 'lastActive'
  | 'size'
  | 'removed'
  | 'watchedUsers';
export type LibrarySortDirection = 'asc' | 'desc';
export type LibraryScheduledFilter = 'any' | 'yes' | 'no';
export type LibraryRemovalSource =
  | 'manual'
  | 'scheduled'
  | 'external'
  | 'unknown';

export interface LibraryRemovalSchedule {
  id: number;
  canonicalMediaId: number;
  targetType: 'movie' | 'series' | 'season';
  seasonNumber: number | null;
  origin: 'manual' | 'automatic';
  status: 'active' | 'deferred';
  scheduledAt: string;
  removeAt: string;
  revision: number;
}

export interface LibraryUser {
  id: number;
  displayName: string;
  avatar: string | null;
}

export interface LibraryRequestSeasonFact {
  id: number;
  seasonNumber: number;
  status: MediaRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryRequestFact {
  id: number;
  type: MediaType;
  status: MediaRequestStatus;
  is4k: boolean;
  isAutoRequest: boolean;
  createdAt: string;
  updatedAt: string;
  seasons: LibraryRequestSeasonFact[];
}

export interface LibraryRequester extends LibraryUser {
  requests: LibraryRequestFact[];
}

export interface LibraryFilterUser extends LibraryUser {
  available: boolean;
}

export interface LibraryWatchedUser {
  key: string;
  userId: number | null;
  displayName: string;
  avatar: string | null;
  watchedEpisodeCount: number | null;
  availableEpisodeCount: number | null;
  watchedPercentage: number;
  lastViewedAt: string | null;
}

export interface LibraryStorageRootSummary {
  id: number;
  label: string;
  color: string | null;
}

export interface LibrarySeasonSummary {
  key: string;
  seasonNumber: number;
  isSpecial: boolean;
  state: 'current' | 'archive' | 'known_missing';
  availableEpisodeCount: number;
  knownEpisodeCount: number | null;
  resolution: number | null;
  requestable: boolean;
  acquiring: boolean;
}

export interface LibraryExternalLink {
  service: 'radarr' | 'sonarr' | 'jellyfin';
  label: string;
  url: string;
}

export interface LibraryTmdbRating {
  voteAverage: number;
  voteCount: number;
}

export interface LibraryCollectionSummary {
  id: number;
  name: string;
  posterPath: string | null;
  backdropPath: string | null;
}

export interface LibraryItem {
  canonicalMediaId: number;
  tmdbId: number | null;
  mediaType: LibraryMediaType;
  libraryState: Exclude<LibraryScope, 'all'>;
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  addedAt: string | null;
  removedAt: string | null;
  removalSource: LibraryRemovalSource | null;
  logicalSizeBytes: string | null;
  resolution: number | null;
  watchlistUsers: LibraryUser[];
  watchedUsers: LibraryWatchedUser[];
  watchedUserCount: number;
  hasWatchedDetail: boolean;
  lastActiveAt: string | null;
  lastActiveUsers: LibraryUser[];
  requesters: LibraryRequester[];
  storageRoots: LibraryStorageRootSummary[];
  fresh: boolean;
  seasonSummaries: LibrarySeasonSummary[];
  externalLinks: LibraryExternalLink[];
  tmdbRating: LibraryTmdbRating | null;
  collection: LibraryCollectionSummary | null;
  removalSchedules?: LibraryRemovalSchedule[];
}

export interface LibrarySourceStatus {
  library: 'current' | 'incomplete';
  currentViewing: 'current' | 'incomplete';
  historicalViewing: 'current' | 'incomplete';
  historicalImport: {
    state: 'not-imported' | 'accepted';
    observedRange: {
      startedAt: string | null;
      endedAt: string | null;
      completeness: 'not-asserted';
    } | null;
    contentHash: string | null;
  };
}

export interface LibraryResultsResponse extends PaginatedResponse {
  results: LibraryItem[];
  storageLocations: { id: number; label: string }[];
  sourceStatus: LibrarySourceStatus;
  collectionMembershipUnknownCount?: number;
  presentation?: LibraryPresentationBatchStatus;
}

export interface LibraryCollectionItem {
  id: number;
  name: string;
  overview: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  availableMovies: number | null;
  totalMovies: number | null;
  completeness: 'complete' | 'incomplete' | 'unknown';
}

export interface LibraryCollectionsResponse extends PaginatedResponse {
  results: LibraryCollectionItem[];
  status: LibraryCollectionHydrationState;
  stale: boolean;
  discoveredCollections: number;
  failedCollections: number;
  refreshedAt: string | null;
}

export type LibraryPresentationState = 'complete' | 'pending' | 'partial';

export interface LibraryPresentationStatus {
  state: LibraryPresentationState | 'expired';
  revision: number;
  pendingCount: number;
}

export interface LibraryPresentationBatchStatus extends Omit<
  LibraryPresentationStatus,
  'state'
> {
  state: LibraryPresentationState;
  batchId?: string;
}

export interface LibraryFilterUsersResponse {
  users: LibraryFilterUser[];
}

export interface LibrarySeasonWatchedUser {
  key: string;
  userId: number | null;
  displayName: string;
  avatar: string | null;
  watchedEpisodeCount: number;
  watchedPercentage: number;
  lastViewedAt: string | null;
}

export interface LibrarySeasonDetail {
  seasonNumber: number;
  isSpecial: boolean;
  availableEpisodeCount: number;
  resolution: number | null;
  sizeBytes: string | null;
  removedAt: string | null;
  removalSource: LibraryRemovalSource | null;
  users: LibrarySeasonWatchedUser[];
}

export interface LibrarySeriesDetailResponse {
  canonicalMediaId: number;
  seasons: LibrarySeasonDetail[];
  removalSchedules?: LibraryRemovalSchedule[];
}

export type LibraryBulkAction = 'schedule' | 'cancel_schedule' | 'remove_now';

export interface LibraryBulkActionTarget {
  canonicalMediaId: number;
  targetType: 'movie' | 'series' | 'season';
  seasonNumber?: number;
}

export type LibraryBulkActionOutcome =
  | 'scheduled'
  | 'already_scheduled'
  | 'cancelled'
  | 'not_scheduled'
  | 'provider_acknowledged'
  | 'provider_absent_reconciled'
  | 'not_current'
  | 'missing'
  | 'ambiguous_source'
  | 'active_acquisition'
  | 'in_progress'
  | 'identity_conflict'
  | 'cross_season_file'
  | 'remote_removed_local_failed'
  | 'failed'
  | 'not_attempted';

export interface LibraryBulkActionResult {
  target: LibraryBulkActionTarget;
  outcome: LibraryBulkActionOutcome;
  code: string;
  retryable: boolean;
  message: string;
  affectedSchedules: number;
}

export interface LibraryBulkActionRequest {
  action: LibraryBulkAction;
  targets: LibraryBulkActionTarget[];
}

export type LibraryBulkActionEligibility =
  | 'schedule'
  | 'cancel_schedule'
  | 'unavailable'
  | 'conflict'
  | 'unknown';

export type LibraryBulkActionEligibilityReason =
  | 'unscheduled'
  | 'scheduled'
  | 'processing_lease'
  | 'execution_in_progress'
  | 'whole_series_scheduled'
  | 'not_current'
  | 'missing'
  | 'ambiguous_source'
  | 'active_acquisition'
  | 'identity_conflict'
  | 'configuration'
  | 'unavailable';

export interface LibraryBulkActionEligibilityRequest {
  targets: LibraryBulkActionTarget[];
}

export interface LibraryBulkActionEligibilityResult {
  target: LibraryBulkActionTarget;
  eligibility: LibraryBulkActionEligibility;
  reason: LibraryBulkActionEligibilityReason;
}

export interface LibraryBulkActionEligibilityResponse {
  results: LibraryBulkActionEligibilityResult[];
}

export interface LibrarySelectionSizeRequest {
  targets: LibraryBulkActionTarget[];
}

export interface LibrarySelectionSizeResponse {
  targets: LibraryBulkActionTarget[];
  sizeBytes: string | null;
  fileCount: number;
  unknownFileCount: number;
}

export interface LibraryBulkActionResponse {
  action: LibraryBulkAction;
  requested: number;
  succeeded: number;
  unchanged: number;
  skipped: number;
  failed: number;
  results: LibraryBulkActionResult[];
}

export interface LeavingSoonItem {
  canonicalMediaId: number;
  tmdbId: number | null;
  mediaType: LibraryMediaType;
  title: string;
  year: number | null;
  posterPath: string | null;
  schedules: LibraryRemovalSchedule[];
}

export interface LeavingSoonResultsResponse extends PaginatedResponse {
  results: LeavingSoonItem[];
  presentation?: LibraryPresentationBatchStatus;
}
