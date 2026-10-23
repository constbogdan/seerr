import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type { WatchlistRouletteRunSummary } from '@server/constants/watchlistRoulette';
import Media from '@server/entity/Media';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import {
  WatchlistRouletteService,
  createWatchlistRouletteRequest,
  isLoadedMediaEligibleForWatchlistRoulette,
  shuffleWatchlistIdentities,
  uniqueWatchlistIdentities,
  watchlistRouletteRequestBody,
  type WatchlistRouletteDependencies,
} from '@server/lib/watchlistRoulette';
import { WatchlistRouletteCollectionResolver } from '@server/lib/watchlistRouletteCollections';
import logger from '@server/logger';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const administrator = new User({ id: 42, permissions: Permission.ADMIN });

const dependencies = (
  overrides: Partial<WatchlistRouletteDependencies> = {}
): WatchlistRouletteDependencies => ({
  now: () => new Date('2026-10-19T10:00:00.000Z'),
  randomIndex: (upperExclusive) => upperExclusive - 1,
  getCandidates: async (mediaType) => [
    { mediaType, tmdbId: 1 },
    { mediaType, tmdbId: 2 },
  ],
  refreshAcquisitions: async () => ({ authoritative: true }),
  findRequestOwner: async () => administrator,
  isCandidateEligible: async () => true,
  resolveMovieCandidate: async (candidate) => ({
    outcome: 'resolved',
    candidate,
  }),
  createRequest: async (candidate) => ({
    id: candidate.tmdbId,
    status: MediaRequestStatus.APPROVED,
  }),
  persistSummary: async () => undefined,
  hasDefaultProvider: () => true,
  getConfiguration: () => ({
    requestOwnerUserId: administrator.id,
    movieItemsPerRun: 3,
    seriesItemsPerRun: 1,
  }),
  ...overrides,
});

describe('Watchlist Roulette selection', () => {
  it('deduplicates globally and ignores invalid or wrong-type identities', () => {
    assert.deepEqual(
      uniqueWatchlistIdentities(
        [
          { mediaType: MediaType.MOVIE, tmdbId: 10 },
          { mediaType: MediaType.MOVIE, tmdbId: 10 },
          { mediaType: MediaType.MOVIE, tmdbId: 0 },
          { mediaType: MediaType.TV, tmdbId: 20 },
        ],
        MediaType.MOVIE
      ),
      [{ mediaType: MediaType.MOVIE, tmdbId: 10 }]
    );
  });

  it('uses an unbiased Fisher-Yates shape without mutating the source pool', () => {
    const source = [
      { mediaType: MediaType.MOVIE, tmdbId: 1 },
      { mediaType: MediaType.MOVIE, tmdbId: 2 },
      { mediaType: MediaType.MOVIE, tmdbId: 3 },
    ];
    const indexes = [0, 0];
    const shuffled = shuffleWatchlistIdentities(source, () => indexes.shift()!);
    assert.deepEqual(
      shuffled.map((candidate) => candidate.tmdbId),
      [2, 3, 1]
    );
    assert.deepEqual(
      source.map((candidate) => candidate.tmdbId),
      [1, 2, 3]
    );
  });

  it('builds Season-1-only Series requests', () => {
    assert.deepEqual(
      watchlistRouletteRequestBody({ mediaType: MediaType.TV, tmdbId: 99 }),
      {
        mediaType: MediaType.TV,
        mediaId: 99,
        is4k: false,
        seasons: [1],
      }
    );
  });

  it('excludes available, failed-request, and active-acquisition Movies', () => {
    const media = new Media({
      mediaType: MediaType.MOVIE,
      status: MediaStatus.AVAILABLE,
      requests: [],
      seasons: [],
    });
    assert.equal(
      isLoadedMediaEligibleForWatchlistRoulette(media, MediaType.MOVIE),
      false
    );
    media.status = MediaStatus.UNKNOWN;
    media.requests = [
      new MediaRequest({
        is4k: false,
        status: MediaRequestStatus.FAILED,
        seasons: [],
      }),
    ];
    assert.equal(
      isLoadedMediaEligibleForWatchlistRoulette(media, MediaType.MOVIE),
      false
    );
    media.requests = [];
    media.downloadStatus = [{} as never];
    assert.equal(
      isLoadedMediaEligibleForWatchlistRoulette(media, MediaType.MOVIE),
      false
    );
    media.downloadStatus = [];
    media.status = MediaStatus.BLOCKLISTED;
    assert.equal(
      isLoadedMediaEligibleForWatchlistRoulette(media, MediaType.MOVIE),
      false
    );
  });

  it('allows a partial Series only when Season 1 is missing and unrequested', () => {
    const media = new Media({
      mediaType: MediaType.TV,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      requests: [],
      seasons: [new Season({ seasonNumber: 2, status: MediaStatus.AVAILABLE })],
      downloadStatus: [],
    });
    assert.equal(
      isLoadedMediaEligibleForWatchlistRoulette(media, MediaType.TV),
      true
    );
    media.seasons.push(
      new Season({ seasonNumber: 1, status: MediaStatus.AVAILABLE })
    );
    assert.equal(
      isLoadedMediaEligibleForWatchlistRoulette(media, MediaType.TV),
      false
    );
    media.seasons = [];
    media.requests = [
      new MediaRequest({
        is4k: false,
        status: MediaRequestStatus.APPROVED,
        seasons: [new SeasonRequest({ seasonNumber: 1 })],
      }),
    ];
    assert.equal(
      isLoadedMediaEligibleForWatchlistRoulette(media, MediaType.TV),
      false
    );
  });

  it('uses the configured administrator and normal auto-request workflow', async () => {
    const original = MediaRequest.request;
    let called = false;
    MediaRequest.request = async (body, owner, options) => {
      called = true;
      assert.equal(owner, administrator);
      assert.deepEqual(body, {
        mediaType: MediaType.MOVIE,
        mediaId: 88,
        is4k: false,
      });
      assert.deepEqual(options, { isAutoRequest: true });
      return { id: 71, status: MediaRequestStatus.APPROVED } as MediaRequest;
    };
    try {
      const request = await createWatchlistRouletteRequest(
        { mediaType: MediaType.MOVIE, tmdbId: 88 },
        administrator
      );
      assert.equal(request.id, 71);
      assert.equal(called, true);
    } finally {
      MediaRequest.request = original;
    }
  });

  it('stops at the configured success limit while traversing without replacement', async () => {
    const attempted: number[] = [];
    const persisted: WatchlistRouletteRunSummary[] = [];
    const service = new WatchlistRouletteService(
      MediaType.MOVIE,
      dependencies({
        getCandidates: async () => [
          { mediaType: MediaType.MOVIE, tmdbId: 1 },
          { mediaType: MediaType.MOVIE, tmdbId: 1 },
          { mediaType: MediaType.MOVIE, tmdbId: 2 },
          { mediaType: MediaType.MOVIE, tmdbId: 3 },
        ],
        getConfiguration: () => ({
          requestOwnerUserId: administrator.id,
          movieItemsPerRun: 2,
          seriesItemsPerRun: 1,
        }),
        createRequest: async (candidate) => {
          attempted.push(candidate.tmdbId);
          return {
            id: candidate.tmdbId,
            status: MediaRequestStatus.APPROVED,
          };
        },
        persistSummary: async (_mediaType, summary) => {
          persisted.push(summary);
        },
      })
    );
    const result = await service.run();
    assert.deepEqual(attempted, [1, 2]);
    assert.equal(result.requested, 2);
    assert.deepEqual(result.requestIds, [1, 2]);
    assert.equal(persisted.length, 1);
  });

  it('treats duplicate request races as skips and continues', async () => {
    let attempts = 0;
    const service = new WatchlistRouletteService(
      MediaType.MOVIE,
      dependencies({
        getConfiguration: () => ({
          requestOwnerUserId: administrator.id,
          movieItemsPerRun: 1,
          seriesItemsPerRun: 1,
        }),
        createRequest: async (candidate) => {
          attempts += 1;
          if (candidate.tmdbId === 1) throw new DuplicateMediaRequestError();
          return { id: 22, status: MediaRequestStatus.APPROVED };
        },
      })
    );
    const result = await service.run();
    assert.equal(attempts, 2);
    assert.equal(result.skipped, 1);
    assert.equal(result.requested, 1);
  });

  it('applies existing eligibility and request submission to the resolved collection Movie', async () => {
    const eligible: number[] = [];
    const requested: number[] = [];
    const service = new WatchlistRouletteService(
      MediaType.MOVIE,
      dependencies({
        getCandidates: async () => [{ mediaType: MediaType.MOVIE, tmdbId: 4 }],
        resolveMovieCandidate: async () => ({
          outcome: 'resolved',
          candidate: { mediaType: MediaType.MOVIE, tmdbId: 1 },
        }),
        isCandidateEligible: async (candidate) => {
          eligible.push(candidate.tmdbId);
          return true;
        },
        createRequest: async (candidate) => {
          requested.push(candidate.tmdbId);
          return { id: 101, status: MediaRequestStatus.APPROVED };
        },
      })
    );

    const result = await service.run();
    assert.deepEqual(eligible, [1]);
    assert.deepEqual(requested, [1]);
    assert.deepEqual(result.requestIds, [101]);
  });

  it('skips a collection when its earliest absent Movie is downloading, failed, or blocklisted', async () => {
    const ineligibleStates = [
      (media: Media) => {
        media.downloadStatus = [{} as never];
      },
      (media: Media) => {
        media.requests = [
          new MediaRequest({
            is4k: false,
            status: MediaRequestStatus.FAILED,
            seasons: [],
          }),
        ];
      },
      (media: Media) => {
        media.status = MediaStatus.BLOCKLISTED;
      },
    ];

    for (const makeIneligible of ineligibleStates) {
      const earliestAbsent = new Media({
        mediaType: MediaType.MOVIE,
        status: MediaStatus.UNKNOWN,
        requests: [],
        seasons: [],
        downloadStatus: [],
      });
      makeIneligible(earliestAbsent);
      const requested: number[] = [];
      const service = new WatchlistRouletteService(
        MediaType.MOVIE,
        dependencies({
          getCandidates: async () => [
            { mediaType: MediaType.MOVIE, tmdbId: 4 },
            { mediaType: MediaType.MOVIE, tmdbId: 9 },
          ],
          resolveMovieCandidate: async (candidate) =>
            candidate.tmdbId === 4
              ? {
                  outcome: 'resolved',
                  candidate: { mediaType: MediaType.MOVIE, tmdbId: 2 },
                }
              : { outcome: 'resolved', candidate },
          isCandidateEligible: async (candidate) =>
            candidate.tmdbId === 9 ||
            isLoadedMediaEligibleForWatchlistRoulette(
              earliestAbsent,
              MediaType.MOVIE
            ),
          createRequest: async (candidate) => {
            requested.push(candidate.tmdbId);
            return {
              id: candidate.tmdbId,
              status: MediaRequestStatus.APPROVED,
            };
          },
        })
      );

      const result = await service.run();
      assert.equal(result.skipped, 1);
      assert.equal(result.requested, 1);
      assert.deepEqual(result.requestIds, [9]);
      assert.deepEqual(requested, [9]);
    }
  });

  it('keeps quota and permission rejections as expected skips', async () => {
    for (const error of [
      new QuotaRestrictedError(),
      new RequestPermissionError(),
    ]) {
      const service = new WatchlistRouletteService(
        MediaType.MOVIE,
        dependencies({
          getCandidates: async () => [
            { mediaType: MediaType.MOVIE, tmdbId: 1 },
          ],
          createRequest: async () => {
            throw error;
          },
        })
      );
      const result = await service.run();
      assert.equal(result.skipped, 1);
      assert.equal(result.failed, 0);
    }
  });

  it('reports metadata-limit termination without claiming normal exhaustion', async () => {
    const service = new WatchlistRouletteService(
      MediaType.MOVIE,
      dependencies({
        getCandidates: async () => [
          { mediaType: MediaType.MOVIE, tmdbId: 1 },
          { mediaType: MediaType.MOVIE, tmdbId: 2 },
        ],
        resolveMovieCandidate: async () => ({
          outcome: 'limit',
          limitReason: 'metadata-budget',
        }),
      })
    );
    const result = await service.run();
    assert.equal(result.status, 'succeeded');
    assert.equal(result.examined, 1);
    assert.equal(result.requested, 0);
    assert.equal(result.limitReason, 'metadata-budget');
  });

  it('preserves partial success when a later candidate exhausts the metadata budget', async () => {
    const candidates = [
      { mediaType: MediaType.MOVIE, tmdbId: 11 },
      { mediaType: MediaType.MOVIE, tmdbId: 22 },
      { mediaType: MediaType.MOVIE, tmdbId: 33 },
    ];
    const resolved: number[] = [];
    const submitted: number[] = [];
    const persisted: WatchlistRouletteRunSummary[] = [];
    const service = new WatchlistRouletteService(
      MediaType.MOVIE,
      dependencies({
        getCandidates: async () => candidates,
        getConfiguration: () => ({
          requestOwnerUserId: administrator.id,
          movieItemsPerRun: 3,
          seriesItemsPerRun: 1,
        }),
        resolveMovieCandidate: async (candidate) => {
          resolved.push(candidate.tmdbId);
          return candidate.tmdbId === candidates[1].tmdbId
            ? { outcome: 'limit', limitReason: 'metadata-budget' }
            : { outcome: 'resolved', candidate };
        },
        createRequest: async (candidate) => {
          submitted.push(candidate.tmdbId);
          return { id: 101, status: MediaRequestStatus.APPROVED };
        },
        persistSummary: async (_mediaType, summary) => {
          persisted.push(summary);
        },
      })
    );

    const result = await service.run();
    assert.deepEqual(
      {
        status: result.status,
        requested: result.requested,
        skipped: result.skipped,
        failed: result.failed,
        examined: result.examined,
        requestIds: result.requestIds,
        limitReason: result.limitReason,
      },
      {
        status: 'succeeded',
        requested: 1,
        skipped: 0,
        failed: 0,
        examined: 2,
        requestIds: [101],
        limitReason: 'metadata-budget',
      }
    );
    assert.deepEqual(resolved, [11, 22]);
    assert.deepEqual(submitted, [11]);
    assert.deepEqual(persisted, [result]);
  });

  it('counts fail-closed metadata failures as skips', async (t) => {
    const warn = t.mock.method(logger, 'warn', () => logger);
    const resolver = new WatchlistRouletteCollectionResolver({
      getLocalMembership: async (tmdbId) => {
        if (tmdbId === 41) throw new Error('metadata unavailable');
        return { kind: 'standalone' };
      },
    });
    const service = new WatchlistRouletteService(
      MediaType.MOVIE,
      dependencies({
        getCandidates: async () => [
          { mediaType: MediaType.MOVIE, tmdbId: 41 },
          { mediaType: MediaType.MOVIE, tmdbId: 42 },
        ],
        resolveMovieCandidate: (candidate, state) =>
          resolver.resolve(candidate, state),
        createRequest: async () => ({
          id: 101,
          status: MediaRequestStatus.APPROVED,
        }),
      })
    );

    const result = await service.run();
    assert.equal(result.requested, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.examined, 2);
    assert.deepEqual(result.requestIds, [101]);
    assert.equal(warn.mock.callCount(), 1);
  });

  it('does not invoke Movie collection resolution for Series Roulette', async () => {
    let resolutionCalls = 0;
    const service = new WatchlistRouletteService(
      MediaType.TV,
      dependencies({
        getCandidates: async () => [{ mediaType: MediaType.TV, tmdbId: 50 }],
        resolveMovieCandidate: async () => {
          resolutionCalls += 1;
          return { outcome: 'skip' };
        },
      })
    );
    const result = await service.run();
    assert.equal(resolutionCalls, 0);
    assert.equal(result.requested, 1);
    assert.deepEqual(result.requestIds, [50]);
  });

  it('fails closed before candidate loading when acquisition state is not authoritative', async () => {
    let loadedCandidates = false;
    const service = new WatchlistRouletteService(
      MediaType.MOVIE,
      dependencies({
        refreshAcquisitions: async () => ({ authoritative: false }),
        getCandidates: async () => {
          loadedCandidates = true;
          return [];
        },
      })
    );
    const result = await service.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'acquisition-state-unavailable');
    assert.equal(loadedCandidates, false);
  });

  it('uses an independent single-flight guard for a job instance', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new WatchlistRouletteService(
      MediaType.TV,
      dependencies({
        getCandidates: async () => {
          await waiting;
          return [];
        },
      })
    );
    const first = service.run();
    const second = service.run();
    assert.equal(first, second);
    release();
    await first;
    assert.equal(service.running(), false);
  });
});
