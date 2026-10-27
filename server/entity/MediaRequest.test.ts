import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import ExternalAPI from '@server/api/externalapi';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  MediaRequest,
  QuotaRestrictedError,
} from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { setupTestDb } from '@server/test/db';

// get is a prototype method unlike getMovie, and replaces the cache lookup too
const externalApiGetMock = mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => {
    const tmdbId = Number(endpoint.replace(/^\/(movie|tv)\//, ''));

    if (!tmdbId) {
      throw new Error(`Unstubbed external endpoint: ${endpoint}`);
    }

    return {
      id: tmdbId,
      external_ids: {},
      seasons: [0, 1, 2, 3, 4].map((season_number) => ({
        season_number,
        episode_count: season_number === 0 ? 2 : 10,
      })),
      // Skips getMovie's localized fallback call
      videos: { results: [{ type: 'Trailer', key: 'trailer' }] },
    };
  }
).mock;

mock.method(MediaRequest, 'sendNotification', async () => undefined);

setupTestDb();

beforeEach(() => {
  externalApiGetMock.resetCalls();
});

async function seedRequester(movieQuotaLimit: number): Promise<User> {
  const userRepository = getRepository(User);

  const requester = await userRepository.findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  requester.movieQuotaLimit = movieQuotaLimit;

  return userRepository.save(requester);
}

async function createRequester(
  email: string,
  permissions = Permission.REQUEST
): Promise<User> {
  return getRepository(User).save(new User({ email, permissions, avatar: '' }));
}

function requestMovies(mediaIds: number[], requester: User) {
  return Promise.allSettled(
    mediaIds.map((mediaId) =>
      MediaRequest.request(
        { mediaId, mediaType: MediaType.MOVIE, is4k: false },
        requester
      )
    )
  );
}

function rejections(results: PromiseSettledResult<MediaRequest>[]) {
  return results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
}

const requestNextSeason = (
  mediaId: number,
  seasons: number[],
  requester: User
) =>
  MediaRequest.request(
    { mediaId, mediaType: MediaType.TV, seasons, is4k: false },
    requester,
    {
      isAutoRequest: true,
      allowNonOverlappingAutoRequestSeasons: true,
    }
  );

describe('MediaRequest.request', () => {
  it('rejects blocked Movies and Series in HD and 4K without creating requests', async () => {
    const requester = await createRequester(
      'blocked-fixture@example.invalid',
      Permission.ADMIN
    );
    for (const mediaType of [MediaType.MOVIE, MediaType.TV]) {
      const media = await getRepository(Media).save(
        new Media({
          tmdbId: 424242,
          mediaType,
          status: MediaStatus.BLOCKLISTED,
          status4k: MediaStatus.BLOCKLISTED,
        })
      );
      for (const is4k of [false, true]) {
        await assert.rejects(
          MediaRequest.request(
            {
              mediaId: media.tmdbId,
              mediaType,
              is4k,
              ...(mediaType === MediaType.TV ? { seasons: [1] } : {}),
            },
            requester
          ),
          BlocklistedMediaError
        );
      }
      assert.equal(
        (await getRepository(Media).findOneByOrFail({ id: media.id })).status,
        MediaStatus.BLOCKLISTED
      );
    }
    assert.equal(await getRepository(MediaRequest).count(), 0);
  });
  it('rejects the second of two concurrent requests at the movie quota', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(1);

    const results = await requestMovies([11111, 22222], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof QuotaRestrictedError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 1);
  });

  it('rejects a concurrent duplicate request for the same movie', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);

    const results = await requestMovies([33333, 33333], requester);
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
    assert.strictEqual(externalApiGetMock.callCount(), 2);
  });

  it('keeps default automatic Movie and Series deduplication media-wide', async () => {
    const requester = await seedRequester(5);

    await MediaRequest.request(
      { mediaId: 33334, mediaType: MediaType.MOVIE, is4k: false },
      requester,
      { isAutoRequest: true }
    );
    await assert.rejects(
      () =>
        MediaRequest.request(
          { mediaId: 33334, mediaType: MediaType.MOVIE, is4k: false },
          requester,
          { isAutoRequest: true }
        ),
      DuplicateMediaRequestError
    );

    await MediaRequest.request(
      {
        mediaId: 33335,
        mediaType: MediaType.TV,
        seasons: [2],
        is4k: false,
      },
      requester,
      { isAutoRequest: true }
    );
    await assert.rejects(
      () =>
        MediaRequest.request(
          {
            mediaId: 33335,
            mediaType: MediaType.TV,
            seasons: [3],
            is4k: false,
          },
          requester,
          { isAutoRequest: true }
        ),
      DuplicateMediaRequestError
    );
  });

  it('allows only disjoint Next Season automatic requests', async () => {
    const requester = await seedRequester(5);
    const requestRepository = getRepository(MediaRequest);

    await requestNextSeason(33336, [2], requester);
    await requestNextSeason(33336, [4], requester);

    await assert.rejects(
      () => requestNextSeason(33336, [2], requester),
      DuplicateMediaRequestError
    );
    await assert.rejects(
      () => requestNextSeason(33336, [3, 4], requester),
      DuplicateMediaRequestError
    );

    const requests = await requestRepository.find({
      where: { media: { tmdbId: 33336 } },
      order: { id: 'ASC' },
    });
    assert.deepEqual(
      requests.map((request) =>
        request.seasons.map((season) => season.seasonNumber)
      ),
      [[2], [4]]
    );
  });

  it('uses persisted Season overlap for every existing request status', async () => {
    const requester = await seedRequester(5);
    const requestRepository = getRepository(MediaRequest);
    const statuses = [
      MediaRequestStatus.PENDING,
      MediaRequestStatus.APPROVED,
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.COMPLETED,
      MediaRequestStatus.FAILED,
    ];

    for (const [index, status] of statuses.entries()) {
      const mediaId = 33340 + index;
      const existing = await requestNextSeason(mediaId, [2], requester);
      existing.status = status;
      await requestRepository.save(existing);

      await requestNextSeason(mediaId, [3], requester);
      await assert.rejects(
        () => requestNextSeason(mediaId, [2], requester),
        DuplicateMediaRequestError
      );
    }
  });

  it('serializes concurrent overlapping Next Season requests', async () => {
    const requester = await seedRequester(5);
    const seasonRequestRepository = getRepository(SeasonRequest);

    const results = await Promise.allSettled([
      requestNextSeason(33350, [2], requester),
      requestNextSeason(33350, [2], requester),
    ]);

    const rejected = rejections(results);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.equal(
      await seasonRequestRepository.count({ where: { seasonNumber: 2 } }),
      1
    );
  });

  it('rejects a duplicate request that omits is4k', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const body = { mediaId: 66666, mediaType: MediaType.MOVIE };

    await MediaRequest.request(body, requester);

    await assert.rejects(
      () => MediaRequest.request(body, requester),
      DuplicateMediaRequestError
    );
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('rejects a concurrent duplicate request from a different user', async () => {
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [requester, otherRequester].map((user) =>
        MediaRequest.request(
          { mediaId: 44444, mediaType: MediaType.MOVIE, is4k: false },
          user
        )
      )
    );
    const rejected = rejections(results);

    assert.strictEqual(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof DuplicateMediaRequestError);
    assert.strictEqual(await requestRepository.count(), 1);
  });

  it('gives an overlapping season to only one of two concurrent users', async () => {
    const seasonRequestRepository = getRepository(SeasonRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester('second@seerr.dev');

    const results = await Promise.allSettled(
      [
        [requester, [1, 2]],
        [otherRequester, [2, 3]],
      ].map(([user, seasons]) =>
        MediaRequest.request(
          {
            mediaId: 55555,
            mediaType: MediaType.TV,
            seasons: seasons as number[],
            is4k: false,
          },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(
      await seasonRequestRepository.count({ where: { seasonNumber: 2 } }),
      1
    );
    assert.strictEqual(await seasonRequestRepository.count(), 3);
  });

  it('creates one media row for concurrent 4k and non-4k requests', async () => {
    const mediaRepository = getRepository(Media);
    const requestRepository = getRepository(MediaRequest);
    const requester = await seedRequester(5);
    const otherRequester = await createRequester(
      'second@seerr.dev',
      Permission.REQUEST_4K
    );

    const results = await Promise.allSettled(
      [
        [requester, false],
        [otherRequester, true],
      ].map(([user, is4k]) =>
        MediaRequest.request(
          { mediaId: 88888, mediaType: MediaType.MOVIE, is4k: is4k as boolean },
          user as User
        )
      )
    );

    assert.strictEqual(rejections(results).length, 0);
    assert.strictEqual(await requestRepository.count(), 2);
    assert.strictEqual(
      await mediaRepository.count({
        where: { tmdbId: 88888, mediaType: MediaType.MOVIE },
      }),
      1
    );
  });
});
