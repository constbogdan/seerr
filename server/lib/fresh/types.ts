export type FreshSort = 'freshest' | 'oldest' | 'vote_average' | 'vote_count';

export interface FreshRunResult {
  ingested: number;
  examined: number;
  resolved: number;
  skipped: number;
  retried: number;
  backfillComplete: boolean;
  sourceFailed: boolean;
  cancelled: boolean;
}

export interface FreshStatus {
  status:
    | 'disabled'
    | 'preparing'
    | 'refreshing'
    | 'ready'
    | 'stale'
    | 'unavailable';
  refreshing: boolean;
  backfillComplete: boolean;
  itemCount: number;
  lastRefresh?: string;
  checkpoint?: string;
  pendingWork: number;
  error?: string;
}
