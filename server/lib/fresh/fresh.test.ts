import type {
  AutobrrFilterOption,
  FreshRelease,
  FreshReleasePage,
} from '@server/api/autobrr';
import type {
  TmdbMovieDetails,
  TmdbMovieResult,
  TmdbTvDetails,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import {
  FRESH_SYNC_STATE_ID,
  FreshCandidateStatus,
  FreshContinuityStatus,
} from '@server/constants/fresh';
import dataSource from '@server/datasource';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshMedia from '@server/entity/FreshMedia';
import FreshObservation from '@server/entity/FreshObservation';
import { FreshSyncState } from '@server/entity/FreshSyncState';
import { FreshEngine } from '@server/lib/fresh/engine';
import type { FreshSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

const settings: FreshSettings = {
  enabled: true,
  baseUrl: 'https://autobrr.test',
  apiToken: 'fixture-token',
  filterId: 7,
  cachedFilterName: 'Fresh',
  mediaEligibilityDays: 90,
  freshVisibilityDays: 7,
  includeGenreIds: [],
  excludeGenreIds: [],
  includeOriginalLanguages: [],
  excludeOriginalLanguages: [],
  includeContentRatings: [],
  excludeContentRatings: [],
  minimumTmdbScore: 0,
  minimumTmdbVotes: 0,
};
const now = new Date('2026-09-26T12:00:00.000Z');

const movie = (id: number, title: string, date: string): TmdbMovieResult => ({
  id,
  media_type: 'movie',
  adult: false,
  genre_ids: [18],
  original_language: 'en',
  original_title: title,
  overview: 'Overview',
  popularity: 10,
  release_date: date,
  title,
  video: false,
  vote_average: 8,
  vote_count: 100,
});
const tv = (id: number, name: string, date: string): TmdbTvResult => ({
  id,
  media_type: 'tv',
  first_air_date: date,
  genre_ids: [18],
  name,
  origin_country: ['US'],
  original_language: 'en',
  original_name: name,
  overview: 'Overview',
  popularity: 10,
  vote_average: 7,
  vote_count: 50,
});

const release = (
  releaseId: number,
  mediaType: 'movie' | 'tv',
  title: string,
  year: number,
  observedAt: string,
  availabilityType: FreshRelease['availabilityType'] = 'unknown'
): FreshRelease => ({
  releaseId: String(releaseId),
  mediaType,
  title,
  year,
  observedAt: Date.parse(observedAt),
  availabilityType,
});

const page = (all: FreshRelease[], cursor: number): FreshReleasePage => {
  const rows = cursor
    ? all.filter((item) => Number(item.releaseId) < cursor)
    : all;
  return {
    releases: rows,
    releaseIds: rows.map((item) => item.releaseId),
    newestReleaseId: rows[0]?.releaseId,
    oldestReleaseId: rows.at(-1)?.releaseId,
    nextCursor: 0,
    filterObserved: true,
    counts: {
      inspected: rows.length,
      selectedFilter: rows.length,
      eligibleMovies: rows.filter((item) => item.mediaType === 'movie').length,
      eligibleTv: rows.filter((item) => item.mediaType === 'tv').length,
    },
  };
};

describe('persistent Fresh engine', () => {
  let releases: FreshRelease[] = [];
  const filters: AutobrrFilterOption[] = [
    { id: 7, name: 'Fresh', enabled: true },
  ];
  let movieSearches = 0;
  let tvSearches = 0;

  before(async () => {
    if (!dataSource.isInitialized) await dataSource.initialize();
    await dataSource.synchronize(true);
  });

  after(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  const engine = () =>
    new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async ({ movieId }) =>
          movie(
            movieId,
            movieId === 102 ? 'Old Movie' : 'Movie A',
            movieId === 102 ? '2020-01-01' : '2026-09-10'
          ) as unknown as TmdbMovieDetails,
        getTvShow: async ({ tvId }) =>
          tv(tvId, 'Show A', '2026-09-12') as unknown as TmdbTvDetails,
        searchMoviesStrict: async ({ query, page = 1 }) => {
          movieSearches++;
          const result =
            query === 'Movie A'
              ? [movie(101, 'Movie A', '2026-09-10')]
              : query === 'Movie Alias'
                ? [movie(101, 'Movie Alias', '2026-09-10')]
                : query === 'Old Movie'
                  ? [movie(102, 'Old Movie', '2020-01-01')]
                  : [];
          return {
            page,
            total_pages: 1,
            total_results: result.length,
            results: result,
          };
        },
        searchTvShowsStrict: async ({ query, page = 1 }) => {
          tvSearches++;
          const result =
            query === 'Show A' ? [tv(201, 'Show A', '2026-09-12')] : [];
          return {
            page,
            total_pages: 1,
            total_results: result.length,
            results: result,
          };
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });

  it('persists an initial source boundary, collapses releases, and survives restart', async () => {
    releases = [
      release(12, 'movie', 'Movie A', 2026, '2026-09-25T12:00:00Z'),
      release(11, 'movie', 'Movie A', 2026, '2026-09-24T12:00:00Z'),
      release(10, 'tv', 'Show A', 0, '2026-09-23T12:00:00Z'),
    ];
    movieSearches = 0;
    tvSearches = 0;
    const result = await engine().run(settings);
    assert.equal(result.diagnostics.outcome, 'succeeded');
    assert.equal(result.diagnostics.checkpoint.after, '12');
    assert.equal(await dataSource.getRepository(FreshObservation).count(), 3);
    assert.equal(await dataSource.getRepository(FreshCandidate).count(), 2);
    assert.equal(await dataSource.getRepository(FreshMedia).count(), 2);
    assert.equal(
      await dataSource.getRepository(FreshMedia).countBy({ active: true }),
      2
    );
    assert.equal(movieSearches, 1);
    assert.equal(tvSearches, 1);
    assert.equal(
      (
        await dataSource
          .getRepository(FreshMedia)
          .findOneByOrFail({ tmdbId: 101 })
      ).firstSeenAt.toISOString(),
      '2026-09-24T12:00:00.000Z'
    );

    const restarted = engine();
    const replay = await restarted.run(settings);
    assert.equal(replay.diagnostics.outcome, 'succeeded');
    assert.equal(replay.diagnostics.counts.persistedObservations, 0);
    assert.equal(await dataSource.getRepository(FreshObservation).count(), 3);
    assert.equal(movieSearches, 1);
    assert.equal(tvSearches, 1);
  });

  it('reads only a real delta and advances after durable evidence exists', async () => {
    releases = [
      release(14, 'movie', 'Old Movie', 2020, '2026-09-26T10:00:00Z'),
      release(13, 'movie', 'Movie A', 2026, '2026-09-26T09:00:00Z', 'physical'),
      ...releases,
    ];
    const result = await engine().run(settings);
    assert.equal(result.diagnostics.outcome, 'succeeded');
    assert.equal(result.diagnostics.checkpoint.before, '12');
    assert.equal(result.diagnostics.checkpoint.after, '14');
    assert.equal(result.diagnostics.counts.persistedObservations, 2);
    assert.equal(await dataSource.getRepository(FreshObservation).count(), 5);
    assert.equal(
      (
        await dataSource
          .getRepository(FreshObservation)
          .findOneByOrFail({ releaseId: '13' })
      ).availabilityType,
      'physical'
    );
    const old = await dataSource
      .getRepository(FreshMedia)
      .findOneByOrFail({ tmdbId: 102 });
    assert.equal(old.active, false);
    assert.equal(
      (
        await dataSource
          .getRepository(FreshMedia)
          .findOneByOrFail({ tmdbId: 101 })
      ).firstSeenAt.toISOString(),
      '2026-09-24T12:00:00.000Z'
    );
  });

  it('converges source-title aliases without moving first-seen time later', async () => {
    releases = [
      release(15, 'movie', 'Movie Alias', 2026, '2026-09-20T10:00:00Z'),
      ...releases,
    ];
    const result = await engine().run(settings);
    assert.equal(result.diagnostics.outcome, 'succeeded');
    assert.equal(result.diagnostics.checkpoint.after, '15');
    assert.equal(await dataSource.getRepository(FreshMedia).count(), 3);
    const canonical = await dataSource
      .getRepository(FreshMedia)
      .findOneByOrFail({ mediaType: 'movie', tmdbId: 101 });
    assert.equal(
      canonical.firstSeenAt.toISOString(),
      '2026-09-20T10:00:00.000Z'
    );
    assert.equal(
      canonical.lastSeenAt.toISOString(),
      '2026-09-26T09:00:00.000Z'
    );
  });

  it('preserves last-good media and enters a gap state when the checkpoint disappears', async () => {
    releases = [release(20, 'movie', 'Movie A', 2026, '2026-09-26T11:00:00Z')];
    const result = await engine().run(settings);
    assert.equal(result.diagnostics.outcome, 'failed');
    assert.equal(result.diagnostics.failureReason, 'checkpoint_missing');
    assert.equal(
      (
        await dataSource
          .getRepository(FreshSyncState)
          .findOneByOrFail({ id: FRESH_SYNC_STATE_ID })
      ).continuityStatus,
      FreshContinuityStatus.GAP_PRESERVED
    );
    assert.ok(
      (await dataSource.getRepository(FreshMedia).countBy({ active: true })) > 0
    );

    const activeBefore = await dataSource
      .getRepository(FreshMedia)
      .countBy({ active: true });
    const reconciliation = await engine().run(settings, true);
    assert.equal(reconciliation.diagnostics.outcome, 'succeeded');
    assert.equal(reconciliation.diagnostics.checkpoint.after, '20');
    assert.equal(
      (
        await dataSource
          .getRepository(FreshSyncState)
          .findOneByOrFail({ id: FRESH_SYNC_STATE_ID })
      ).continuityStatus,
      FreshContinuityStatus.GAP_PRESERVED
    );
    assert.ok(
      (await dataSource.getRepository(FreshMedia).countBy({ active: true })) >=
        activeBefore
    );
  });

  it('never advances the checkpoint when cancellation follows durable ingestion', async () => {
    releases = [
      release(21, 'movie', 'Movie A', 2026, '2026-09-26T11:30:00Z'),
      ...releases,
    ];
    let cancelled = false;
    const cancelling = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => {
          const result = page(releases, cursor);
          cancelled = true;
          return result;
        },
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('must not run');
        },
        getTvShow: async () => {
          throw new Error('must not run');
        },
        searchMoviesStrict: async () => {
          throw new Error('must not run');
        },
        searchTvShowsStrict: async () => {
          throw new Error('must not run');
        },
      },
      now: () => new Date(now),
      cancelled: () => cancelled,
    });
    const before = await dataSource
      .getRepository(FreshSyncState)
      .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
    const result = await cancelling.run(settings);
    const after = await dataSource
      .getRepository(FreshSyncState)
      .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
    assert.equal(result.diagnostics.outcome, 'cancelled');
    assert.equal(result.diagnostics.failureReason, 'cancelled');
    assert.equal(after.checkpointReleaseId, before.checkpointReleaseId);
    assert.equal(
      await dataSource.getRepository(FreshObservation).existsBy({
        sourceGeneration: before.generation,
        releaseId: '21',
      }),
      true
    );
  });

  it('refuses a source ID regression without destroying last-good media', async () => {
    releases = [release(19, 'movie', 'Movie A', 2026, '2026-09-26T11:00:00Z')];
    const activeBefore = await dataSource
      .getRepository(FreshMedia)
      .countBy({ active: true });
    const result = await engine().run(settings);
    assert.equal(result.diagnostics.outcome, 'failed');
    assert.equal(result.diagnostics.failureReason, 'source_id_regression');
    assert.equal(
      await dataSource.getRepository(FreshMedia).countBy({ active: true }),
      activeBefore
    );
  });

  it('isolates a changed source generation while preserving the old projection on failure', async () => {
    const activeBefore = await dataSource
      .getRepository(FreshMedia)
      .countBy({ active: true });
    const before = await dataSource
      .getRepository(FreshSyncState)
      .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
    const changed = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => [{ id: 8, name: 'Replacement', enabled: true }],
        page: async () => {
          throw new Error('private provider failure');
        },
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('must not run');
        },
        getTvShow: async () => {
          throw new Error('must not run');
        },
        searchMoviesStrict: async () => {
          throw new Error('must not run');
        },
        searchTvShowsStrict: async () => {
          throw new Error('must not run');
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });
    const result = await changed.run({
      ...settings,
      filterId: 8,
      cachedFilterName: 'Replacement',
    });
    const after = await dataSource
      .getRepository(FreshSyncState)
      .findOneByOrFail({ id: FRESH_SYNC_STATE_ID });
    assert.equal(result.diagnostics.outcome, 'failed');
    assert.equal(result.diagnostics.failureReason, 'source_unavailable');
    assert.equal(after.generation, before.generation + 1);
    assert.equal(after.checkpointReleaseId, null);
    assert.equal(
      await dataSource.getRepository(FreshMedia).countBy({ active: true }),
      activeBefore
    );
  });

  it('advances durable source evidence while keeping provider failures retryable', async () => {
    await dataSource.synchronize(true);
    releases = [release(1, 'movie', 'Movie A', 2026, '2026-09-26T11:00:00Z')];
    const unavailable = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('must not run');
        },
        getTvShow: async () => {
          throw new Error('must not run');
        },
        searchMoviesStrict: async () => {
          throw Object.assign(new Error('raw provider response'), {
            response: { status: 429 },
          });
        },
        searchTvShowsStrict: async () => {
          throw new Error('must not run');
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });
    const result = await unavailable.run(settings);
    assert.equal(result.diagnostics.outcome, 'succeeded');
    assert.equal(result.diagnostics.checkpoint.after, '1');
    assert.equal(result.diagnostics.counts.transientFailures, 1);
    assert.equal(result.diagnostics.counts.noMatch, 0);
    assert.equal(
      result.diagnostics.decisions.at(-1)?.reason,
      'tmdb_rate_limited'
    );
    const candidate = await dataSource
      .getRepository(FreshCandidate)
      .findOneByOrFail({ normalizedTitle: 'movie a' });
    assert.equal(candidate.status, FreshCandidateStatus.TRANSIENT_FAILURE);
    assert.equal(candidate.lastFailureReason, 'tmdb_rate_limited');
    assert.ok(candidate.nextAttemptAt && candidate.nextAttemptAt > now);
    assert.doesNotMatch(JSON.stringify(result), /raw provider response/);
  });

  it('refreshes stale current-generation metadata non-destructively during reconciliation', async () => {
    const repository = dataSource.getRepository(FreshMedia);
    const firstSeenAt = new Date('2026-09-20T00:00:00Z');
    const staleAt = new Date('2026-09-01T00:00:00Z');
    await repository.save([
      new FreshMedia({
        mediaType: 'movie',
        tmdbId: 301,
        active: false,
        admitted: true,
        lastMatchedGeneration: 1,
        firstSeenAt,
        lastSeenAt: firstSeenAt,
        resolvedAt: firstSeenAt,
        metadataRefreshedAt: staleAt,
        displayTitle: 'Old Snapshot',
        sortTitle: 'old snapshot',
        originalTitle: 'Old Snapshot',
        mediaDate: '2026-09-01',
      }),
      new FreshMedia({
        mediaType: 'movie',
        tmdbId: 302,
        active: true,
        admitted: true,
        lastMatchedGeneration: 1,
        firstSeenAt,
        lastSeenAt: firstSeenAt,
        resolvedAt: firstSeenAt,
        metadataRefreshedAt: staleAt,
        displayTitle: 'Last Good Snapshot',
        sortTitle: 'last good snapshot',
        originalTitle: 'Last Good Snapshot',
        mediaDate: '2026-09-01',
      }),
    ]);
    const reconciliation = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async ({ movieId }) => {
          if (movieId === 302) throw new Error('raw provider failure');
          return {
            ...movie(movieId, 'Updated Snapshot', '2026-09-15'),
            genres: [{ id: 18, name: 'Drama' }],
          } as unknown as TmdbMovieDetails;
        },
        getTvShow: async () => {
          throw new Error('must not run');
        },
        searchMoviesStrict: async () => {
          throw new Error('must not run');
        },
        searchTvShowsStrict: async () => {
          throw new Error('must not run');
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });
    const result = await reconciliation.run(settings, true);
    assert.equal(result.diagnostics.outcome, 'succeeded');
    const updated = await repository.findOneByOrFail({ tmdbId: 301 });
    const preserved = await repository.findOneByOrFail({ tmdbId: 302 });
    assert.equal(updated.displayTitle, 'Updated Snapshot');
    assert.equal(updated.active, true);
    assert.equal(updated.firstSeenAt.toISOString(), firstSeenAt.toISOString());
    assert.equal(updated.metadataRefreshedAt.toISOString(), now.toISOString());
    assert.equal(preserved.displayTitle, 'Last Good Snapshot');
    assert.equal(
      preserved.metadataRefreshedAt.toISOString(),
      staleAt.toISOString()
    );
  });

  it('publishes resolved first-run media while the bounded resolver backlog remains', async () => {
    await dataSource.synchronize(true);
    const firstRunReleases = Array.from({ length: 101 }, (_, index) =>
      release(
        1000 - index,
        'movie',
        `Initial Movie ${index}`,
        2026,
        '2026-09-25T12:00:00Z'
      )
    );
    const firstRun = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(firstRunReleases, cursor),
      }),
      tmdb: {
        getMovie: async ({ movieId }) =>
          ({
            ...movie(movieId, `Initial Movie ${movieId - 10000}`, '2026-09-10'),
            genres: [{ id: 18, name: 'Drama' }],
            release_dates: { results: [] },
          }) as unknown as TmdbMovieDetails,
        getTvShow: async () => {
          throw new Error('must not run');
        },
        searchMoviesStrict: async ({ query, page = 1 }) => {
          const index = Number(query.replace('Initial Movie ', ''));
          const result = movie(10000 + index, query, '2026-09-10');
          return {
            page,
            total_pages: 1,
            total_results: 1,
            results: [result],
          };
        },
        searchTvShowsStrict: async () => {
          throw new Error('must not run');
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });

    const result = await firstRun.run(settings);
    assert.equal(result.diagnostics.outcome, 'succeeded');
    assert.equal(result.diagnostics.counts.resolutionAttempts, 100);
    assert.equal(
      await dataSource.getRepository(FreshMedia).countBy({ active: true }),
      100
    );
    assert.equal(
      await dataSource.getRepository(FreshCandidate).countBy({
        status: FreshCandidateStatus.UNRESOLVED,
      }),
      1
    );
  });

  it('fails closed when the configured numeric filter cannot be proven', async () => {
    const bad = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => [{ id: 8, name: 'Other', enabled: true }],
        page: async () => page([], 0),
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('must not run');
        },
        getTvShow: async () => {
          throw new Error('must not run');
        },
        searchMoviesStrict: async () => {
          throw new Error('must not run');
        },
        searchTvShowsStrict: async () => {
          throw new Error('must not run');
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });
    const result = await bad.run(settings);
    assert.equal(result.diagnostics.outcome, 'failed');
    assert.equal(result.diagnostics.failureReason, 'filter_missing');
    assert.equal(result.diagnostics.stages.source_history, 'not_started');
  });

  it('repairs legacy eligibility without treating unknown movie source evidence as outside', async () => {
    await dataSource.synchronize(true);
    await dataSource.getRepository(FreshSyncState).save(
      new FreshSyncState({
        generation: 1,
        filterId: 7,
        continuityStatus: FreshContinuityStatus.CURRENT,
        eligibilitySchemaVersion: 0,
      })
    );
    const mediaRepository = dataSource.getRepository(FreshMedia);
    const candidateRepository = dataSource.getRepository(FreshCandidate);
    const observationRepository = dataSource.getRepository(FreshObservation);
    const observedAt = new Date('2026-09-25T00:00:00Z');
    const legacyMovie = await mediaRepository.save(
      new FreshMedia({
        mediaType: 'movie',
        tmdbId: 7001,
        admitted: false,
        lastMatchedGeneration: 1,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        resolvedAt: observedAt,
        metadataRefreshedAt: observedAt,
        displayTitle: 'Legacy Movie',
        sortTitle: 'legacy movie',
        originalTitle: 'Legacy Movie',
        mediaDate: '2025-01-01',
      })
    );
    const recentTv = await mediaRepository.save(
      new FreshMedia({
        mediaType: 'tv',
        tmdbId: 7002,
        admitted: false,
        lastMatchedGeneration: 1,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        resolvedAt: observedAt,
        metadataRefreshedAt: observedAt,
        displayTitle: 'Recent Series',
        sortTitle: 'recent series',
        originalTitle: 'Recent Series',
        mediaDate: '2026-09-20',
      })
    );
    for (const [index, media] of [legacyMovie, recentTv].entries()) {
      const candidate = await candidateRepository.save(
        new FreshCandidate({
          sourceGeneration: 1,
          mediaType: media.mediaType,
          normalizedTitle: media.sortTitle,
          displayTitle: media.displayTitle,
          matchYear: media.mediaType === 'movie' ? 2025 : 0,
          status: FreshCandidateStatus.OUTSIDE_WINDOW,
          tmdbId: media.tmdbId,
          freshMediaId: media.id,
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
        })
      );
      await observationRepository.save(
        new FreshObservation({
          sourceGeneration: 1,
          releaseId: String(3000 + index),
          filterId: 7,
          candidateId: candidate.id,
          mediaType: media.mediaType,
          title: media.displayTitle,
          normalizedTitle: media.sortTitle,
          year: media.mediaType === 'movie' ? 2025 : 0,
          availabilityType: 'unknown',
          observedAt,
        })
      );
    }

    await engine().reevaluate(settings);
    const repairedMovie = await mediaRepository.findOneByOrFail({
      id: legacyMovie.id,
    });
    const repairedTv = await mediaRepository.findOneByOrFail({
      id: recentTv.id,
    });
    assert.equal(repairedMovie.admitted, false);
    assert.equal(repairedMovie.membershipReason, 'eligibility_unknown');
    assert.equal(repairedTv.admitted, true);
    assert.equal(repairedTv.membershipReason, 'active_fresh');
    assert.equal(
      await candidateRepository.countBy({
        status: FreshCandidateStatus.OUTSIDE_WINDOW,
      }),
      0
    );
    assert.equal(
      (
        await dataSource
          .getRepository(FreshSyncState)
          .findOneByOrFail({ id: FRESH_SYNC_STATE_ID })
      ).eligibilitySchemaVersion,
      1
    );
  });

  it('manually resolves only actionable candidates through normal media state', async () => {
    await dataSource.synchronize(true);
    await dataSource.getRepository(FreshSyncState).save(
      new FreshSyncState({
        generation: 1,
        sourceFingerprint: 'fixture',
        filterId: 7,
        continuityStatus: FreshContinuityStatus.CURRENT,
      })
    );
    const candidate = await dataSource.getRepository(FreshCandidate).save(
      new FreshCandidate({
        sourceGeneration: 1,
        mediaType: 'movie',
        normalizedTitle: 'manual movie',
        displayTitle: 'Manual Movie',
        matchYear: 2026,
        status: FreshCandidateStatus.NO_MATCH,
        firstObservedAt: new Date('2026-09-25T00:00:00Z'),
        lastObservedAt: new Date('2026-09-25T00:00:00Z'),
      })
    );
    await dataSource.getRepository(FreshObservation).save(
      new FreshObservation({
        sourceGeneration: 1,
        releaseId: '2000',
        filterId: 7,
        candidateId: candidate.id,
        mediaType: 'movie',
        title: 'Manual Movie',
        normalizedTitle: 'manual movie',
        year: 2026,
        observedAt: new Date('2026-09-25T00:00:00Z'),
      })
    );
    const manual = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async () => page([], 0),
      }),
      tmdb: {
        searchMoviesStrict: async () => {
          throw new Error('title search must not run');
        },
        searchTvShowsStrict: async () => {
          throw new Error('title search must not run');
        },
        getMovie: async ({ movieId }) =>
          ({
            ...movie(movieId, 'Canonical Manual Movie', '2026-09-20'),
            genres: [{ id: 18, name: 'Drama' }],
            release_dates: { results: [] },
          }) as unknown as TmdbMovieDetails,
        getTvShow: async () => {
          throw new Error('wrong media endpoint');
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });
    const resolved = await manual.resolveManually(candidate.id, 9001, settings);
    assert.equal(resolved.candidate.status, FreshCandidateStatus.RESOLVED);
    assert.equal(resolved.candidate.tmdbId, 9001);
    assert.equal(resolved.media.displayTitle, 'Canonical Manual Movie');
    assert.equal(resolved.media.admitted, true);
    assert.equal(resolved.media.active, true);
    await assert.rejects(() =>
      manual.resolveManually(candidate.id, 9002, settings)
    );
  });
});
