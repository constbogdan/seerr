import type {
  AutobrrFilter,
  FreshMediaType,
  FreshRelease,
  FreshReleasePage,
} from '@server/api/autobrr';
import Autobrr, { safeTitle } from '@server/api/autobrr';
import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import type {
  FreshMovieCriteria,
  FreshTvCriteria,
} from '@server/lib/discoverCriteria';
import { candidateQueryOptions } from '@server/lib/fresh/candidateQuery';
import { getSettings } from '@server/lib/settings';

export interface FreshConfiguration {
  enabled: boolean;
  baseUrl: string;
  apiToken: string;
  filter: AutobrrFilter;
  refreshIntervalMs?: number;
  maximumItems?: number;
  candidateWindowDays?: number;
  movieCriteria: FreshMovieCriteria;
  tvCriteria: FreshTvCriteria;
}

export interface FreshMedia {
  mediaType: FreshMediaType;
  tmdbId: number;
  firstSeenAt: string;
}

export interface FreshMediaResult extends FreshMedia {
  result: TmdbMovieResult | TmdbTvResult;
}

export interface FreshDiagnosticCounts {
  autobrrReleasesInspected: number;
  selectedFilterReleases: number;
  eligibleMovieReleases: number;
  eligibleTvReleases: number;
  movieCandidates: number;
  tvCandidates: number;
  successfulMediaMatches: number;
  noCandidateMatch: number;
  movieYearMismatch: number;
  ambiguousMatch: number;
  outsideCandidateWindow: number;
  duplicateMediaCollapsed: number;
  excludedByMaximumItems: number;
  finalFreshItems: number;
}

export type FreshDiagnosticReason =
  | 'media_match_accepted'
  | 'no_candidate_match'
  | 'movie_year_mismatch'
  | 'ambiguous_candidate_match'
  | 'outside_candidate_window'
  | 'duplicate_media_collapsed'
  | 'maximum_items_excluded';

export interface FreshDiagnosticDecision {
  title: string;
  mediaType: FreshMediaType;
  year?: number;
  matchedIdentity?: {
    mediaType: FreshMediaType;
    tmdbId: number;
  };
  gate:
    | 'release-window'
    | 'candidate-match'
    | 'deduplication'
    | 'projection-limit';
  outcome: 'accepted' | 'rejected' | 'collapsed' | 'excluded';
  reason: FreshDiagnosticReason;
}

export interface FreshDiagnosticsSnapshot {
  outcome: 'succeeded' | 'failed';
  startedAt: string;
  completedAt: string;
  failureReason?: 'fresh_refresh_failed';
  counts: FreshDiagnosticCounts;
  decisions: FreshDiagnosticDecision[];
  projection: {
    lastSuccessfulRefresh?: string;
    itemCount: number;
  };
}

interface Candidate {
  mediaType: FreshMediaType;
  tmdbId: number;
  titles: string[];
  year: number;
  result: TmdbMovieResult | TmdbTvResult;
}

export interface FreshDependencies {
  tmdb: Pick<TheMovieDb, 'getDiscoverMovies' | 'getDiscoverTv'>;
  releasePage: (
    filter: AutobrrFilter,
    cursor: number
  ) => Promise<FreshReleasePage>;
  now: () => number;
}

const DAY = 86400000;
const MAX_DIAGNOSTIC_DECISIONS = 100;
const MAX_DECISIONS_PER_REASON = 10;
const key = (type: FreshMediaType, id: number) => `${type}:${id}`;
// Preserve letters, diacritics and digits; fold case, typography and spacing.
// No transliteration, edit distance, token reordering, or release-name parsing.
const normalize = (title: string) =>
  title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const positive = (n: number) => Number.isSafeInteger(n) && n > 0;

const emptyDiagnosticCounts = (): FreshDiagnosticCounts => ({
  autobrrReleasesInspected: 0,
  selectedFilterReleases: 0,
  eligibleMovieReleases: 0,
  eligibleTvReleases: 0,
  movieCandidates: 0,
  tvCandidates: 0,
  successfulMediaMatches: 0,
  noCandidateMatch: 0,
  movieYearMismatch: 0,
  ambiguousMatch: 0,
  outsideCandidateWindow: 0,
  duplicateMediaCollapsed: 0,
  excludedByMaximumItems: 0,
  finalFreshItems: 0,
});

class FreshDiagnosticCollector {
  readonly counts = emptyDiagnosticCounts();
  private readonly decisions = new Map<
    FreshDiagnosticReason,
    FreshDiagnosticDecision[]
  >();

  record(decision: FreshDiagnosticDecision): void {
    const reason = this.decisions.get(decision.reason) ?? [];
    if (reason.length >= MAX_DECISIONS_PER_REASON) return;
    reason.push(decision);
    this.decisions.set(decision.reason, reason);
  }

  snapshot(): FreshDiagnosticDecision[] {
    return [...this.decisions.values()]
      .flat()
      .slice(0, MAX_DIAGNOSTIC_DECISIONS)
      .map((decision) => ({
        ...decision,
        matchedIdentity: decision.matchedIdentity
          ? { ...decision.matchedIdentity }
          : undefined,
      }));
  }
}

export function freshWindow(now: number, days = 90) {
  const end = new Date(now).toISOString().slice(0, 10);
  const start = new Date(Date.parse(end) - days * DAY)
    .toISOString()
    .slice(0, 10);
  return { start, end };
}

async function candidates(
  tmdb: FreshDependencies['tmdb'],
  now: number,
  config: FreshConfiguration,
  diagnostics: FreshDiagnosticCollector
) {
  const { start, end } = freshWindow(now, config.candidateWindowDays);
  const result: Candidate[] = [];
  for (const mediaType of ['movie', 'tv'] as const) {
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const response =
        mediaType === 'movie'
          ? await tmdb.getDiscoverMovies({
              ...candidateQueryOptions(
                config.movieCriteria,
                'movie',
                start,
                end
              ),
              page,
            })
          : await tmdb.getDiscoverTv({
              ...candidateQueryOptions(config.tvCriteria, 'tv', start, end),
              page,
            });
      if (
        response.page !== page ||
        !Number.isInteger(response.total_pages) ||
        response.total_pages < 0 ||
        response.total_pages > 500 ||
        !Array.isArray(response.results) ||
        ((response.total_results > 0 || page > 1) &&
          response.results.length === 0) ||
        (response.total_pages === 0 && response.results.length > 0)
      ) {
        throw new Error('Invalid Fresh candidate page');
      }
      // A changed page count is not a snapshot; fail instead of publishing a
      // knowingly incomplete intersection and retry on the next refresh.
      if (page > 1 && response.total_pages !== pages)
        throw new Error('Fresh candidates changed');
      pages = response.total_pages;
      for (const item of response.results) {
        const date =
          'release_date' in item ? item.release_date : item.first_air_date;
        const titles =
          'title' in item
            ? [item.title, item.original_title]
            : [item.name, item.original_name];
        if (
          !positive(item.id) ||
          typeof date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          date < start ||
          date > end
        )
          continue;
        result.push({
          mediaType,
          tmdbId: item.id,
          titles: titles.filter(safeTitle),
          year: Number(date.slice(0, 4)),
          result: item,
        });
        if (mediaType === 'movie') diagnostics.counts.movieCandidates++;
        else diagnostics.counts.tvCandidates++;
      }
    }
  }
  return result;
}

/** Rebuildable shared state. Own one instance per configured Fresh source.
 * Server-only configuration is supplied by the owner; no settings/API exposure.
 */
export class FreshMediaState {
  #items: FreshMediaResult[] = [];
  #members = new Set<string>();
  #pending?: Promise<void>;
  #lastAttempt = -Infinity;
  #lastSuccess?: string;
  #lastAttemptAt?: string;
  #lastError?: string;
  #diagnostics?: FreshDiagnosticsSnapshot;
  #status: 'idle' | 'ready' | 'stale' | 'unavailable' | 'disabled' = 'idle';
  #dependencies: FreshDependencies;
  #config: FreshConfiguration;

  constructor(config: FreshConfiguration, dependencies: FreshDependencies) {
    if (
      !positive(config.refreshIntervalMs ?? 300000) ||
      !positive(config.maximumItems ?? 20) ||
      !positive(config.candidateWindowDays ?? 90) ||
      !positive(config.filter.id)
    ) {
      throw new Error('Invalid Fresh configuration');
    }
    this.#config = { ...config, filter: { ...config.filter } };
    this.#dependencies = dependencies;
    if (!config.enabled) this.#status = 'disabled';
  }

  get status() {
    return {
      status: this.#status,
      refreshing: this.#pending !== undefined,
      lastRefresh: this.#lastSuccess,
      lastAttempt: this.#lastAttemptAt,
      itemCount: Math.min(this.#items.length, this.#config.maximumItems ?? 20),
      error: this.#lastError,
    };
  }

  get diagnostics(): FreshDiagnosticsSnapshot | undefined {
    return this.#diagnostics
      ? {
          ...this.#diagnostics,
          counts: { ...this.#diagnostics.counts },
          decisions: this.#diagnostics.decisions.map((decision) => ({
            ...decision,
            matchedIdentity: decision.matchedIdentity
              ? { ...decision.matchedIdentity }
              : undefined,
          })),
          projection: { ...this.#diagnostics.projection },
        }
      : undefined;
  }

  ordered(limit = this.#config.maximumItems ?? 20): FreshMedia[] {
    return positive(limit)
      ? this.#items
          .slice(0, limit)
          .map(({ mediaType, tmdbId, firstSeenAt }) => ({
            mediaType,
            tmdbId,
            firstSeenAt,
          }))
      : [];
  }

  orderedResults(limit = this.#config.maximumItems ?? 20): FreshMediaResult[] {
    return positive(limit)
      ? this.#items.slice(0, limit).map((item) => ({
          ...item,
          result: { ...item.result },
        }))
      : [];
  }

  has(mediaType: FreshMediaType, tmdbId: number): boolean {
    return this.#members.has(key(mediaType, tmdbId));
  }

  refresh(force = false): Promise<void> {
    if (this.#pending) return this.#pending;
    if (
      !this.#config.enabled ||
      (!force &&
        this.#dependencies.now() - this.#lastAttempt <
          (this.#config.refreshIntervalMs ?? 300000))
    )
      return Promise.resolve();
    this.#lastAttempt = this.#dependencies.now();
    this.#lastAttemptAt = new Date(this.#lastAttempt).toISOString();
    this.#pending = this.rebuild().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  private async rebuild(): Promise<void> {
    const startedAtValue = this.#dependencies.now();
    const startedAt = new Date(startedAtValue).toISOString();
    const diagnostics = new FreshDiagnosticCollector();
    try {
      const now = startedAtValue;
      const { start } = freshWindow(now, this.#config.candidateWindowDays);
      const lookup = new Map<string, Map<string, Candidate>>();
      for (const item of await candidates(
        this.#dependencies.tmdb,
        now,
        this.#config,
        diagnostics
      )) {
        for (const title of item.titles) {
          const normalized = normalize(title);
          if (!normalized) continue;
          const alias = `${item.mediaType}:${normalized}`;
          const matches = lookup.get(alias) ?? new Map<string, Candidate>();
          matches.set(key(item.mediaType, item.tmdbId), item);
          lookup.set(alias, matches);
        }
      }
      const matches = new Map<string, FreshMediaResult>();
      const matchedTitles = new Map<string, string>();
      const intersect = (release: FreshRelease) => {
        if (
          release.observedAt < Date.parse(start) ||
          release.observedAt > now
        ) {
          diagnostics.counts.outsideCandidateWindow++;
          diagnostics.record({
            title: release.title,
            mediaType: release.mediaType,
            ...(release.year ? { year: release.year } : {}),
            gate: 'release-window',
            outcome: 'rejected',
            reason: 'outside_candidate_window',
          });
          return;
        }
        const titleChoices = [
          ...(lookup
            .get(`${release.mediaType}:${normalize(release.title)}`)
            ?.values() ?? []),
        ];
        if (titleChoices.length === 0) {
          diagnostics.counts.noCandidateMatch++;
          diagnostics.record({
            title: release.title,
            mediaType: release.mediaType,
            ...(release.year ? { year: release.year } : {}),
            gate: 'candidate-match',
            outcome: 'rejected',
            reason: 'no_candidate_match',
          });
          return;
        }
        const choices = titleChoices.filter(
          (item) => release.mediaType === 'tv' || item.year === release.year
        );
        if (release.mediaType === 'movie' && choices.length === 0) {
          diagnostics.counts.movieYearMismatch++;
          diagnostics.record({
            title: release.title,
            mediaType: release.mediaType,
            year: release.year,
            gate: 'candidate-match',
            outcome: 'rejected',
            reason: 'movie_year_mismatch',
          });
          return;
        }
        if (choices.length !== 1) {
          diagnostics.counts.ambiguousMatch++;
          diagnostics.record({
            title: release.title,
            mediaType: release.mediaType,
            ...(release.year ? { year: release.year } : {}),
            gate: 'candidate-match',
            outcome: 'rejected',
            reason: 'ambiguous_candidate_match',
          });
          return;
        }
        const candidate = choices[0];
        const identity = key(candidate.mediaType, candidate.tmdbId);
        const firstSeenAt = new Date(release.observedAt).toISOString();
        const previous = matches.get(identity);
        diagnostics.counts.successfulMediaMatches++;
        if (previous) {
          diagnostics.counts.duplicateMediaCollapsed++;
          diagnostics.record({
            title: release.title,
            mediaType: release.mediaType,
            ...(release.year ? { year: release.year } : {}),
            matchedIdentity: {
              mediaType: candidate.mediaType,
              tmdbId: candidate.tmdbId,
            },
            gate: 'deduplication',
            outcome: 'collapsed',
            reason: 'duplicate_media_collapsed',
          });
        } else {
          matchedTitles.set(identity, release.title);
          diagnostics.record({
            title: release.title,
            mediaType: release.mediaType,
            ...(release.year ? { year: release.year } : {}),
            matchedIdentity: {
              mediaType: candidate.mediaType,
              tmdbId: candidate.tmdbId,
            },
            gate: 'candidate-match',
            outcome: 'accepted',
            reason: 'media_match_accepted',
          });
        }
        if (!previous || firstSeenAt < previous.firstSeenAt) {
          matches.set(identity, {
            mediaType: candidate.mediaType,
            tmdbId: candidate.tmdbId,
            firstSeenAt,
            result: candidate.result,
          });
        }
      };
      let cursor = 0;
      // Bound runaway histories. Hitting the budget fails closed, never
      // presents a partial scan as complete. No timestamp/last-ID early exit.
      for (let page = 0; ; page++) {
        if (page >= 1000) throw new Error('Fresh release page budget exceeded');
        const result = await this.#dependencies.releasePage(
          this.#config.filter,
          cursor
        );
        diagnostics.counts.autobrrReleasesInspected += result.counts.inspected;
        diagnostics.counts.selectedFilterReleases +=
          result.counts.selectedFilter;
        diagnostics.counts.eligibleMovieReleases +=
          result.counts.eligibleMovies;
        diagnostics.counts.eligibleTvReleases += result.counts.eligibleTv;
        result.releases.forEach(intersect);
        if (result.nextCursor === 0) break;
        if (
          !positive(result.nextCursor) ||
          (cursor && result.nextCursor >= cursor)
        )
          throw new Error('Invalid Fresh cursor');
        cursor = result.nextCursor;
      }
      const items = [...matches.values()].sort(
        (a, b) =>
          b.firstSeenAt.localeCompare(a.firstSeenAt) ||
          a.mediaType.localeCompare(b.mediaType) ||
          a.tmdbId - b.tmdbId
      );
      const maximumItems = this.#config.maximumItems ?? 20;
      diagnostics.counts.excludedByMaximumItems = Math.max(
        0,
        items.length - maximumItems
      );
      diagnostics.counts.finalFreshItems = Math.min(items.length, maximumItems);
      for (const item of items.slice(maximumItems)) {
        const identity = key(item.mediaType, item.tmdbId);
        const title = matchedTitles.get(identity);
        if (!title) continue;
        diagnostics.record({
          title,
          mediaType: item.mediaType,
          matchedIdentity: {
            mediaType: item.mediaType,
            tmdbId: item.tmdbId,
          },
          gate: 'projection-limit',
          outcome: 'excluded',
          reason: 'maximum_items_excluded',
        });
      }
      this.#items = items;
      this.#members = new Set(
        items.map((item) => key(item.mediaType, item.tmdbId))
      );
      this.#lastSuccess = new Date(now).toISOString();
      this.#status = 'ready';
      this.#lastError = undefined;
      this.#diagnostics = {
        outcome: 'succeeded',
        startedAt,
        completedAt: new Date(this.#dependencies.now()).toISOString(),
        counts: { ...diagnostics.counts },
        decisions: diagnostics.snapshot(),
        projection: {
          lastSuccessfulRefresh: this.#lastSuccess,
          itemCount: diagnostics.counts.finalFreshItems,
        },
      };
    } catch {
      this.#status = this.#lastSuccess ? 'stale' : 'unavailable';
      this.#lastError = 'Fresh refresh failed.';
      this.#diagnostics = {
        outcome: 'failed',
        startedAt,
        completedAt: new Date(this.#dependencies.now()).toISOString(),
        failureReason: 'fresh_refresh_failed',
        counts: { ...diagnostics.counts },
        decisions: diagnostics.snapshot(),
        projection: {
          lastSuccessfulRefresh: this.#lastSuccess,
          itemCount: Math.min(
            this.#items.length,
            this.#config.maximumItems ?? 20
          ),
        },
      };
      // Never retain/log provider errors: they may include credentials or URLs.
    }
  }
}

class FreshTmdb extends TheMovieDb {
  constructor() {
    const { discoverRegion, originalLanguage } = getSettings().main;
    super({ discoverRegion, originalLanguage });
    this.axios.defaults.timeout = 15000;
  }
}

export function createFreshMediaState(
  config: FreshConfiguration
): FreshMediaState {
  // Lazy clients keep disabled sources independent of connection configuration.
  const { baseUrl, apiToken } = config;
  let tmdb: FreshTmdb | undefined;
  let autobrr: Autobrr | undefined;
  return new FreshMediaState(config, {
    now: Date.now,
    tmdb: {
      getDiscoverMovies: (options) =>
        (tmdb ??= new FreshTmdb()).getDiscoverMovies(options),
      getDiscoverTv: (options) =>
        (tmdb ??= new FreshTmdb()).getDiscoverTv(options),
    },
    releasePage: (filter, cursor) =>
      (autobrr ??= new Autobrr(baseUrl, apiToken)).page(filter, cursor),
  });
}
