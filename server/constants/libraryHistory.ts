export enum LibraryMediaType {
  MOVIE = 'movie',
  SERIES = 'series',
}

export enum IdentityResolutionState {
  UNRESOLVED = 0,
  RESOLVED = 1,
  CONFLICT = 2,
}

export enum ViewingCompletionClassification {
  UNKNOWN = 0,
  CONFIRMED = 1,
  LIKELY = 2,
  PARTIAL = 3,
  NO_QUALIFYING_EVIDENCE = 4,
  UNRESOLVED = 5,
}

export enum HydrationRunStatus {
  RUNNING = 0,
  SUCCEEDED = 1,
  FAILED = 2,
  CANCELLED = 3,
}

export enum SourceCheckpointStatus {
  UNINITIALIZED = 0,
  CURRENT = 1,
  STALE = 2,
  FAILED = 3,
}

export enum LibraryReconciliationState {
  UNKNOWN = 0,
  CURRENT = 1,
  PENDING = 2,
  STALE = 3,
  INCONSISTENT = 4,
}

export enum LibraryRemovalSource {
  MANUAL = 'manual',
  SCHEDULED = 'scheduled',
  EXTERNAL = 'external',
  UNKNOWN = 'unknown',
}
