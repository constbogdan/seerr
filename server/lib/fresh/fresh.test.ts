import type { FreshRelease } from '@server/api/autobrr';
import Autobrr, { parseFilters, parseReleasePage } from '@server/api/autobrr';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import type { FreshConfiguration, FreshDependencies } from '@server/lib/fresh';
import { FreshMediaState, freshWindow } from '@server/lib/fresh';
import type { AxiosAdapter } from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const NOW = Date.parse('2026-09-06T12:00:00Z');
const config: FreshConfiguration = {
  enabled: true,
  baseUrl: 'https://autobrr.test',
  apiToken: 'fixture-token',
  filter: { id: 7 },
  refreshIntervalMs: 1000,
  maximumItems: 2,
  movieCriteria: {},
  tvCriteria: {},
};
const movie = (id = 1, title = 'The Movie', year = 2026): TmdbMovieResult => ({
  id,
  title,
  original_title: title,
  release_date: `${year}-08-01`,
  media_type: 'movie',
  adult: false,
  video: false,
  popularity: 0,
  vote_count: 0,
  vote_average: 0,
  genre_ids: [],
  overview: '',
  original_language: 'en',
});
const tv = (id = 1, name = 'The Series'): TmdbTvResult => ({
  id,
  name,
  original_name: name,
  first_air_date: '2026-07-01',
  media_type: 'tv',
  origin_country: [],
  popularity: 0,
  vote_count: 0,
  vote_average: 0,
  genre_ids: [],
  overview: '',
  original_language: 'en',
});
const row = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 9,
  title: 'The Movie',
  year: 2026,
  filter: 'Fresh',
  action_status: [{ filter_id: 7 }],
  filter_status: 'FILTER_APPROVED',
  timestamp: '2026-09-01T10:00:00Z',
  download_url: 'https://tracker.test/download?passkey=fixture-secret',
  info_url: 'https://tracker.test/?apikey=fixture-secret',
  ...overrides,
});
const release = (overrides: Partial<FreshRelease> = {}): FreshRelease => ({
  title: 'The Movie',
  mediaType: 'movie',
  year: 2026,
  observedAt: Date.parse('2026-09-01T10:00:00Z'),
  ...overrides,
});

function fixture(movies = [movie()], shows = [tv()]) {
  let now = NOW;
  let rows = [
    row(4),
    row(3, { type: 6, title: 'The Series', season: 1, episode: 1 }),
  ];
  const cursors: number[] = [];
  const deps: FreshDependencies = {
    now: () => now,
    tmdb: {
      getDiscoverMovies: async () => ({
        page: 1,
        total_pages: 1,
        total_results: movies.length,
        results: movies,
      }),
      getDiscoverTv: async () => ({
        page: 1,
        total_pages: 1,
        total_results: shows.length,
        results: shows,
      }),
    },
    releasePage: async (filter, cursor) => {
      cursors.push(cursor);
      const data = rows.filter((r) => !cursor || r.id < cursor).slice(0, 2);
      return parseReleasePage(
        { data, next_cursor: data.at(-1)?.id ?? 0 },
        filter,
        cursor
      );
    },
  };
  return {
    deps,
    cursors,
    setRows: (value: typeof rows) => {
      rows = value;
    },
    tick: () => {
      now += 1000;
    },
  };
}

describe('Fresh projection', () => {
  it('intersects movie title/year and TV titles while retaining typed numeric IDs', async () => {
    const f = fixture();
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    assert.equal(state.has('movie', 1), true);
    assert.equal(state.has('tv', 1), true);
    assert.equal(state.ordered().length, 2);
    assert.equal(state.status.status, 'ready');
  });

  it('matches original titles and conservative typography, but rejects wrong movie years', async () => {
    const f = fixture(
      [{ ...movie(), original_title: 'L’Histoire' }],
      [{ ...tv(), original_name: 'Série Originale' }]
    );
    f.setRows([
      row(3, { title: "l'histoire" }),
      row(2, { title: 'Série Originale', type: 11 }),
      row(1, { title: 'The Movie', year: 2025 }),
    ]);
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    assert.equal(state.ordered().length, 2);
    const wrong = fixture();
    wrong.setRows([row(1, { year: 2025 })]);
    const wrongState = new FreshMediaState(config, wrong.deps);
    await wrongState.refresh();
    assert.deepEqual(wrongState.ordered(), []);
  });

  it('collapses encodes and episodes, scans past the requested count, and keeps earliest observation order', async () => {
    const f = fixture([movie(), movie(2, 'Other Movie')]);
    f.setRows([
      row(8),
      row(7),
      row(6, { type: 6, title: 'The Series', episode: 2 }),
      row(5, { title: 'Other Movie', timestamp: '2026-08-20T00:00:00Z' }),
      row(4, { timestamp: '2026-08-01T00:00:00Z' }),
      row(3, {
        type: 6,
        title: 'The Series',
        episode: 1,
        timestamp: '2026-08-10T00:00:00Z',
      }),
    ]);
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    assert.deepEqual(f.cursors, [0, 7, 5, 3]);
    assert.deepEqual(
      state.ordered().map((r) => [r.mediaType, r.tmdbId]),
      [
        ['movie', 2],
        ['tv', 1],
      ]
    );
    assert.equal(state.has('movie', 1), true); // Membership is not the row limit.
    assert.equal(state.ordered(10)[2].firstSeenAt, '2026-08-01T00:00:00.000Z');
    assert.equal(state.diagnostics?.counts.successfulMediaMatches, 6);
    assert.equal(state.diagnostics?.counts.duplicateMediaCollapsed, 3);
    assert.equal(state.diagnostics?.counts.excludedByMaximumItems, 1);
    assert.equal(state.diagnostics?.counts.finalFreshItems, 2);
    assert.ok(
      state.diagnostics?.decisions.some(
        (decision) => decision.reason === 'duplicate_media_collapsed'
      )
    );
    assert.ok(
      state.diagnostics?.decisions.some(
        (decision) => decision.reason === 'maximum_items_excluded'
      )
    );
    const before = state.ordered(10);
    f.setRows([
      row(9, { timestamp: '2026-09-06T10:00:00Z' }),
      row(5, { title: 'Other Movie', timestamp: '2026-08-20T00:00:00Z' }),
      row(4, { timestamp: '2026-08-01T00:00:00Z' }),
      row(3, {
        type: 6,
        title: 'The Series',
        timestamp: '2026-08-10T00:00:00Z',
      }),
    ]);
    f.tick();
    await state.refresh();
    assert.deepEqual(state.ordered(10), before);
  });

  it('excludes old/future candidates and old/future release observations', async () => {
    const f = fixture(
      [
        movie(1, 'Old', 2025),
        { ...movie(2, 'Future'), release_date: '2026-10-01' },
        movie(3, 'Recent'),
      ],
      [{ ...tv(), first_air_date: '2025-01-01' }]
    );
    f.setRows([
      row(5, { title: 'Old', year: 2025 }),
      row(4, { title: 'Future' }),
      row(3, { title: 'Recent', timestamp: '2026-01-01T00:00:00Z' }),
      row(2, { title: 'Recent', timestamp: '2026-10-01T00:00:00Z' }),
      row(1, { title: 'The Series', type: 6 }),
    ]);
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    assert.deepEqual(state.ordered(), []);
  });

  it('omits ambiguous and unmatched titles without fuzzy guesses', async () => {
    const f = fixture([movie(1), movie(2)], [tv(1), tv(2)]);
    f.setRows([
      row(3),
      row(2, { type: 6, title: 'The Series' }),
      row(1, { title: 'The Movi' }),
    ]);
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    assert.deepEqual(state.ordered(), []);
  });

  it('keeps the legacy 90-day candidate defaults while paginating both media types', async () => {
    const f = fixture();
    assert.deepEqual(freshWindow(NOW), {
      start: '2026-06-08',
      end: '2026-09-06',
    });
    const seen: string[] = [];
    f.deps.tmdb.getDiscoverMovies = async (options = {}) => {
      assert.equal(options.primaryReleaseDateGte, freshWindow(NOW).start);
      assert.equal(options.primaryReleaseDateLte, '2026-09-06');
      seen.push(`movie:${options.page}`);
      return {
        page: options.page!,
        total_pages: 2,
        total_results: 2,
        results: [movie(options.page)],
      };
    };
    f.deps.tmdb.getDiscoverTv = async (options = {}) => {
      assert.equal(options.firstAirDateGte, freshWindow(NOW).start);
      assert.equal(options.firstAirDateLte, '2026-09-06');
      seen.push(`tv:${options.page}`);
      return {
        page: options.page!,
        total_pages: 2,
        total_results: 2,
        results: [tv(options.page)],
      };
    };
    await new FreshMediaState(config, f.deps).refresh();
    assert.deepEqual(seen, ['movie:1', 'movie:2', 'tv:1', 'tv:2']);
  });

  it('applies configured candidate constraints before intersecting releases', async () => {
    const f = fixture([movie(1, 'Included'), movie(2, 'Excluded')], []);
    f.setRows([row(2, { title: 'Included' }), row(1, { title: 'Excluded' })]);
    f.deps.tmdb.getDiscoverMovies = async (options = {}) => {
      assert.equal(options.genre, '18');
      return {
        page: options.page!,
        total_pages: 1,
        total_results: 1,
        results: [movie(1, 'Included')],
      };
    };
    const state = new FreshMediaState(
      {
        ...config,
        movieCriteria: { genre: '18' },
      },
      f.deps
    );
    await state.refresh();
    assert.deepEqual(
      state.ordered().map((item) => item.tmdbId),
      [1]
    );
  });

  it('retains the last good projection as stale and replaces it after recovery', async () => {
    const f = fixture();
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    assert.equal(state.has('movie', 1), true);
    f.tick();
    assert.equal(state.has('movie', 1), true);
    const good = f.deps.releasePage;
    f.deps.releasePage = async () => {
      throw new Error(
        'https://tracker.test?passkey=fixture-secret fixture-token'
      );
    };
    await state.refresh();
    assert.equal(state.status.status, 'stale');
    assert.equal(state.status.error, 'Fresh refresh failed.');
    assert.equal(state.has('movie', 1), true);
    assert.equal(state.diagnostics?.outcome, 'failed');
    assert.equal(state.diagnostics?.failureReason, 'fresh_refresh_failed');
    assert.equal(state.diagnostics?.projection.itemCount, 2);
    assert.doesNotMatch(
      JSON.stringify([state, state.status, state.ordered(), state.diagnostics]),
      /fixture|passkey|download_url|https/
    );
    f.deps.releasePage = good;
    f.setRows([]);
    f.tick();
    await state.refresh();
    assert.equal(state.status.status, 'ready');
    assert.deepEqual(state.ordered(), []);
    f.deps.tmdb.getDiscoverMovies = async () => {
      throw new Error('fixture-token');
    };
    f.tick();
    await state.refresh();
    assert.equal(state.status.status, 'stale');
  });

  it('shares concurrent refresh work, returns defensive copies, and performs no disabled-source calls', async () => {
    const f = fixture();
    const state = new FreshMediaState(config, f.deps);
    await Promise.all([state.refresh(), state.refresh(), state.refresh()]);
    assert.deepEqual(f.cursors, [0, 3]);
    const copy = state.ordered();
    copy[0].tmdbId = 999;
    assert.equal(state.has('movie', 999), false);
    const disabled = new FreshMediaState({ ...config, enabled: false }, f.deps);
    await disabled.refresh();
    assert.equal(disabled.status.status, 'disabled');
    assert.deepEqual(f.cursors, [0, 3]);
  });

  it('does not publish a partial scan when pagination stops progressing', async () => {
    const f = fixture();
    f.deps.releasePage = async () => ({
      releases: [release()],
      nextCursor: 2,
      filterObserved: true,
      counts: {
        inspected: 1,
        selectedFilter: 1,
        eligibleMovies: 1,
        eligibleTv: 0,
      },
    });
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    assert.equal(state.status.status, 'unavailable');
    assert.deepEqual(state.ordered(), []);
  });

  it('records truthful gate counts and representative safe decisions without changing ordering', async () => {
    const f = fixture(
      [movie(1, 'Accepted'), movie(2, 'Ambiguous'), movie(3, 'Ambiguous')],
      [tv(1, 'Series')]
    );
    f.setRows([
      row(7, { title: 'Accepted' }),
      row(6, { title: 'Accepted' }),
      row(5, { title: 'Series', type: 6 }),
      row(4, { title: 'Missing' }),
      row(3, { title: 'Accepted', year: 2025 }),
      row(2, { title: 'Ambiguous' }),
      row(1, { title: 'Accepted', timestamp: '2026-01-01T00:00:00Z' }),
    ]);
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    const before = state.ordered();
    const diagnostics = state.diagnostics!;
    assert.deepEqual(diagnostics.counts, {
      autobrrReleasesInspected: 7,
      selectedFilterReleases: 7,
      eligibleMovieReleases: 6,
      eligibleTvReleases: 1,
      movieCandidates: 3,
      tvCandidates: 1,
      successfulMediaMatches: 3,
      noCandidateMatch: 1,
      movieYearMismatch: 1,
      ambiguousMatch: 1,
      outsideCandidateWindow: 1,
      duplicateMediaCollapsed: 1,
      excludedByMaximumItems: 0,
      finalFreshItems: 2,
    });
    assert.deepEqual(
      new Set(diagnostics.decisions.map((decision) => decision.reason)),
      new Set([
        'media_match_accepted',
        'duplicate_media_collapsed',
        'no_candidate_match',
        'movie_year_mismatch',
        'ambiguous_candidate_match',
        'outside_candidate_window',
      ])
    );
    assert.ok(
      diagnostics.decisions.some(
        (decision) =>
          decision.reason === 'media_match_accepted' &&
          decision.matchedIdentity?.mediaType === 'movie' &&
          decision.matchedIdentity.tmdbId === 1
      )
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /download_url|action_status|filter_status|fixture-token|https:\/\//
    );
    diagnostics.counts.finalFreshItems = 999;
    diagnostics.decisions.length = 0;
    assert.equal(state.diagnostics?.counts.finalFreshItems, 2);
    assert.deepEqual(state.ordered(), before);
  });

  it('bounds diagnostic decisions with per-reason sampling', async () => {
    const f = fixture([], []);
    const rows = Array.from({ length: 150 }, (_, index) =>
      row(150 - index, { title: `Missing ${index}` })
    );
    f.deps.releasePage = async (filter, cursor) =>
      cursor
        ? parseReleasePage({ data: [], next_cursor: 0 }, filter, cursor)
        : parseReleasePage({ data: rows, next_cursor: 1 }, filter);
    const state = new FreshMediaState(config, f.deps);
    await state.refresh();
    assert.equal(state.diagnostics?.counts.noCandidateMatch, 150);
    assert.ok((state.diagnostics?.decisions.length ?? 0) <= 100);
    assert.equal(
      state.diagnostics?.decisions.filter(
        (decision) => decision.reason === 'no_candidate_match'
      ).length,
      10
    );
  });
});

describe('Fresh autobrr boundary', () => {
  it('returns only browser-safe filter identity and rejects duplicate or malformed IDs', () => {
    assert.deepEqual(
      parseFilters([
        { id: 7, name: 'Fresh Movies', enabled: true, actions: ['secret'] },
        { id: 8, name: 'Fresh TV', enabled: false, indexers: ['secret'] },
      ]),
      [
        { id: 7, name: 'Fresh Movies', enabled: true },
        { id: 8, name: 'Fresh TV', enabled: false },
      ]
    );
    assert.throws(() =>
      parseFilters([
        { id: 7, name: 'One' },
        { id: 7, name: 'Two' },
      ])
    );
    assert.throws(() => parseFilters([{ id: 0, name: 'Invalid' }]));
    assert.throws(() => parseFilters({ data: [] }));
  });

  it('allowlists selected approved movie/TV rows and discards all other fields', () => {
    const page = parseReleasePage(
      {
        data: [
          row(6),
          row(5, { action_status: [{ filter_id: 8 }] }),
          row(4, { type: 10 }),
          row(3, { filter_status: 'FILTER_REJECTED' }),
          row(2, { title: 'https://tracker.test?apikey=fixture-secret' }),
          row(1, { title: 'The Series', type: 11 }),
        ],
        next_cursor: 1,
      },
      config.filter
    );
    assert.equal(page.releases.length, 2);
    assert.deepEqual(page.counts, {
      inspected: 6,
      selectedFilter: 5,
      eligibleMovies: 1,
      eligibleTv: 1,
    });
    assert.deepEqual(Object.keys(page.releases[0]).sort(), [
      'mediaType',
      'observedAt',
      'title',
      'year',
    ]);
    assert.doesNotMatch(
      JSON.stringify(page),
      /download_url|info_url|passkey|fixture-secret|https/
    );
  });

  it('uses action filter ID even when the top-level name belongs to an earlier filter', () => {
    const data = {
      data: [
        row(1, {
          filter: 'Earlier',
          action_status: [{ filter_id: 7, client: 'secret' }],
        }),
      ],
      next_cursor: 1,
    };
    assert.equal(parseReleasePage(data, { id: 7 }).releases.length, 1);
    assert.equal(parseReleasePage(data, { id: 8 }).releases.length, 0);
  });

  it('rejects invalid cursors and skips malformed media fields without diagnostic payloads', () => {
    assert.throws(
      () => parseReleasePage({ data: [row(2)], next_cursor: 3 }, config.filter),
      /Invalid autobrr/
    );
    assert.throws(
      () =>
        parseReleasePage({ data: [row(2)], next_cursor: 2 }, config.filter, 2),
      /ordering/
    );
    assert.deepEqual(
      parseReleasePage(
        {
          data: [row(2, { timestamp: 'bad' }), row(1, { title: null })],
          next_cursor: 1,
        },
        config.filter
      ).releases,
      []
    );
  });

  it('sends header authentication, disables redirects, and sanitizes transport errors', async () => {
    class Client extends Autobrr {
      adapter(adapter: AxiosAdapter) {
        this.axios.defaults.adapter = adapter;
      }
    }
    const client = new Client('https://autobrr.test/subpath', 'fixture-token');
    client.adapter(async (request) => {
      assert.equal(request.baseURL, 'https://autobrr.test/subpath/api/');
      assert.equal(request.url, 'release');
      assert.equal(request.headers.get('X-API-Token'), 'fixture-token');
      assert.equal(request.maxRedirects, 0);
      assert.deepEqual(request.params, { limit: 100, cursor: 5 });
      return {
        data: { data: [row(1)], next_cursor: 1 },
        status: 200,
        statusText: 'OK',
        headers: {},
        config: request,
      };
    });
    assert.equal((await client.page(config.filter, 5)).releases.length, 1);
    client.adapter(async (request) => {
      assert.equal(request.url, 'filters');
      assert.equal(request.headers.get('X-API-Token'), 'fixture-token');
      assert.equal(request.maxRedirects, 0);
      return {
        data: [{ id: 7, name: 'Fresh', enabled: true, rules: ['discarded'] }],
        status: 200,
        statusText: 'OK',
        headers: {},
        config: request,
      };
    });
    assert.deepEqual(await client.filters(), [
      { id: 7, name: 'Fresh', enabled: true },
    ]);
    client.adapter(async () => {
      throw { message: 'fixture-token', response: row(1) };
    });
    await assert.rejects(client.page(config.filter), (error: Error) => {
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack!, /fixture|passkey|download_url/);
      return true;
    });
    assert.throws(
      () =>
        new Client('https://user:fixture-secret@autobrr.test', 'fixture-token'),
      /Invalid Fresh connection/
    );
  });
});
