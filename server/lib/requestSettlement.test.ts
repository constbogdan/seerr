import ExternalAPI from '@server/api/externalapi';
import SonarrAPI, { type SonarrSeries } from '@server/api/servarr/sonarr';
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
import notifications, { Notification } from '@server/lib/notifications';
import {
  observeSonarrSettlement,
  settleSonarrRequests,
} from '@server/lib/requestSettlement';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { JellyfinScanner } from '@server/lib/scanners/jellyfin';
import { plexFullScanner } from '@server/lib/scanners/plex';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import { runWithMockTimers } from '@server/test/runWithMockTimers';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

let serial = 92000,
  metadataTotal = 10,
  seriesReads = 0,
  files = 10,
  total = 10,
  active = true;
mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async () => ({
    id: serial,
    title: 'Synthetic',
    name: 'Synthetic',
    overview: '',
    release_date: '2020-01-01',
    external_ids: { tvdb_id: 500 },
    keywords: { results: [] },
    videos: { results: [{ type: 'Trailer', key: 'fixture' }] },
    seasons: [1, 2].map((season_number) => ({
      season_number,
      episode_count: metadataTotal,
    })),
  })
);
const send = mock.method(
  notifications,
  'sendNotification',
  () => undefined
).mock;
mock.method(MediaRequest, 'sendNotification', async () => undefined);
mock.method(acquisitionMonitor, 'wake', () => undefined);
function source(overrides: Partial<SonarrSettings> = {}): SonarrSettings {
  return {
    id: 7,
    name: 'Synthetic',
    hostname: 'provider.invalid',
    port: 1,
    apiKey: 'fixture-only',
    baseUrl: '',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'Synthetic',
    activeDirectory: '/fixed',
    tags: [],
    is4k: false,
    isDefault: true,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    seriesType: 'standard',
    animeSeriesType: 'standard',
    enableSeasonFolders: true,
    monitorNewItems: 'all',
    ...overrides,
  };
}
function show(overrides: Partial<SonarrSeries> = {}): SonarrSeries {
  return {
    id: 101,
    tvdbId: 500,
    title: 'Synthetic',
    titleSlug: 'synthetic',
    seasons: [
      {
        seasonNumber: 1,
        monitored: true,
        statistics: {
          episodeFileCount: files,
          totalEpisodeCount: total,
          episodeCount: files,
          percentOfEpisodes: 0,
          sizeOnDisk: 0,
        },
      },
    ],
    ...overrides,
  } as SonarrSeries;
}
let seriesResponse: () => Promise<SonarrSeries[]> = async () => [show()];
mock.method(SonarrAPI.prototype, 'getSeries', async () => {
  seriesReads++;
  return seriesResponse();
});
setupTestDb();
beforeEach(() => {
  serial++;
  metadataTotal = 10;
  files = 10;
  total = 10;
  seriesReads = 0;
  active = true;
  getSettings().sonarr = [source()];
  getSettings().radarr = [];
  getSettings().main.enableSpecialEpisodes = false;
  seriesResponse = async () => [show()];
  send.resetCalls();
});
async function seed(
  numbers = [1],
  status = MS.PROCESSING,
  is4k = false,
  owner = 1
) {
  const media =
    (await getRepository(Media).findOneBy({
      tmdbId: serial,
      mediaType: MT.TV,
    })) ??
    (await getRepository(Media).save(
      new Media({
        tmdbId: serial,
        tvdbId: 500,
        mediaType: MT.TV,
        status,
        status4k: is4k ? status : MS.UNKNOWN,
        serviceId: is4k ? undefined : 7,
        externalServiceId: is4k ? undefined : 101,
        serviceId4k: is4k ? 7 : undefined,
        externalServiceId4k: is4k ? 101 : undefined,
        seasons: [1, 2].map(
          (seasonNumber) =>
            new Season({
              seasonNumber,
              status,
              status4k: is4k ? status : MS.UNKNOWN,
            })
        ),
      }),
      { listeners: false }
    ));
  const requestedBy = await getRepository(User).findOneByOrFail({ id: owner });
  return getRepository(MediaRequest).save(
    new MediaRequest({
      media,
      requestedBy,
      type: MT.TV,
      is4k,
      status: RS.APPROVED,
      seasons: numbers.map(
        (seasonNumber) =>
          new SeasonRequest({ seasonNumber, status: RS.APPROVED })
      ),
    }),
    { listeners: false }
  );
}
async function latest(request: MediaRequest) {
  return getRepository(MediaRequest).findOneByOrFail({ id: request.id });
}
async function scan() {
  await runWithMockTimers(() => sonarrScanner.run());
}
const availableNotifications = () =>
  send.calls.filter(
    (call) => call.arguments[0] === Notification.MEDIA_AVAILABLE
  ).length;
function observation(s = show(), server = source()) {
  return observeSonarrSettlement(
    s,
    serial,
    [1, 2].map((season_number) => ({
      season_number,
      episode_count: metadataTotal,
    })),
    server,
    () => active
  );
}

describe('C2 actual Sonarr scan to requested-scope acquisition settlement', () => {
  for (const count of [3, 8, 10])
    it(
      'fresh Sonarr ' + count + '/10 with retained canonical Available',
      async () => {
        const request = await seed([1], MS.AVAILABLE);
        files = count;
        await scan();
        const result = await latest(request);
        assert.equal(result.status, count === 10 ? RS.COMPLETED : RS.APPROVED);
        assert.equal(
          result.seasons[0].status,
          count === 10 ? RS.COMPLETED : RS.APPROVED
        );
        assert.equal(
          (await getRepository(Media).findOneByOrFail({ id: request.media.id }))
            .seasons[0].status,
          MS.AVAILABLE
        );
        assert.equal(seriesReads, 1);
        assert.equal(availableNotifications(), count === 10 ? 1 : 0);
      }
    );
  it('successful unchanged 10/10 settles once without timestamp churn on repeated observations', async () => {
    const request = await seed([1], MS.AVAILABLE);
    await scan();
    const first = await latest(request);
    await scan();
    const second = await latest(request);
    assert.equal(first.status, RS.COMPLETED);
    assert.equal(second.updatedAt.getTime(), first.updatedAt.getTime());
    assert.equal(availableNotifications(), 1);
    assert.equal(seriesReads, 2);
  });
  for (const malformed of [0, -1, NaN, 2.5, undefined])
    it(
      'invalid/missing denominator ' + String(malformed) + ' does not settle',
      async () => {
        const request = await seed([1], MS.AVAILABLE);
        seriesResponse = async () => [
          show({
            seasons: [
              {
                seasonNumber: 1,
                monitored: true,
                statistics: {
                  episodeFileCount: 10,
                  totalEpisodeCount: malformed,
                } as NonNullable<SonarrSeries['seasons'][number]['statistics']>,
              },
            ],
          }),
        ];
        await scan();
        assert.equal((await latest(request)).status, RS.APPROVED);
      }
    );
  it('monitored-only or contradictory smaller denominator cannot qualify', async () => {
    const request = await seed([1], MS.AVAILABLE);
    files = 3;
    total = 3;
    await scan();
    assert.equal((await latest(request)).status, RS.APPROVED);
  });
  it('duplicate Season metadata cannot qualify', async () => {
    const request = await seed([1], MS.AVAILABLE);
    seriesResponse = async () => [
      show({ seasons: [...show().seasons, ...show().seasons] }),
    ];
    await scan();
    assert.equal((await latest(request)).status, RS.APPROVED);
  });
  it('failed provider observation cannot settle stored Available', async () => {
    const request = await seed([1], MS.AVAILABLE);
    seriesResponse = async () => {
      throw Error('Synthetic outage');
    };
    await scan();
    assert.equal((await latest(request)).status, RS.APPROVED);
    assert.equal(seriesReads, 1);
  });
  it('multiple requested Seasons settle independently and preserve prior completion', async () => {
    const request = await seed([1, 2]);
    seriesResponse = async () => [
      show({
        seasons: [
          ...show().seasons,
          {
            seasonNumber: 2,
            monitored: true,
            statistics: {
              episodeFileCount: 3,
              totalEpisodeCount: 10,
              episodeCount: 10,
              percentOfEpisodes: 30,
              sizeOnDisk: 0,
            },
          },
        ],
      }),
    ];
    await scan();
    let result = await latest(request);
    assert.equal(result.status, RS.APPROVED);
    assert.deepEqual(
      result.seasons.map((s) => s.status),
      [RS.COMPLETED, RS.APPROVED]
    );
    seriesResponse = async () => [
      show({
        seasons: [...show().seasons, { ...show().seasons[0], seasonNumber: 2 }],
      }),
    ];
    await scan();
    result = await latest(request);
    assert.equal(result.status, RS.COMPLETED);
    assert.deepEqual(
      result.seasons.map((s) => s.status),
      [RS.COMPLETED, RS.COMPLETED]
    );
    assert.equal(availableNotifications(), 1);
  });
  it('does not cross quality or explicit Sonarr-instance scopes', async () => {
    const standard = await seed([1], MS.AVAILABLE),
      other = await seed([1], MS.AVAILABLE, false, 2);
    await getRepository(MediaRequest).update(other.id, { serverId: 8 });
    const fourK = await seed([1], MS.AVAILABLE, true);
    await scan();
    assert.equal((await latest(standard)).status, RS.COMPLETED);
    assert.equal((await latest(other)).status, RS.APPROVED);
    assert.equal((await latest(fourK)).status, RS.APPROVED);
  });
  it('4K Sonarr evidence settles only 4K and keeps standard unresolved', async () => {
    getSettings().sonarr = [source({ is4k: true })];
    const fourK = await seed([1], MS.AVAILABLE, true),
      standard = await seed([1], MS.AVAILABLE, false, 2);
    await scan();
    assert.equal((await latest(fourK)).status, RS.COMPLETED);
    assert.equal((await latest(standard)).status, RS.APPROVED);
  });
  it('different requesters keep independent owned Season scopes', async () => {
    const first = await seed([1]),
      second = await seed([2], MS.PROCESSING, false, 2);
    await scan();
    assert.equal((await latest(first)).status, RS.COMPLETED);
    assert.equal((await latest(second)).status, RS.APPROVED);
    assert.equal((await latest(first)).requestedBy.id, 1);
    assert.equal((await latest(second)).requestedBy.id, 2);
  });
  it('cancellation/supersession and deleted request fail closed', async () => {
    const request = await seed([1], MS.AVAILABLE);
    const proof = observation();
    active = false;
    assert.equal(await settleSonarrRequests(request.media.id, proof), 0);
    active = true;
    await getRepository(MediaRequest).delete(request.id);
    assert.equal(await settleSonarrRequests(request.media.id, proof), 0);
    assert.equal(await getRepository(MediaRequest).count(), 0);
  });
  it('whole-Series Available suppresses dispatch but cannot complete its requested Season', async () => {
    const request = await seed([1], MS.AVAILABLE);
    await new MediaRequestSubscriber().sendToSonarr(
      request,
      dataSource.manager
    );
    assert.equal((await latest(request)).status, RS.APPROVED);
    assert.equal(seriesReads, 0);
  });
});

async function jellyfinObservation(count: number) {
  const scanner = new JellyfinScanner();
  const fixture = scanner as unknown as {
    jfClient: {
      getItemData: () => Promise<unknown>;
      getSeasons: () => Promise<unknown[]>;
      getEpisodes: () => Promise<unknown[]>;
    };
    processJellyfinShow: (item: {
      Id: string;
      Type: string;
    }) => Promise<boolean>;
  };
  let episodeReads = 0;
  fixture.jfClient = {
    getItemData: async () => ({
      Id: 'fixture-series',
      Type: 'Series',
      ProviderIds: { Tmdb: String(serial) },
    }),
    getSeasons: async () =>
      [1, 2].map((IndexNumber) => ({
        Id: 'season-' + IndexNumber,
        IndexNumber,
      })),
    getEpisodes: async () => {
      episodeReads++;
      return Array.from({ length: count }, (_, i) => ({
        Id: 'episode-' + i,
        Type: 'Episode',
        IndexNumber: i + 1,
        LocationType: 'FileSystem',
      }));
    },
  };
  assert.equal(
    await fixture.processJellyfinShow({ Id: 'fixture-series', Type: 'Series' }),
    true
  );
  return { calls: () => episodeReads };
}

describe('C2 independent media-server scanning compatibility', () => {
  it('Enable Scan disabled: Jellyfin availability works but cannot settle TV acquisition', async () => {
    getSettings().sonarr = [source({ syncEnabled: false })];
    const request = await seed();
    await scan();
    assert.equal(seriesReads, 0);
    await jellyfinObservation(10);
    const media = await getRepository(Media).findOneByOrFail({
      id: request.media.id,
    });
    assert.equal(
      media.seasons.find((s) => s.seasonNumber === 1)?.status,
      MS.AVAILABLE
    );
    assert.equal((await latest(request)).status, RS.APPROVED);
    assert.equal(availableNotifications(), 0);
  });
  it('Enable Scan disabled: Plex availability works but cannot settle TV acquisition', async () => {
    getSettings().sonarr = [source({ syncEnabled: false })];
    const request = await seed();
    const fixture = plexFullScanner as unknown as {
      enable4kShow: boolean;
      plexClient: {
        getMetadata: () => Promise<unknown>;
        getChildrenMetadata: () => Promise<unknown[]>;
      };
      processPlexShow: (item: { ratingKey: string }) => Promise<void>;
    };
    fixture.enable4kShow = false;
    fixture.plexClient = {
      getMetadata: async () => ({
        ratingKey: 'fixture-series',
        guid: 'plex://show/fixture',
        Guid: [{ id: 'tmdb://' + serial }, { id: 'tvdb://500' }],
        title: 'Synthetic',
        Children: {
          Metadata: [1, 2].map((index) => ({
            index,
            ratingKey: 'season-' + index,
          })),
        },
      }),
      getChildrenMetadata: async () =>
        Array.from({ length: 10 }, (_, index) => ({
          index: index + 1,
          Media: [{ videoResolution: '1080' }],
        })),
    };
    await scan();
    await fixture.processPlexShow({ ratingKey: 'fixture-series' });
    const media = await getRepository(Media).findOneByOrFail({
      id: request.media.id,
    });
    assert.equal(
      media.seasons.find((s) => s.seasonNumber === 1)?.status,
      MS.AVAILABLE
    );
    assert.equal((await latest(request)).status, RS.APPROVED);
    assert.equal(seriesReads, 0);
  });
  it('Sonarr 10/10 settles with existing Jellyfin inventory still 9/10, without another Jellyfin read', async () => {
    const request = await seed();
    const reads = await jellyfinObservation(9);
    assert.equal(reads.calls(), 2);
    assert.equal((await latest(request)).status, RS.APPROVED);
    await scan();
    assert.equal((await latest(request)).status, RS.COMPLETED);
    assert.equal(seriesReads, 1);
    assert.equal(reads.calls(), 2);
  });
  it('legacy Deleted closure remains independent of acquisition completion', async () => {
    const request = await seed();
    const media = await getRepository(Media).findOneByOrFail({
      id: request.media.id,
    });
    media.seasons[0].status = MS.DELETED;
    media.status = MS.DELETED;
    await getRepository(Media).save(media);
    assert.equal((await latest(request)).status, RS.COMPLETED);
  });
  it('Movie unchanged positive observation preserves quality-specific settlement', async () => {
    const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: serial,
        mediaType: MT.MOVIE,
        status: MS.AVAILABLE,
        status4k: MS.UNKNOWN,
      }),
      { listeners: false }
    );
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy,
        type: MT.MOVIE,
        is4k: false,
        status: RS.APPROVED,
      }),
      { listeners: false }
    );
    class Scanner extends BaseScanner<never> {
      constructor() {
        super('Isolated Movie');
      }
      observe() {
        return this.processMovie(serial, { hasFile: true });
      }
    }
    await new Scanner().observe();
    assert.equal((await latest(request)).status, RS.COMPLETED);
  });
});

describe('C2 conditional-write and operation-local evidence boundaries', () => {
  it('concurrent duplicate observations yield one parent transition and notification', async () => {
    const request = await seed([1], MS.AVAILABLE);
    const evidence = observation();
    const results = await Promise.all([
      settleSonarrRequests(request.media.id, evidence),
      settleSonarrRequests(request.media.id, evidence),
    ]);
    assert.equal(
      results.reduce((a, b) => a + b, 0),
      1
    );
    assert.equal((await latest(request)).status, RS.COMPLETED);
    assert.equal(availableNotifications(), 1);
  });
  it('expired evidence after candidate lookup cannot write child completion', async () => {
    const request = await seed([1], MS.AVAILABLE);
    let checks = 0;
    const evidence = observeSonarrSettlement(
      show(),
      serial,
      [{ season_number: 1, episode_count: 10 }],
      source(),
      () => ++checks === 1
    );
    assert.equal(await settleSonarrRequests(request.media.id, evidence), 0);
    assert.equal((await latest(request)).seasons[0].status, RS.APPROVED);
  });
  it('source reconfiguration/disablement invalidates captured evidence', async () => {
    const request = await seed([1], MS.AVAILABLE),
      evidence = observation();
    getSettings().sonarr = [source({ syncEnabled: false })];
    assert.equal(await settleSonarrRequests(request.media.id, evidence), 0);
    assert.equal((await latest(request)).status, RS.APPROVED);
  });
  it('wrong source Series and Partial canonical Season cannot qualify', async () => {
    const request = await seed([1], MS.PARTIALLY_AVAILABLE);
    assert.equal(
      await settleSonarrRequests(request.media.id, observation()),
      0
    );
    assert.equal(
      await settleSonarrRequests(
        request.media.id,
        observation(show({ id: 202 }))
      ),
      0
    );
    assert.equal((await latest(request)).seasons[0].status, RS.APPROVED);
  });
  it('empty request scope cannot complete by vacuous truth', async () => {
    const request = await seed([], MS.AVAILABLE);
    assert.equal(
      await settleSonarrRequests(request.media.id, observation()),
      0
    );
    assert.equal((await latest(request)).status, RS.APPROVED);
  });
  it('malformed file counts and duplicate expected Seasons are invalid evidence', async () => {
    for (const count of [-1, NaN, 11, 1.5]) {
      const evidence = observation(
        show({
          seasons: [
            {
              ...show().seasons[0],
              statistics: {
                ...show().seasons[0].statistics!,
                episodeFileCount: count,
              },
            },
          ],
        })
      );
      assert.equal(evidence.seasons[0].valid, false);
    }
    const evidence = observeSonarrSettlement(
      show(),
      serial,
      [
        { season_number: 1, episode_count: 10 },
        { season_number: 1, episode_count: 10 },
      ],
      source(),
      () => true
    );
    assert.equal(evidence.seasons[0].valid, false);
  });
});

describe('C2 legacy Deleted closure compatibility', () => {
  for (const firstStatus of [MS.AVAILABLE, MS.UNKNOWN])
    it(
      'previously Completed child with canonical status ' + firstStatus,
      async () => {
        const request = await seed([1, 2]);
        await getRepository(SeasonRequest).update(request.seasons[0].id, {
          status: RS.COMPLETED,
        });
        const media = await getRepository(Media).findOneByOrFail({
          id: request.media.id,
        });
        media.seasons.find((s) => s.seasonNumber === 1)!.status = firstStatus;
        media.seasons.find((s) => s.seasonNumber === 2)!.status = MS.DELETED;
        media.status = MS.DELETED;
        await getRepository(Media).save(media);
        const result = await latest(request);
        assert.deepEqual(
          result.seasons.map((s) => s.status),
          [RS.COMPLETED, RS.COMPLETED]
        );
        assert.equal(
          result.status,
          firstStatus === MS.AVAILABLE ? RS.COMPLETED : RS.APPROVED
        );
      }
    );
});
