import type { MovieResult, TvResult } from '@server/models/Search';

export const FRESH_API_PATH = '/api/v1/fresh';

export type FreshMediaResult = (MovieResult | TvResult) & {
  freshFirstSeenAt: string;
};

export interface FreshStatus {
  status:
    | 'preparing'
    | 'refreshing'
    | 'ready'
    | 'stale'
    | 'unavailable'
    | 'disabled';
  refreshing: boolean;
  lastRefresh?: string;
  itemCount: number;
  error?: string;
}

export interface FreshResponse {
  page: number;
  totalPages: number;
  totalResults: number;
  results: FreshMediaResult[];
  status: FreshStatus;
}
