import type {
  AutobrrFilterOption,
  FreshRelease,
  FreshReleasePage,
} from '@server/api/autobrr';
import type {
  TmdbMovieDetails,
  TmdbMovieResult,
  TmdbSeasonWithEpisodes,
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
import FreshCandidateVisibility from '@server/entity/FreshCandidateVisibility';
import FreshDiscoveryHistory from '@server/entity/FreshDiscoveryHistory';
import FreshManualResolution from '@server/entity/FreshManualResolution';
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
  sourceTitle: title,
  year,
  seasonNumber: -1,
  episodeNumber: -1,
  explicitSeason: false,
  explicitSpecial: false,
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
    assert.equal(
      await dataSource.getRepository(FreshCandidateVisibility).countBy({
        show: true,
      }),
      2
    );
    assert.equal(await dataSource.getRepository(FreshMedia).count(), 2);
    assert.equal(
      await dataSource.getRepository(FreshMedia).countBy({ active: true }),
      1
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

    const movieCandidate = await dataSource
      .getRepository(FreshCandidate)
      .findOneByOrFail({ normalizedTitle: 'movie a' });
    const visibilityRepository = dataSource.getRepository(
      FreshCandidateVisibility
    );
    const hidden = await visibilityRepository.findOneByOrFail({
      sourceEvidenceKey: movieCandidate.sourceEvidenceKey,
    });
    hidden.show = false;
    await visibilityRepository.save(hidden);

    const restarted = engine();
    const replay = await restarted.run(settings);
    assert.equal(replay.diagnostics.outcome, 'succeeded');
    assert.equal(replay.diagnostics.counts.persistedObservations, 0);
    await restarted.reevaluate(settings);
    assert.equal(await dataSource.getRepository(FreshObservation).count(), 3);
    assert.equal(movieSearches, 1);
    assert.equal(tvSearches, 1);
    assert.equal(
      (
        await visibilityRepository.findOneByOrFail({
          sourceEvidenceKey: movieCandidate.sourceEvidenceKey,
        })
      ).show,
      false
    );
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
      '2026-09-24T12:00:00.000Z'
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
    assert.equal(repairedTv.admitted, false);
    assert.equal(repairedTv.membershipReason, 'source_generation_inactive');
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
        automaticStatus: FreshCandidateStatus.NO_MATCH,
        automaticFailureReason: 'no_exact_match',
        sourceEvidenceKey: 'manual-visibility-key',
        firstObservedAt: new Date('2026-09-25T00:00:00Z'),
        lastObservedAt: new Date('2026-09-25T00:00:00Z'),
      })
    );
    await dataSource.getRepository(FreshCandidateVisibility).save(
      new FreshCandidateVisibility({
        mediaType: candidate.mediaType,
        sourceEvidenceKey: candidate.sourceEvidenceKey,
        show: false,
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
    const resolved = await manual.resolveManually(
      candidate.id,
      'movie',
      9001,
      candidate.revision,
      undefined,
      settings
    );
    assert.equal(resolved.candidate.status, FreshCandidateStatus.RESOLVED);
    assert.equal(resolved.candidate.tmdbId, 9001);
    assert.equal(resolved.media.displayTitle, 'Canonical Manual Movie');
    assert.equal(resolved.media.admitted, true);
    assert.equal(resolved.media.active, true);
    await assert.rejects(() =>
      manual.resolveManually(
        candidate.id,
        'movie',
        9002,
        candidate.revision,
        undefined,
        settings
      )
    );
    const reset = await manual.resetManualResolution(
      candidate.id,
      resolved.candidate.revision,
      settings
    );
    assert.equal(reset.status, FreshCandidateStatus.NO_MATCH);
    assert.equal(reset.effectiveMediaType, 'movie');
    assert.equal(reset.tmdbId, null);
    assert.equal(
      (
        await dataSource
          .getRepository(FreshMedia)
          .findOneByOrFail({ id: resolved.media.id })
      ).active,
      false
    );
    assert.equal(
      (
        await dataSource
          .getRepository(FreshCandidateVisibility)
          .findOneByOrFail({ sourceEvidenceKey: candidate.sourceEvidenceKey })
      ).show,
      false
    );
    assert.equal(
      (
        await dataSource
          .getRepository(FreshManualResolution)
          .findOneByOrFail({ sourceEvidenceKey: reset.sourceEvidenceKey })
      ).active,
      false
    );
  });

  it('uses retained TV year evidence for Youth and Apocalypse without rank guessing', async () => {
    await dataSource.synchronize(true);
    releases = [
      {
        ...release(4002, 'tv', 'Apocalypse', 2026, '2026-09-25T00:00:00Z'),
        seasonNumber: 1,
        explicitSeason: true,
      },
      {
        ...release(4001, 'tv', 'Youth', 2026, '2026-09-24T00:00:00Z'),
        seasonNumber: 1,
        explicitSeason: true,
      },
    ];
    const queries: { query: string; year?: number; page?: number }[] = [];
    const resolver = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('wrong namespace');
        },
        getTvShow: async ({ tvId }) =>
          tv(
            tvId,
            tvId === 285418 ? 'Youth' : 'Apocalypse',
            '2026-01-01'
          ) as unknown as TmdbTvDetails,
        searchMoviesStrict: async () => {
          throw new Error('wrong namespace');
        },
        searchTvShowsStrict: async ({ query, year, page = 1 }) => {
          queries.push({ query, year, page });
          const result =
            query === 'Youth' && year === 2026
              ? [tv(285418, 'Youth', '2026-01-01')]
              : query === 'Apocalypse' && year === 2026
                ? [tv(315479, 'Apocalypse', '2026-01-02')]
                : query === 'Youth'
                  ? [
                      tv(1, 'Youth', '2013-01-01'),
                      tv(285418, 'Youth', '2026-01-01'),
                    ]
                  : [];
          return {
            page,
            total_pages: query === 'Apocalypse' && !year ? 4 : 1,
            total_results: result.length,
            results: result,
          };
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });
    await resolver.run(settings, true);
    const candidates = await dataSource.getRepository(FreshCandidate).find({
      order: { displayTitle: 'ASC' },
    });
    assert.deepEqual(
      candidates.map((candidate) => [
        candidate.displayTitle,
        candidate.matchYear,
        candidate.tmdbId,
      ]),
      [
        ['Apocalypse', 2026, 315479],
        ['Youth', 2026, 285418],
      ]
    );
    for (const title of ['Apocalypse', 'Youth']) {
      const titleQueries = queries.filter(({ query }) => query === title);
      assert.equal(titleQueries[0].year, undefined);
      assert.equal(titleQueries.at(-1)?.year, 2026);
    }
    assert.deepEqual(
      queries
        .filter(({ query, year }) => query === 'Apocalypse' && !year)
        .map(({ page }) => page),
      [1, 2, 3]
    );
  });

  it('uses only the anchored terminal Volume N fallback for TV', async () => {
    await dataSource.synchronize(true);
    releases = [
      release(5002, 'movie', 'Movie Volume 4', 2026, '2026-09-25T00:00:00Z'),
      release(5001, 'tv', 'Chopped Volume 4', 0, '2026-09-24T00:00:00Z'),
    ];
    const queries: { namespace: 'movie' | 'tv'; query: string }[] = [];
    const resolver = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('movie must remain unresolved');
        },
        getTvShow: async ({ tvId }) =>
          tv(tvId, 'Chopped', '2009-01-13') as unknown as TmdbTvDetails,
        searchMoviesStrict: async ({ query, page = 1 }) => {
          queries.push({ namespace: 'movie', query });
          return { page, total_pages: 1, total_results: 0, results: [] };
        },
        searchTvShowsStrict: async ({ query, page = 1 }) => {
          queries.push({ namespace: 'tv', query });
          const results =
            query === 'Chopped' ? [tv(17404, 'Chopped', '2009-01-13')] : [];
          return {
            page,
            total_pages: 1,
            total_results: results.length,
            results,
          };
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });
    await resolver.run(settings, true);
    const chopped = await dataSource
      .getRepository(FreshCandidate)
      .findOneByOrFail({
        displayTitle: 'Chopped Volume 4',
      });
    const movieVolume = await dataSource
      .getRepository(FreshCandidate)
      .findOneByOrFail({ displayTitle: 'Movie Volume 4' });
    assert.equal(chopped.tmdbId, 17404);
    assert.equal(movieVolume.status, FreshCandidateStatus.NO_MATCH);
    assert.deepEqual(
      queries.sort((left, right) => left.query.localeCompare(right.query)),
      [
        { namespace: 'tv', query: 'Chopped' },
        { namespace: 'tv', query: 'Chopped Volume 4' },
        { namespace: 'movie', query: 'Movie Volume 4' },
      ]
    );
  });

  it('keeps FIA parsed Movie evidence while allowing typed TV manual correction', async () => {
    await dataSource.synchronize(true);
    releases = [
      release(
        6001,
        'movie',
        'FIA WEC 2026 6 Hours Of Fuji',
        2026,
        '2026-09-25T00:00:00Z'
      ),
    ];
    const resolver = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('wrong namespace');
        },
        getTvShow: async ({ tvId }) =>
          tv(tvId, 'FIA WEC', '2012-01-01') as unknown as TmdbTvDetails,
        searchMoviesStrict: async ({ page = 1 }) => ({
          page,
          total_pages: 1,
          total_results: 0,
          results: [],
        }),
        searchTvShowsStrict: async () => {
          throw new Error('automatic cross-type lookup is forbidden');
        },
      },
      now: () => new Date(now),
      cancelled: () => false,
    });
    await resolver.run(settings, true);
    const parsed = await dataSource
      .getRepository(FreshCandidate)
      .findOneByOrFail({
        displayTitle: 'FIA WEC 2026 6 Hours Of Fuji',
      });
    assert.equal(parsed.mediaType, 'movie');
    assert.equal(parsed.status, FreshCandidateStatus.NO_MATCH);
    const corrected = await resolver.resolveManually(
      parsed.id,
      'tv',
      305251,
      parsed.revision,
      42,
      settings
    );
    assert.equal(corrected.candidate.mediaType, 'movie');
    assert.equal(corrected.candidate.effectiveMediaType, 'tv');
    assert.equal(corrected.candidate.tmdbId, 305251);
    assert.equal(corrected.media.mediaType, 'tv');
    assert.equal(corrected.media.displayTitle, 'FIA WEC');
    assert.equal(
      await dataSource.getRepository(FreshMedia).countBy({
        mediaType: 'movie',
        tmdbId: 305251,
      }),
      0
    );

    await resolver.run(
      { ...settings, baseUrl: 'https://autobrr-generation-2.test' },
      false
    );
    const reapplied = await dataSource
      .getRepository(FreshCandidate)
      .findOneOrFail({
        where: { sourceGeneration: 2 },
      });
    assert.equal(reapplied.mediaType, 'movie');
    assert.equal(reapplied.effectiveMediaType, 'tv');
    assert.equal(reapplied.tmdbId, 305251);
    assert.equal(
      await dataSource.getRepository(FreshManualResolution).countBy({
        sourceEvidenceKey: reapplied.sourceEvidenceKey,
        active: true,
      }),
      1
    );
  });

  it('keeps one immutable Last Week Tonight history per season and projects the newest active season', async () => {
    await dataSource.synchronize(true);
    let clock = new Date('2026-09-28T12:00:00.000Z');
    const lastWeekRelease = (
      id: number,
      seasonNumber: number,
      episode: number,
      at: string
    ) => ({
      ...release(id, 'tv', 'Last Week Tonight with John Oliver', 2026, at),
      sourceTitle: `Last.Week.Tonight.with.John.Oliver.S${seasonNumber}E${episode}.1080p`,
      seasonNumber,
      episodeNumber: episode,
      explicitSeason: true,
    });
    releases = [lastWeekRelease(7001, 13, 24, '2026-09-28T01:00:00Z')];
    const resolver = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('wrong namespace');
        },
        getTvShow: async ({ tvId }) =>
          tv(
            tvId,
            'Last Week Tonight with John Oliver',
            '2014-04-27'
          ) as unknown as TmdbTvDetails,
        getTvSeason: async ({ seasonNumber }) =>
          ({
            id: seasonNumber,
            name: `Season ${seasonNumber}`,
            overview: '',
            air_date: seasonNumber === 13 ? '2026-02-15' : '2027-02-14',
            season_number: seasonNumber,
            poster_path: null,
            episodes: [
              {
                id: seasonNumber * 100 + 1,
                name: 'Episode 1',
                overview: '',
                air_date: seasonNumber === 13 ? '2026-09-27' : '2027-02-14',
                episode_number: seasonNumber === 13 ? 24 : 1,
                season_number: seasonNumber,
                production_code: '',
                runtime: 30,
                still_path: null,
                vote_average: 0,
                vote_count: 0,
                crew: [],
                guest_stars: [],
              },
            ],
          }) as unknown as TmdbSeasonWithEpisodes,
        searchMoviesStrict: async () => {
          throw new Error('wrong namespace');
        },
        searchTvShowsStrict: async ({ page = 1 }) => ({
          page,
          total_pages: 1,
          total_results: 1,
          results: [
            tv(60694, 'Last Week Tonight with John Oliver', '2014-04-27'),
          ],
        }),
      },
      now: () => new Date(clock),
      cancelled: () => false,
    });

    await resolver.run(settings, true);
    const season13Candidate = await dataSource
      .getRepository(FreshCandidate)
      .findOneByOrFail({ seasonKey: 13 });
    const season13Visibility = await dataSource
      .getRepository(FreshCandidateVisibility)
      .findOneByOrFail({
        sourceEvidenceKey: season13Candidate.sourceEvidenceKey,
      });
    season13Visibility.show = false;
    await dataSource
      .getRepository(FreshCandidateVisibility)
      .save(season13Visibility);
    let histories = await dataSource.getRepository(FreshDiscoveryHistory).find({
      order: { seasonKey: 'ASC' },
    });
    assert.equal(histories.length, 1);
    assert.equal(histories[0].seasonKey, 13);
    assert.equal(histories[0].admitted, true);
    const season13FirstFresh = histories[0].firstFreshAt?.toISOString();
    const season13VisibleUntil = histories[0].visibleUntil?.toISOString();

    releases = [
      lastWeekRelease(7002, 13, 25, '2026-09-29T01:00:00Z'),
      ...releases,
    ];
    clock = new Date('2026-09-29T12:00:00.000Z');
    await resolver.run(settings, false);
    histories = await dataSource.getRepository(FreshDiscoveryHistory).find();
    assert.equal(histories.length, 1);
    assert.equal(histories[0].firstFreshAt?.toISOString(), season13FirstFresh);
    assert.equal(
      histories[0].visibleUntil?.toISOString(),
      season13VisibleUntil
    );

    const generationSettings = {
      ...settings,
      baseUrl: 'https://autobrr-generation-2.test',
    };
    await resolver.run(generationSettings, false);
    histories = await dataSource.getRepository(FreshDiscoveryHistory).find();
    assert.equal(histories.length, 1);
    assert.equal(histories[0].firstFreshAt?.toISOString(), season13FirstFresh);
    assert.equal(
      histories[0].visibleUntil?.toISOString(),
      season13VisibleUntil
    );

    releases = [
      lastWeekRelease(7004, 13, 27, '2026-10-10T01:00:00Z'),
      ...releases,
    ];
    clock = new Date('2026-10-10T12:00:00.000Z');
    await resolver.run(generationSettings, false);
    histories = await dataSource.getRepository(FreshDiscoveryHistory).find();
    assert.equal(histories.length, 1);
    assert.equal(histories[0].firstFreshAt?.toISOString(), season13FirstFresh);
    assert.equal(
      histories[0].visibleUntil?.toISOString(),
      season13VisibleUntil
    );
    assert.equal(
      (
        await dataSource.getRepository(FreshMedia).findOneByOrFail({
          mediaType: 'tv',
          tmdbId: 60694,
        })
      ).active,
      false
    );

    releases = [
      lastWeekRelease(7005, 14, 1, '2027-02-15T01:00:00Z'),
      ...releases,
    ];
    clock = new Date('2027-02-15T12:00:00.000Z');
    await resolver.run(generationSettings, false);
    histories = await dataSource.getRepository(FreshDiscoveryHistory).find({
      order: { seasonKey: 'ASC' },
    });
    assert.deepEqual(
      histories.map((history) => history.seasonKey),
      [13, 14]
    );
    assert.equal(histories[0].firstFreshAt?.toISOString(), season13FirstFresh);
    const projection = await dataSource
      .getRepository(FreshMedia)
      .findOneByOrFail({
        mediaType: 'tv',
        tmdbId: 60694,
      });
    assert.equal(
      projection.firstSeenAt.toISOString(),
      '2027-02-15T01:00:00.000Z'
    );
    assert.equal(projection.active, true);
    const visibilities = await dataSource
      .getRepository(FreshCandidateVisibility)
      .find({ order: { id: 'ASC' } });
    assert.equal(
      visibilities.find(
        (visibility) =>
          visibility.sourceEvidenceKey === season13Candidate.sourceEvidenceKey
      )?.show,
      false
    );
    assert.equal(visibilities.at(-1)?.show, true);
  });

  it('keeps explicit Specials as independent irreversible identities without inventing season zero', async () => {
    await dataSource.synchronize(true);
    let clock = new Date('2026-09-28T12:00:00.000Z');
    const special = (
      id: number,
      episodeNumber: number,
      at: string,
      explicitSpecial = true
    ): FreshRelease => ({
      ...release(id, 'tv', 'Example Series', 2026, at),
      sourceTitle: explicitSpecial
        ? `Example.Series.S00E${String(episodeNumber).padStart(2, '0')}.1080p`
        : 'Example.Series.1080p',
      seasonNumber: 0,
      episodeNumber,
      explicitSpecial,
    });
    releases = [
      special(7103, 0, '2026-09-28T03:00:00Z', false),
      special(7102, 14, '2026-09-28T02:00:00Z'),
      special(7101, 1, '2026-09-28T01:00:00Z'),
    ];
    const resolver = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async () => {
          throw new Error('wrong namespace');
        },
        getTvShow: async ({ tvId }) =>
          tv(tvId, 'Example Series', '2020-01-01') as unknown as TmdbTvDetails,
        getTvSeason: async () =>
          ({
            id: 0,
            name: 'Specials',
            overview: '',
            air_date: '2020-01-01',
            season_number: 0,
            poster_path: null,
            episodes: [
              {
                id: 1,
                name: 'Recent Special',
                overview: '',
                air_date: '2026-09-27',
                episode_number: 1,
                season_number: 0,
                production_code: '',
                runtime: 30,
                still_path: null,
                vote_average: 0,
                vote_count: 0,
                crew: [],
                guest_stars: [],
              },
              {
                id: 14,
                name: 'Historical Special',
                overview: '',
                air_date: '2020-01-01',
                episode_number: 14,
                season_number: 0,
                production_code: '',
                runtime: 30,
                still_path: null,
                vote_average: 0,
                vote_count: 0,
                crew: [],
                guest_stars: [],
              },
            ],
          }) as unknown as TmdbSeasonWithEpisodes,
        searchMoviesStrict: async () => {
          throw new Error('wrong namespace');
        },
        searchTvShowsStrict: async ({ page = 1 }) => ({
          page,
          total_pages: 1,
          total_results: 1,
          results: [tv(7100, 'Example Series', '2020-01-01')],
        }),
      },
      now: () => new Date(clock),
      cancelled: () => false,
    });

    await resolver.run(settings, true);
    let histories = await dataSource.getRepository(FreshDiscoveryHistory).find({
      order: { specialEpisodeKey: 'ASC' },
    });
    assert.deepEqual(
      histories.map((history) => [
        history.identityKind,
        history.specialEpisodeKey,
        history.admitted,
      ]),
      [
        ['special', 1, true],
        ['special', 14, false],
      ]
    );
    assert.equal(
      await dataSource.getRepository(FreshMedia).countBy({
        mediaType: 'tv',
        tmdbId: 7100,
      }),
      1
    );
    const firstFreshAt = histories[0].firstFreshAt?.toISOString();

    releases = [special(7104, 1, '2026-09-29T01:00:00Z'), ...releases];
    clock = new Date('2026-09-29T12:00:00.000Z');
    await resolver.run(settings, false);
    histories = await dataSource.getRepository(FreshDiscoveryHistory).find({
      order: { specialEpisodeKey: 'ASC' },
    });
    assert.equal(histories.length, 2);
    assert.equal(histories[0].firstFreshAt?.toISOString(), firstFreshAt);
  });

  it('applies and removes a durable admission override without resetting its Fresh clock', async () => {
    await dataSource.synchronize(true);
    let clock = new Date('2026-09-28T12:00:00.000Z');
    releases = [
      release(8001, 'movie', 'Historical Movie', 2020, '2026-09-28T01:00:00Z'),
    ];
    const resolver = new FreshEngine({
      database: dataSource,
      autobrr: () => ({
        filters: async () => filters,
        page: async (_filter, cursor = 0) => page(releases, cursor),
      }),
      tmdb: {
        getMovie: async ({ movieId }) =>
          movie(
            movieId,
            'Historical Movie',
            '2020-01-01'
          ) as unknown as TmdbMovieDetails,
        getTvShow: async () => {
          throw new Error('wrong namespace');
        },
        searchMoviesStrict: async ({ page = 1 }) => ({
          page,
          total_pages: 1,
          total_results: 1,
          results: [movie(8080, 'Historical Movie', '2020-01-01')],
        }),
        searchTvShowsStrict: async () => {
          throw new Error('wrong namespace');
        },
      },
      now: () => new Date(clock),
      cancelled: () => false,
    });
    await resolver.run(settings, true);
    let candidate = await dataSource
      .getRepository(FreshCandidate)
      .findOneByOrFail({
        displayTitle: 'Historical Movie',
      });
    const overrideVisibility = await dataSource
      .getRepository(FreshCandidateVisibility)
      .findOneByOrFail({ sourceEvidenceKey: candidate.sourceEvidenceKey });
    overrideVisibility.show = false;
    await dataSource
      .getRepository(FreshCandidateVisibility)
      .save(overrideVisibility);
    let history = await dataSource
      .getRepository(FreshDiscoveryHistory)
      .findOneByOrFail({ mediaType: 'movie', tmdbId: 8080 });
    assert.equal(history.admitted, false);
    assert.equal(history.firstFreshAt, null);

    candidate = await resolver.setAdmissionOverride(
      candidate.id,
      candidate.revision,
      settings,
      42
    );
    history = await dataSource
      .getRepository(FreshDiscoveryHistory)
      .findOneByOrFail({ mediaType: 'movie', tmdbId: 8080 });
    const firstFreshAt = history.firstFreshAt?.toISOString();
    assert.equal(firstFreshAt, clock.toISOString());
    assert.equal(
      (
        await dataSource
          .getRepository(FreshMedia)
          .findOneByOrFail({ mediaType: 'movie', tmdbId: 8080 })
      ).active,
      true
    );
    await assert.rejects(
      () =>
        resolver.setAdmissionOverride(
          candidate.id,
          candidate.revision - 1,
          settings,
          42
        ),
      /stale_candidate/
    );

    candidate = await resolver.removeAdmissionOverride(
      candidate.id,
      candidate.revision,
      settings
    );
    assert.equal(
      (
        await dataSource
          .getRepository(FreshMedia)
          .findOneByOrFail({ mediaType: 'movie', tmdbId: 8080 })
      ).active,
      false
    );
    clock = new Date('2026-09-29T12:00:00.000Z');
    candidate = await resolver.setAdmissionOverride(
      candidate.id,
      candidate.revision,
      settings,
      42
    );
    history = await dataSource
      .getRepository(FreshDiscoveryHistory)
      .findOneByOrFail({ mediaType: 'movie', tmdbId: 8080 });
    assert.equal(history.firstFreshAt?.toISOString(), firstFreshAt);
    assert.equal(
      history.visibleUntil?.toISOString(),
      '2026-10-05T12:00:00.000Z'
    );
    assert.equal(
      (
        await dataSource
          .getRepository(FreshCandidateVisibility)
          .findOneByOrFail({ sourceEvidenceKey: candidate.sourceEvidenceKey })
      ).show,
      false
    );
  });
});
