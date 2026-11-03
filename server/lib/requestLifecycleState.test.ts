import ExternalAPI from '@server/api/externalapi';
import RadarrAPI from '@server/api/servarr/radarr';
import {
  MediaStatus as MS,
  MediaType as MT,
  MediaRequestStatus as RS,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import {
  failApprovedRequest,
  linkAcceptedProviderMedia,
  requestIdentity,
} from '@server/lib/requestLifecycleState';
import { getSettings } from '@server/lib/settings';
import {
  MediaRequestSubscriber,
  updateRequestStatus,
} from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => ({
    id: Number(endpoint.split('/').pop()),
    title: 'Synthetic',
    name: 'Synthetic',
    release_date: '2020-01-01',
    external_ids: { tvdb_id: 9080 },
    keywords: { results: [] },
    videos: { results: [{ type: 'Trailer', key: 'fixture' }] },
    seasons: [1, 2, 3].map((season_number) => ({
      season_number,
      episode_count: 10,
    })),
  })
);
const notified = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;
mock.method(acquisitionMonitor, 'wake', () => undefined);
setupTestDb();
beforeEach(() => {
  getSettings().radarr = [];
  getSettings().sonarr = [];
  getSettings().overflow.enabled = false;
  getSettings().overflow.automaticSeriesPlacement = false;
  notified.resetCalls();
});
let serial = 90000;
async function seed(type = MT.MOVIE, is4k = false) {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: ++serial,
      tvdbId: 9080,
      mediaType: type,
      status: MS.PROCESSING,
      status4k: is4k ? MS.PROCESSING : MS.UNKNOWN,
      seasons:
        type === MT.TV
          ? [new Season({ seasonNumber: 1, status: MS.PROCESSING })]
          : [],
    }),
    { listeners: false }
  );
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      media,
      requestedBy,
      is4k,
      status: RS.APPROVED,
      seasons:
        type === MT.TV
          ? [new SeasonRequest({ seasonNumber: 1, status: RS.APPROVED })]
          : [],
    }),
    { listeners: false }
  );
}
async function latest(id: number) {
  return getRepository(MediaRequest).findOneByOrFail({ id });
}

describe('C1 bounded existing-row failure transitions', () => {
  for (const type of [MT.MOVIE, MT.TV])
    for (const is4k of [false, true]) {
      it(
        type + ' quality=' + is4k + ' protects Completed and deletion',
        async () => {
          const request = await seed(type, is4k),
            identity = requestIdentity(request);
          await getRepository(MediaRequest).update(request.id, {
            status: RS.COMPLETED,
          });
          assert.equal(
            await failApprovedRequest(dataSource.manager, identity),
            null
          );
          assert.equal((await latest(request.id)).status, RS.COMPLETED);
          await getRepository(MediaRequest).delete(request.id);
          assert.equal(
            await failApprovedRequest(dataSource.manager, identity),
            null
          );
          assert.equal(await getRepository(MediaRequest).count(), 0);
        }
      );
    }
  it('only one duplicate callback wins and mismatched scope cannot fail another row', async () => {
    const request = await seed(),
      identity = requestIdentity(request);
    for (const changed of [
      { is4k: true },
      { mediaId: identity.mediaId + 1 },
      { tmdbId: identity.tmdbId + 1 },
      { requestedById: 2 },
      { type: MT.TV },
    ])
      assert.equal(
        await failApprovedRequest(dataSource.manager, {
          ...identity,
          ...changed,
        }),
        null
      );
    assert.equal(
      (await failApprovedRequest(dataSource.manager, identity))?.status,
      RS.FAILED
    );
    assert.equal(await failApprovedRequest(dataSource.manager, identity), null);
  });
  it('documents active-attempt ABA limitation rather than claiming attempt fencing', async () => {
    const request = await seed(),
      identity = requestIdentity(request);
    await failApprovedRequest(dataSource.manager, identity);
    await getRepository(MediaRequest).update(request.id, {
      status: RS.APPROVED,
    });
    assert.equal(
      (await failApprovedRequest(dataSource.manager, identity))?.status,
      RS.FAILED
    );
  });
  for (const outcome of ['completed', 'deleted', 'eligible'])
    it('actual delayed Radarr rejection: ' + outcome, async () => {
      const request = await seed();
      getSettings().radarr = [
        {
          id: 7,
          name: 'Synthetic',
          hostname: 'provider.invalid',
          port: 1,
          apiKey: 'fixture-only',
          baseUrl: '',
          useSsl: false,
          is4k: false,
          isDefault: true,
          activeProfileId: 1,
          activeDirectory: '/fixed',
          tags: [],
          minimumAvailability: 'released',
          syncEnabled: true,
          activeProfileName: 'Synthetic',
          preventSearch: false,
          tagRequests: false,
          overrideRule: [],
        },
      ];
      let reject: (error: Error) => void = () => {
        throw Error('dispatch did not start');
      };
      let dispatches = 0;
      Object.defineProperty(RadarrAPI.prototype, 'addMovie', {
        configurable: true,
        set() {},
        get() {
          return () => {
            dispatches++;
            return new Promise<never>((_resolve, rejectWork) => {
              reject = rejectWork;
            });
          };
        },
      });
      try {
        const subscriber = new MediaRequestSubscriber();
        const callback = subscriber as unknown as {
          failRequest: (
            ...args: Parameters<typeof failApprovedRequest>
          ) => Promise<void>;
        };
        const original = callback.failRequest.bind(subscriber);
        let finish: () => void = () => undefined;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        mock.method(
          callback,
          'failRequest',
          async (...args: Parameters<typeof failApprovedRequest>) => {
            try {
              await original(...args);
            } finally {
              finish();
            }
          }
        );
        await subscriber.sendToRadarr(request, dataSource.manager);
        assert.equal(dispatches, 1);
        if (outcome === 'completed')
          await getRepository(MediaRequest).update(request.id, {
            status: RS.COMPLETED,
          });
        if (outcome === 'deleted')
          await getRepository(MediaRequest).delete(request.id);
        reject(Error('Synthetic delayed failure'));
        await finished;
        if (outcome === 'deleted')
          assert.equal(await getRepository(MediaRequest).count(), 0);
        else
          assert.equal(
            (await latest(request.id)).status,
            outcome === 'eligible' ? RS.FAILED : RS.COMPLETED
          );
        assert.equal(notified.callCount(), outcome === 'eligible' ? 1 : 0);
      } finally {
        Reflect.deleteProperty(RadarrAPI.prototype, 'addMovie');
      }
    });
});

describe('C3 scalar parent writes and owned child promotion', () => {
  it('stale parent graph cannot reset a child completed after it was loaded', async () => {
    const request = await seed(MT.TV);
    await getRepository(SeasonRequest).update(request.seasons[0].id, {
      status: RS.COMPLETED,
    });
    const result = await updateRequestStatus(
      dataSource.manager,
      request,
      RS.APPROVED
    );
    assert.equal(result?.seasons[0].status, RS.COMPLETED);
  });
  it('approval promotes Pending only and preserves Completed/Declined children', async () => {
    const request = await seed(MT.TV);
    await getRepository(MediaRequest).update(request.id, {
      status: RS.PENDING,
    });
    await getRepository(SeasonRequest).update(request.seasons[0].id, {
      status: RS.COMPLETED,
    });
    for (const [seasonNumber, status] of [
      [2, RS.PENDING],
      [3, RS.DECLINED],
      [4, RS.FAILED],
    ]) {
      await getRepository(SeasonRequest).save(
        new SeasonRequest({ seasonNumber, status, request }),
        { listeners: false }
      );
    }
    const current = await latest(request.id);
    const result = await updateRequestStatus(
      dataSource.manager,
      current,
      RS.APPROVED
    );
    assert.deepEqual(
      result?.seasons.map((s) => s.status),
      [RS.COMPLETED, RS.APPROVED, RS.DECLINED, RS.FAILED]
    );
  });
  it('retry may promote Failed children without changing Completed', async () => {
    const request = await seed(MT.TV);
    await getRepository(MediaRequest).update(request.id, { status: RS.FAILED });
    await getRepository(SeasonRequest).update(request.seasons[0].id, {
      status: RS.COMPLETED,
    });
    await getRepository(SeasonRequest).save(
      new SeasonRequest({ seasonNumber: 2, status: RS.FAILED, request }),
      { listeners: false }
    );
    const result = await updateRequestStatus(
      dataSource.manager,
      await latest(request.id),
      RS.APPROVED,
      2
    );
    assert.deepEqual(
      result?.seasons.map((s) => s.status),
      [RS.COMPLETED, RS.APPROVED]
    );
    assert.equal(result?.modifiedBy?.id, 2);
  });
  it('a concurrent completion or deletion defeats a stale approval status write', async () => {
    const request = await seed(MT.TV);
    await getRepository(MediaRequest).update(request.id, {
      status: RS.COMPLETED,
    });
    assert.equal(
      await updateRequestStatus(dataSource.manager, request, RS.APPROVED),
      null
    );
    await getRepository(MediaRequest).delete(request.id);
    assert.equal(
      await updateRequestStatus(dataSource.manager, request, RS.APPROVED),
      null
    );
  });
});

describe('C1 accepted-provider scalar bookkeeping', () => {
  it('does not resave canonical availability, Seasons or a conflicting newer provider link', async () => {
    const request = await seed(MT.TV),
      identity = requestIdentity(request);
    await getRepository(Media).update(request.media.id, {
      status: MS.AVAILABLE,
      serviceId: 8,
      externalServiceId: 202,
    });
    await getRepository(Season).update(request.media.seasons[0].id, {
      status: MS.AVAILABLE,
    });
    await linkAcceptedProviderMedia(
      dataSource.manager,
      identity,
      7,
      101,
      'fixture'
    );
    const media = await getRepository(Media).findOneByOrFail({
      id: request.media.id,
    });
    assert.equal(media.status, MS.AVAILABLE);
    assert.equal(media.seasons[0].status, MS.AVAILABLE);
    assert.equal(media.serviceId, 8);
    assert.equal(media.externalServiceId, 202);
  });
});

describe('C3 approval versus settlement notification ownership', () => {
  it('a scalar approval that reloads Completed does not impersonate the completing transition', async () => {
    const request = await seed(MT.TV),
      repository = getRepository(MediaRequest);
    await repository
      .createQueryBuilder()
      .update(MediaRequest)
      .set({ status: RS.PENDING })
      .where('id = :id', { id: request.id })
      .callListeners(false)
      .execute();
    const pending = await latest(request.id);
    const read = repository.findOneBy.bind(repository);
    let interleave = true;
    const reader = mock.method(
      repository,
      'findOneBy',
      async (...args: Parameters<typeof read>) => {
        if (interleave) {
          interleave = false;
          await repository
            .createQueryBuilder()
            .update(MediaRequest)
            .set({ status: RS.COMPLETED })
            .where('id = :id', { id: request.id })
            .callListeners(false)
            .execute();
        }
        return read(...args);
      }
    );
    const lifecycle = mock.method(
      MediaRequestSubscriber.prototype,
      'handleRequestUpdate',
      async () => undefined
    );
    try {
      const result = await updateRequestStatus(
        dataSource.manager,
        pending,
        RS.APPROVED
      );
      assert.equal(result?.status, RS.COMPLETED);
      assert.equal(lifecycle.mock.callCount(), 0);
      assert.equal(notified.callCount(), 0);
    } finally {
      reader.mock.restore();
      lifecycle.mock.restore();
    }
  });
});
