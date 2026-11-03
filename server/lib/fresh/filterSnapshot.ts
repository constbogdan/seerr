import {
  matchesFreshContentFilters,
  normalizeFreshContentFilters,
} from '@server/lib/fresh/contentFilters';
import {
  freshPresentationKey,
  type FreshProviderPresentation,
  type resolveFreshPagePresentation,
} from '@server/lib/fresh/presentation';
import type { FreshSort } from '@server/lib/fresh/types';
import type { FreshSettings } from '@server/lib/settings';
import { createHash } from 'crypto';

// Request-scoped evaluation, not a sync job or persistent metadata projection.
export const FRESH_FILTER_MAX_ITEMS = 5000;
const BATCH_SIZE = 20;
const SNAPSHOT_TTL_MS = 60_000;
const EVALUATION_BUDGET_MS = 120_000;
type Identity = {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  discoveredAt: Date | string;
};
type Snapshot = {
  accepted: Set<string>;
  presentations: Map<string, FreshProviderPresentation>;
  expires: number;
};

export const isFreshMetricSort = (
  sort: unknown
): sort is 'vote_average' | 'vote_count' =>
  sort === 'vote_average' || sort === 'vote_count';

const discoveryTime = (value: Date | string): number => {
  if (value instanceof Date) return value.getTime();
  const timestamp = value.replace(' ', 'T');
  return new Date(
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp) ? timestamp : timestamp + 'Z'
  ).getTime();
};

/** Filter and order one complete snapshot, never a selected page. */
export const selectFreshSnapshotRows = <T extends Identity>(
  population: T[],
  snapshot: Snapshot,
  sort: FreshSort
): T[] => {
  const eligible = population.filter((row) =>
    snapshot.accepted.has(freshPresentationKey(row))
  );
  if (!isFreshMetricSort(sort)) return eligible; // SQL already ordered First Seen.
  const metric = (row: Identity): number | undefined => {
    const value = snapshot.presentations.get(freshPresentationKey(row))?.[sort];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
      return undefined;
    if (sort === 'vote_average' ? value > 10 : !Number.isSafeInteger(value))
      return undefined;
    return value;
  };
  return eligible.sort((a, b) => {
    const left = metric(a);
    const right = metric(b);
    if (left === undefined && right !== undefined) return 1;
    if (left !== undefined && right === undefined) return -1;
    if (left !== undefined && right !== undefined && left !== right)
      return right - left;
    const firstSeen =
      discoveryTime(b.discoveredAt) - discoveryTime(a.discoveredAt);
    if (firstSeen) return firstSeen;
    if (a.mediaType !== b.mediaType) return a.mediaType < b.mediaType ? -1 : 1;
    return a.tmdbId - b.tmdbId;
  });
};

export class FreshFilterSnapshots {
  private cache = new Map<string, Snapshot>();
  private active?: { key: string; promise: Promise<Snapshot> };
  constructor(private now: () => number = Date.now) {}

  async evaluate(
    population: Identity[],
    settings: FreshSettings,
    locale: string,
    present: typeof resolveFreshPagePresentation
  ): Promise<Snapshot> {
    if (population.length > FRESH_FILTER_MAX_ITEMS)
      throw new Error('fresh_filter_population_limit');
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          locale,
          normalizeFreshContentFilters(settings),
          [...population]
            .sort((a, b) =>
              freshPresentationKey(a).localeCompare(freshPresentationKey(b))
            )
            .map((row) => [row.mediaType, row.tmdbId, row.discoveredAt]),
        ])
      )
      .digest('hex');
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached;
    if (this.active) {
      if (this.active.key === key) return this.active.promise;
      throw new Error('fresh_filter_evaluation_busy');
    }
    const promise = this.build(population, settings, locale, present);
    this.active = { key, promise };
    try {
      const snapshot = await promise;
      this.cache.delete(key);
      this.cache.set(key, snapshot);
      while (this.cache.size > 4)
        this.cache.delete(this.cache.keys().next().value!);
      return snapshot;
    } finally {
      this.active = undefined;
    }
  }

  private async build(
    population: Identity[],
    settings: FreshSettings,
    locale: string,
    present: typeof resolveFreshPagePresentation
  ): Promise<Snapshot> {
    const started = this.now();
    const accepted = new Set<string>();
    const presentations = new Map<string, FreshProviderPresentation>();
    for (let offset = 0; offset < population.length; offset += BATCH_SIZE) {
      if (this.now() - started >= EVALUATION_BUDGET_MS)
        throw new Error('fresh_filter_metadata_budget');
      const batch = population.slice(offset, offset + BATCH_SIZE);
      const metadata = await present(batch, locale);
      for (const item of batch) {
        const key = freshPresentationKey(item);
        const value = metadata.get(key);
        if (!value || value.id !== item.tmdbId)
          throw new Error('fresh_filter_metadata_unavailable');
        presentations.set(key, value);
        if (matchesFreshContentFilters(value, settings)) accepted.add(key);
      }
    }
    return { accepted, presentations, expires: this.now() + SNAPSHOT_TTL_MS };
  }
}
