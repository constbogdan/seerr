import ExternalAPI from '@server/api/externalapi';
import RadarrAPI, {
  type RadarrMovie,
  type RadarrMovieOptions,
} from '@server/api/servarr/radarr';
import SonarrAPI, {
  type AddSeriesOptions,
  type SonarrSeries,
} from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type { OverflowSettings } from '@server/constants/overflow';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import { getSettings } from '@server/lib/settings';
import type {
  PhysicalVolume,
  StorageDiscoveryResult,
  StorageLocation,
} from '@server/lib/storageSettings';
import * as storageModule from '@server/lib/storageSettings';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

const gib = 1024 ** 3;
const location = (
  provider: 'radarr' | 'sonarr',
  rootFolderId: number,
  path: string,
  isAnimation = false
): StorageLocation => ({
  id: `${provider}:0:root:${rootFolderId}`,
  provider,
  serviceId: 0,
  serviceName: provider,
  rootFolderId,
  name: `Root ${rootFolderId}`,
  path,
  color: null,
  isAnimation,
  diskSpacePath: path.split('/').slice(0, 2).join('/'),
  totalSpace: 200 * gib,
  usedSpace: 100 * gib,
  freeSpace: 100 * gib,
  usedPercentage: 50,
  accessible: true,
  routable: true,
});
const movieSource = location('radarr', 9, '/volume1/movies');
const movieTarget = location('radarr', 12, '/volume9/movies');
const movieDocumentary = location('radarr', 14, '/volume9/documentaries');
const seriesSource = location('sonarr', 7, '/volume3/shows');
const seriesTarget = location('sonarr', 9, '/volume9/shows');
const docuseriesSource = location('sonarr', 11, '/volume3/docuseries');
const docuseriesTarget = location('sonarr', 10, '/volume9/docuseries');
const volume = (
  id: string,
  members: StorageLocation[],
  freeSpace: number
): PhysicalVolume => ({
  id,
  name: id,
  volumeKey: id.replace('physical:', ''),
  locationIds: members.map((member) => member.id),
  segments: [],
  totalSpace: 200 * gib,
  usedSpace: 200 * gib - freeSpace,
  freeSpace,
  usedPercentage: 100 - (freeSpace / (200 * gib)) * 100,
  knownLibraryUsageBytes: '0',
  pendingRemovalBytes: '0',
  pendingRemovalPercentage: null,
  pendingRemovalAvailable: true,
  pendingRemovalComplete: true,
  omittedRemovalScheduleCount: 0,
  unaccountedUsageBytes: '0',
  provisionedSpaceBytes: null,
  usageExceedsPhysical: false,
  capacityReadingsDiffer: false,
  accessible: true,
});
const storage: StorageDiscoveryResult = {
  locations: [
    movieSource,
    movieTarget,
    movieDocumentary,
    seriesSource,
    seriesTarget,
    docuseriesSource,
    docuseriesTarget,
  ],
  volumes: [
    volume('physical:volume1', [movieSource], 6.3 * gib),
    volume('physical:volume3', [seriesSource, docuseriesSource], 6.3 * gib),
    volume(
      'physical:volume9',
      [movieTarget, movieDocumentary, seriesTarget, docuseriesTarget],
      100 * gib
    ),
  ],
  instances: [
    {
      provider: 'radarr',
      serviceId: 0,
      serviceName: 'Radarr',
      available: true,
      capacityAvailable: true,
    },
    {
      provider: 'sonarr',
      serviceId: 0,
      serviceName: 'Sonarr',
      available: true,
      capacityAvailable: true,
    },
  ],
  refreshedAt: '2026-11-21T00:00:00.000Z',
};
const overflow: OverflowSettings = {
  enabled: true,
  freeSpaceThreshold: 10,
  automaticSeriesPlacement: true,
  defaultSeriesVolumeId: 'physical:volume3',
  expansionSeriesVolumeId: 'physical:volume9',
  seriesSeasonThreshold: 3,
  torrentRelocationDelayHours: 48,
  routes: [
    {
      sourceVolumeId: 'physical:volume1',
      destinationVolumeId: 'physical:volume9',
      thresholdGb: 50,
      enabled: true,
      rootMappings: [
        {
          sourceLocationId: movieSource.id,
          destinationLocationId: movieTarget.id,
        },
      ],
    },
    {
      sourceVolumeId: 'physical:volume3',
      destinationVolumeId: 'physical:volume9',
      thresholdGb: 50,
      enabled: true,
      rootMappings: [
        {
          sourceLocationId: seriesSource.id,
          destinationLocationId: seriesTarget.id,
        },
      ],
    },
  ],
  seriesRootPreferences: [
    {
      sourceLocationId: seriesSource.id,
      destinationVolumeId: 'physical:volume9',
      destinationLocationId: seriesTarget.id,
    },
  ],
};

let currentStorage = storage;
let existingMovie = {
  id: 0,
  tags: [],
  hasFile: false,
} as unknown as RadarrMovie;
let existingSeries = { id: 0, tags: [] } as unknown as SonarrSeries;
let providerTags = [
  { id: 1, label: 'internal' },
  { id: 2, label: 'external' },
];
mock.method(
  storageModule,
  'discoverStorageLocations',
  async () => currentStorage
);
mock.method(
  ExternalAPI.prototype as unknown as {
    get: (endpoint: string) => Promise<unknown>;
  },
  'get',
  async (endpoint: string) => ({
    id: Number(endpoint.split('/').pop()),
    title: 'Synthetic',
    name: 'Synthetic',
    release_date: '2008-01-01',
    external_ids: { tvdb_id: 187 },
    keywords: { results: [] },
    videos: { results: [] },
    seasons: [{ season_number: 1, episode_count: 10 }],
  })
);
mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => existingMovie);
mock.method(
  SonarrAPI.prototype,
  'getSeriesByTvdbId',
  async () => existingSeries
);
for (const provider of [RadarrAPI, SonarrAPI]) {
  Object.defineProperty(provider.prototype, 'getTags', {
    configurable: true,
    set() {},
    get() {
      return async () => providerTags;
    },
  });
}
mock.method(acquisitionMonitor, 'wake', () => undefined);

let movieOptions: RadarrMovieOptions | undefined;
let seriesOptions: AddSeriesOptions | undefined;
Object.defineProperty(RadarrAPI.prototype, 'addMovie', {
  configurable: true,
  set() {},
  get() {
    return (options: RadarrMovieOptions) => {
      movieOptions = options;
      return new Promise<RadarrMovie>(() => undefined);
    };
  },
});
mock.method(
  SonarrAPI.prototype,
  'addSeries',
  async (options: AddSeriesOptions) => {
    seriesOptions = options;
    return new Promise<SonarrSeries>(() => undefined);
  }
);

setupTestDb();
let tmdbId = 199000;
beforeEach(() => {
  movieOptions = undefined;
  seriesOptions = undefined;
  currentStorage = storage;
  existingMovie = { id: 0, tags: [], hasFile: false } as unknown as RadarrMovie;
  existingSeries = { id: 0, tags: [] } as unknown as SonarrSeries;
  providerTags = [
    { id: 1, label: 'internal' },
    { id: 2, label: 'external' },
  ];
  const settings = getSettings();
  settings.overflow = structuredClone(overflow);
  settings.radarr = [
    {
      id: 0,
      name: 'Radarr',
      hostname: 'provider.invalid',
      port: 1,
      apiKey: 'fixture-only',
      baseUrl: '',
      useSsl: false,
      is4k: false,
      isDefault: true,
      activeProfileId: 1,
      activeProfileName: 'Synthetic',
      activeDirectory: movieSource.path,
      tags: [],
      minimumAvailability: 'released',
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
    },
  ];
  settings.sonarr = [
    {
      id: 0,
      name: 'Sonarr',
      hostname: 'provider.invalid',
      port: 1,
      apiKey: 'fixture-only',
      baseUrl: '',
      useSsl: false,
      is4k: false,
      isDefault: true,
      activeProfileId: 1,
      activeProfileName: 'Synthetic',
      activeDirectory: seriesSource.path,
      tags: [],
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      seriesType: 'standard',
      animeSeriesType: 'standard',
      enableSeasonFolders: true,
      monitorNewItems: 'all',
    },
  ];
});

async function request(
  type: MediaType,
  rootFolder?: string,
  seasons = [1]
): Promise<MediaRequest> {
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: ++tmdbId,
      tvdbId: 187,
      mediaType: type,
      status: MediaStatus.PROCESSING,
    }),
    { listeners: false }
  );
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 1 });
  return getRepository(MediaRequest).save(
    new MediaRequest({
      type,
      media,
      requestedBy,
      status: MediaRequestStatus.APPROVED,
      rootFolder,
      seasons:
        type === MediaType.TV
          ? seasons.map(
              (seasonNumber) =>
                new SeasonRequest({
                  seasonNumber,
                  status: MediaRequestStatus.APPROVED,
                })
            )
          : [],
    }),
    { listeners: false }
  );
}

describe('Storage Routing intercepts the effective root at provider dispatch', () => {
  it('routes a populated Movie source root to the mapped Radarr root', async () => {
    await new MediaRequestSubscriber().sendToRadarr(
      await request(MediaType.MOVIE, movieSource.path),
      dataSource.manager
    );
    assert.equal(movieOptions?.rootFolderPath, movieTarget.path);
  });

  it('routes a null-root Movie through the same configured source', async () => {
    await new MediaRequestSubscriber().sendToRadarr(
      await request(MediaType.MOVIE),
      dataSource.manager
    );
    assert.equal(movieOptions?.rootFolderPath, movieTarget.path);
  });

  it('preserves an off-scope Documentary root at the Radarr boundary', async () => {
    await new MediaRequestSubscriber().sendToRadarr(
      await request(MediaType.MOVIE, movieDocumentary.path),
      dataSource.manager
    );
    assert.equal(movieOptions?.rootFolderPath, movieDocumentary.path);
  });

  it('retains the effective Movie root when routing tags are unavailable', async () => {
    providerTags = [{ id: 1, label: 'internal' }];
    await new MediaRequestSubscriber().sendToRadarr(
      await request(MediaType.MOVIE, movieSource.path),
      dataSource.manager
    );
    assert.equal(movieOptions?.rootFolderPath, movieSource.path);
  });

  it('does not relocate an existing Movie with files', async () => {
    existingMovie = {
      id: 77,
      tags: [],
      hasFile: true,
    } as unknown as RadarrMovie;
    await new MediaRequestSubscriber().sendToRadarr(
      await request(MediaType.MOVIE, movieSource.path),
      dataSource.manager
    );
    assert.equal(movieOptions?.rootFolderPath, movieSource.path);
  });

  it('routes a defaulted one-season Series with 6.3 GB free to Volume 9 Shows', async () => {
    await new MediaRequestSubscriber().sendToSonarr(
      await request(MediaType.TV, seriesSource.path),
      dataSource.manager
    );
    assert.equal(seriesOptions?.rootFolderPath, seriesTarget.path);
  });

  it('routes a null-root Series through the same default source', async () => {
    await new MediaRequestSubscriber().sendToSonarr(
      await request(MediaType.TV),
      dataSource.manager
    );
    assert.equal(seriesOptions?.rootFolderPath, seriesTarget.path);
  });

  for (const [label, previousStatus] of [
    ['pending', MediaRequestStatus.PENDING],
    ['failed', MediaRequestStatus.FAILED],
  ] as const) {
    it(`evaluates current capacity only when a ${label} Series is approved for dispatch`, async () => {
      const pending = await request(MediaType.TV, seriesSource.path);
      pending.status = previousStatus;
      const persistStatus = async (status: MediaRequestStatus) => {
        await getRepository(MediaRequest)
          .createQueryBuilder()
          .update(MediaRequest)
          .set({ status })
          .where('id = :id', { id: pending.id })
          .callListeners(false)
          .execute();
      };
      await persistStatus(previousStatus);
      currentStorage = {
        ...storage,
        volumes: storage.volumes.map((candidate) =>
          candidate.id === 'physical:volume3'
            ? { ...candidate, freeSpace: 100 * gib, usedSpace: 100 * gib }
            : candidate
        ),
      };
      const subscriber = new MediaRequestSubscriber();
      await subscriber.sendToSonarr(pending, dataSource.manager);
      const optionsBeforeApproval = seriesOptions;
      assert.equal(optionsBeforeApproval, undefined);

      pending.status = MediaRequestStatus.APPROVED;
      await persistStatus(MediaRequestStatus.APPROVED);
      currentStorage = storage;
      await subscriber.sendToSonarr(pending, dataSource.manager);
      assert.equal(seriesOptions?.rootFolderPath, seriesTarget.path);
    });
  }

  it('uses the expansion root for three seasons even above the default volume threshold', async () => {
    currentStorage = {
      ...storage,
      volumes: storage.volumes.map((candidate) =>
        candidate.id === 'physical:volume3'
          ? { ...candidate, freeSpace: 100 * gib, usedSpace: 100 * gib }
          : candidate
      ),
    };
    await new MediaRequestSubscriber().sendToSonarr(
      await request(MediaType.TV, seriesSource.path, [1, 2, 3]),
      dataSource.manager
    );
    assert.equal(seriesOptions?.rootFolderPath, seriesTarget.path);
  });

  it('does not replace the root of an existing Sonarr series', async () => {
    existingSeries = { id: 187, tags: [] } as unknown as SonarrSeries;
    await new MediaRequestSubscriber().sendToSonarr(
      await request(MediaType.TV, seriesSource.path),
      dataSource.manager
    );
    assert.equal(seriesOptions?.rootFolderPath, seriesSource.path);
  });

  it('preserves an off-scope Docuseries root at the Sonarr boundary', async () => {
    await new MediaRequestSubscriber().sendToSonarr(
      await request(MediaType.TV, docuseriesSource.path),
      dataSource.manager
    );
    assert.equal(seriesOptions?.rootFolderPath, docuseriesSource.path);
  });
});
