export type FreshMediaType = 'movie' | 'tv';

export enum FreshContinuityStatus {
  UNINITIALIZED = 1,
  CURRENT = 2,
  RECONCILIATION_REQUIRED = 3,
  GAP_PRESERVED = 4,
}

export enum FreshCandidateStatus {
  UNRESOLVED = 1,
  RESOLVING = 2,
  RESOLVED = 3,
  NO_MATCH = 4,
  AMBIGUOUS = 5,
  TRANSIENT_FAILURE = 6,
  OUTSIDE_WINDOW = 7,
}

export const FRESH_SYNC_STATE_ID = 1;
export const DEFAULT_MEDIA_ELIGIBILITY_DAYS = 90;
export const MIN_MEDIA_ELIGIBILITY_DAYS = 1;
export const MAX_MEDIA_ELIGIBILITY_DAYS = 365;
export const DEFAULT_FRESH_VISIBILITY_DAYS = 7;
export const MIN_FRESH_VISIBILITY_DAYS = 1;
export const MAX_FRESH_VISIBILITY_DAYS = 90;
export const FRESH_PAGE_SIZE = 20;
export const FRESH_CANDIDATE_PAGE_SIZE = 25;
