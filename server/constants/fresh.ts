export type FreshMediaType = 'movie' | 'tv';

/** Retained only by legacy entity/migration contracts, never V2 runtime policy. */
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
export const FRESH_PAGE_SIZE = 20;
