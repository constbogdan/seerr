import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiskSpace, RootFolder } from '@server/api/servarr/base';
import type { OverflowVolumeRoute } from '@server/constants/overflow';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import {
  discoverStorageLocations,
  groupPhysicalVolumes,
  validateOverflowRouteLocations,
  type StorageDiscoveryDependencies,
  type StorageLocation,
} from '@server/lib/storageSettings';

const base = {
  hostname: 'localhost',
  apiKey: 'not-returned',
  useSsl: false,
  baseUrl: '',
  activeProfileId: 1,
  activeProfileName: 'HD',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
};

const radarr = {
  ...base,
  id: 1,
  name: 'Movies',
  port: 7878,
  activeDirectory: '/volume1/media-movies',
  minimumAvailability: 'released',
} as RadarrSettings;

const sonarr = {
  ...base,
  id: 2,
  name: 'Shows',
  port: 8989,
  activeDirectory: '/volume3/media-shows',
  seriesType: 'standard',
  animeSeriesType: 'anime',
  enableSeasonFolders: true,
  monitorNewItems: 'all',
} as SonarrSettings;

const root = (id: number, path: string): RootFolder => ({
  id,
  path,
  totalSpace: 0,
  freeSpace: 0,
  unmappedFolders: [],
});

const disk = (
  path: string,
  totalSpace: number,
  freeSpace: number
): DiskSpace => ({ path, totalSpace, freeSpace });

const dependencies = (
  options: {
    failSonarrRoots?: boolean;
    failSonarrCapacity?: boolean;
    contradictorySharedCapacity?: boolean;
    sharedFreeSpaceDrift?: boolean;
  } = {}
): StorageDiscoveryDependencies => ({
  getStoredRoots: async (provider) =>
    provider === 'radarr'
      ? [
          {
            sourceRootId: 10,
            path: '/volume1/media-movies',
            displayName: 'Movies',
            color: '#60a5fa',
            isAnimation: false,
          },
          {
            sourceRootId: 12,
            path: '/volume1/media-animation',
            displayName: 'Animation',
            color: '#facc15',
            isAnimation: true,
          },
          {
            sourceRootId: 11,
            path: '/volume4/media-movies',
            displayName: 'Movies',
            color: '#4ade80',
            isAnimation: false,
          },
          {
            sourceRootId: 13,
            path: '/volume4/media-animation',
            displayName: 'Animation',
            color: '#c084fc',
            isAnimation: true,
          },
          {
            sourceRootId: 14,
            path: '/volume7/documentaries',
            displayName: 'Documentaries',
            color: null,
            isAnimation: false,
          },
        ]
      : [
          {
            sourceRootId: 20,
            path: '/volume3/media-shows',
            displayName: 'Shows',
            color: '#22d3ee',
            isAnimation: false,
          },
          {
            sourceRootId: 22,
            path: '/volume3/media-animation',
            displayName: 'Animation',
            color: '#fb923c',
            isAnimation: true,
          },
          {
            sourceRootId: 21,
            path: '/volume4/media-shows',
            displayName: 'Shows',
            color: '#2dd4bf',
            isAnimation: false,
          },
          {
            sourceRootId: 23,
            path: '/volume4/media-animation',
            displayName: 'Animation',
            color: '#c084fc',
            isAnimation: true,
          },
        ],
  getFreshRoots: async (provider) => {
    if (provider === 'sonarr' && options.failSonarrRoots)
      throw new Error('offline');
    return provider === 'radarr'
      ? [
          root(10, '/volume1/media-movies'),
          root(12, '/volume1/media-animation'),
          root(11, '/volume4/media-movies'),
          root(13, '/volume4/media-animation'),
          root(14, '/volume7/documentaries'),
        ]
      : [
          root(20, '/volume3/media-shows'),
          root(22, '/volume3/media-animation'),
          root(21, '/volume4/media-shows'),
          root(23, '/volume4/media-animation'),
        ];
  },
  getFreshDiskSpace: async (provider) => {
    if (provider === 'sonarr' && options.failSonarrCapacity)
      throw new Error('offline');
    return provider === 'radarr'
      ? [
          disk('/volume1', 1_000, 400),
          disk('/volume4', 2_000, 1_200),
          disk('/volume7', 3_000, 2_500),
        ]
      : [
          disk('/volume3', 800, 200),
          disk(
            '/volume4',
            options.contradictorySharedCapacity ? 2_100 : 2_000,
            options.sharedFreeSpaceDrift ? 1_190 : 1_200
          ),
        ];
  },
  getLibraryUsage: async () => ({
    roots: [
      { provider: 'radarr', serviceId: 1, sourceRootId: 10, sizeBytes: '100' },
      { provider: 'radarr', serviceId: 1, sourceRootId: 12, sizeBytes: '40' },
      {
        provider: 'radarr',
        serviceId: 1,
        sourceRootId: 11,
        sizeBytes: '100',
        pendingRemovalBytes: '20',
      },
      { provider: 'radarr', serviceId: 1, sourceRootId: 13, sizeBytes: '50' },
      { provider: 'radarr', serviceId: 1, sourceRootId: 14, sizeBytes: '300' },
      { provider: 'sonarr', serviceId: 2, sourceRootId: 20, sizeBytes: '250' },
      { provider: 'sonarr', serviceId: 2, sourceRootId: 22, sizeBytes: '100' },
      {
        provider: 'sonarr',
        serviceId: 2,
        sourceRootId: 21,
        sizeBytes: '200',
        pendingRemovalBytes: '50',
      },
      { provider: 'sonarr', serviceId: 2, sourceRootId: 23, sizeBytes: '75' },
    ],
    pendingRemovalAvailable: true,
    pendingRemovalComplete: true,
    omittedScheduleCount: 0,
  }),
  now: () => new Date('2026-10-16T08:00:00.000Z'),
});

const location = (
  id: string,
  provider: 'radarr' | 'sonarr',
  rootFolderId: number,
  path: string,
  totalSpace: number | null,
  freeSpace: number | null
): StorageLocation => ({
  id,
  provider,
  serviceId: provider === 'radarr' ? 1 : 2,
  serviceName: provider === 'radarr' ? 'Movies' : 'Shows',
  rootFolderId,
  name: path.split('/').at(-1) ?? provider,
  path,
  color: null,
  diskSpacePath: totalSpace === null ? null : path,
  totalSpace,
  usedSpace:
    totalSpace === null || freeSpace === null ? null : totalSpace - freeSpace,
  freeSpace,
  usedPercentage:
    totalSpace === null || freeSpace === null
      ? null
      : ((totalSpace - freeSpace) / totalSpace) * 100,
  accessible: totalSpace !== null,
  routable: true,
});

describe('Storage settings dynamic discovery', () => {
  it('keeps every root as a distinct dynamic segment on shared volumes', async () => {
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies()
    );

    assert.equal(result.locations.length, 9);
    assert.equal(result.refreshedAt, '2026-10-16T08:00:00.000Z');
    assert.deepEqual(
      result.volumes.map((volume) => volume.name),
      ['Volume 1', 'Volume 3', 'Volume 4', 'Volume 7']
    );
    const shared = result.volumes.find(
      (volume) => volume.volumeKey === 'volume4'
    );
    assert.ok(shared);
    assert.deepEqual(
      shared.segments.map((segment) => ({
        provider: segment.provider,
        root: segment.rootFolderId,
        label: segment.label,
        bytes: segment.indexedUsageBytes,
        percentage: segment.percentage,
        pending: segment.pendingRemovalBytes,
        pendingPercentage: segment.pendingRemovalPercentage,
      })),
      [
        {
          provider: 'radarr',
          root: 11,
          label: 'Movies',
          bytes: '100',
          percentage: 5,
          pending: '20',
          pendingPercentage: 20,
        },
        {
          provider: 'radarr',
          root: 13,
          label: 'Animation',
          bytes: '50',
          percentage: 2.5,
          pending: '0',
          pendingPercentage: 0,
        },
        {
          provider: 'sonarr',
          root: 21,
          label: 'Shows',
          bytes: '200',
          percentage: 10,
          pending: '50',
          pendingPercentage: 25,
        },
        {
          provider: 'sonarr',
          root: 23,
          label: 'Animation',
          bytes: '75',
          percentage: 3.75,
          pending: '0',
          pendingPercentage: 0,
        },
      ]
    );
    assert.equal(
      shared.segments.filter(({ label }) => label === 'Animation').length,
      2
    );
    assert.equal(new Set(shared.segments.map(({ color }) => color)).size, 4);
    assert.equal(shared.knownLibraryUsageBytes, '425');
    assert.equal(shared.pendingRemovalBytes, '70');
    assert.equal(shared.pendingRemovalPercentage, (70 / 425) * 100);
    assert.equal(shared.unaccountedUsageBytes, '375');
    assert.equal(shared.totalSpace, 2_000);
    assert.equal(shared.freeSpace, 1_200);
    assert.equal(shared.usedSpace, 800);
    assert.equal(shared.capacityReadingsDiffer, false);
  });

  it('associates disk-space facts by the longest filesystem-path prefix', async () => {
    const custom = dependencies();
    custom.getFreshDiskSpace = async () => [
      disk('/volume1', 5_000, 4_000),
      disk('/volume1/media-movies', 1_000, 400),
      disk('/volume4', 2_000, 1_200),
      disk('/volume7', 3_000, 2_500),
    ];
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [] },
      custom
    );
    const movies = result.locations.find(
      ({ rootFolderId }) => rootFolderId === 10
    );
    const animation = result.locations.find(
      ({ rootFolderId }) => rootFolderId === 12
    );
    assert.equal(movies?.diskSpacePath, '/volume1/media-movies');
    assert.equal(movies?.totalSpace, 1_000);
    assert.equal(animation?.diskSpacePath, '/volume1');
    assert.equal(animation?.totalSpace, 5_000);
  });

  it('uses the minimum free-space reading when shared-volume totals and identities agree', async () => {
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies({ sharedFreeSpaceDrift: true })
    );
    const shared = result.volumes.find(
      ({ volumeKey }) => volumeKey === 'volume4'
    );
    assert.equal(shared?.totalSpace, 2_000);
    assert.equal(shared?.freeSpace, 1_190);
    assert.equal(shared?.usedSpace, 810);
    assert.equal(shared?.usedPercentage, 40.5);
    assert.equal(shared?.capacityReadingsDiffer, false);
    assert.equal(shared?.accessible, true);
  });

  it('uses successful provider discovery as the active root inventory while preserving stored metadata', async () => {
    const custom = dependencies();
    const getStoredRoots = custom.getStoredRoots;
    custom.getStoredRoots = async (provider, serviceId) => [
      ...(await getStoredRoots(provider, serviceId)),
      ...(provider === 'radarr'
        ? [
            {
              sourceRootId: 6,
              path: '/media/movies',
              displayName: 'Historical Movies',
              color: '#ef4444',
            },
          ]
        : [
            {
              sourceRootId: 1,
              path: '/media/shows',
              displayName: 'Historical Shows',
              color: '#f97316',
            },
            {
              sourceRootId: 3,
              path: '/volume4/media-shows-old',
              displayName: 'Historical Shows External',
              color: '#eab308',
            },
          ]),
    ];

    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      custom
    );

    assert.equal(result.locations.length, 9);
    assert.ok(
      result.locations.every(
        ({ path }) =>
          path !== '/media/movies' &&
          path !== '/media/shows' &&
          path !== '/volume4/media-shows-old'
      )
    );
    assert.deepEqual(
      result.volumes.map(({ name }) => name),
      ['Volume 1', 'Volume 3', 'Volume 4', 'Volume 7']
    );
    const shared = result.volumes.find(
      ({ volumeKey }) => volumeKey === 'volume4'
    );
    assert.equal(shared?.segments.length, 4);
    assert.equal(shared?.accessible, true);
    assert.equal(shared?.totalSpace, 2_000);
    assert.equal(shared?.freeSpace, 1_200);
    assert.equal(
      result.locations.find(({ rootFolderId }) => rootFolderId === 11)?.color,
      '#4ade80'
    );
  });

  it('keeps unrecognized paths separate even when capacities match', () => {
    const volumes = groupPhysicalVolumes(
      [
        location('radarr:1:root:30', 'radarr', 30, '/legacy/a', 1_000, 400),
        location('sonarr:2:root:31', 'sonarr', 31, '/legacy/b', 1_000, 400),
      ],
      []
    );
    assert.equal(volumes.length, 2);
    assert.ok(volumes.every((volume) => volume.volumeKey === null));
  });

  it('marks missing and contradictory physical capacity unavailable', async () => {
    const missing = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies({ failSonarrCapacity: true })
    );
    assert.equal(
      missing.volumes.find(({ volumeKey }) => volumeKey === 'volume3')
        ?.accessible,
      false
    );
    assert.equal(
      missing.instances.find(({ provider }) => provider === 'sonarr')
        ?.capacityAvailable,
      false
    );

    const contradictory = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies({ contradictorySharedCapacity: true })
    );
    const shared = contradictory.volumes.find(
      ({ volumeKey }) => volumeKey === 'volume4'
    );
    assert.equal(shared?.capacityReadingsDiffer, true);
    assert.equal(shared?.accessible, false);
    assert.equal(shared?.totalSpace, null);
    assert.ok(shared?.segments.every(({ percentage }) => percentage === null));
  });

  it('fails closed for invalid free space and a disk path from another physical volume', () => {
    const valid = location(
      'radarr:1:root:30',
      'radarr',
      30,
      '/volume9/media-movies',
      2_000,
      1_200
    );
    const invalidFree = {
      ...location(
        'sonarr:2:root:31',
        'sonarr',
        31,
        '/volume9/media-shows',
        2_000,
        1_200
      ),
      freeSpace: 2_001,
    };
    const invalidCapacity = groupPhysicalVolumes([valid, invalidFree], [])[0];
    assert.equal(invalidCapacity.accessible, false);
    assert.equal(invalidCapacity.totalSpace, null);

    const wrongDiskPath = {
      ...invalidFree,
      freeSpace: 1_200,
      diskSpacePath: '/volume8/media-shows',
    };
    const contradictoryIdentity = groupPhysicalVolumes(
      [valid, wrongDiskPath],
      []
    )[0];
    assert.equal(contradictoryIdentity.capacityReadingsDiffer, true);
    assert.equal(contradictoryIdentity.accessible, false);
    assert.equal(contradictoryIdentity.totalSpace, null);
  });

  it('reports Library usage exceeding physical usage without redistribution', () => {
    const volume = groupPhysicalVolumes(
      [
        location(
          'sonarr:2:root:21',
          'sonarr',
          21,
          '/volume4/media-shows',
          1_000,
          900
        ),
      ],
      [
        {
          provider: 'sonarr',
          serviceId: 2,
          sourceRootId: 21,
          sizeBytes: '400',
        },
      ]
    )[0];
    assert.equal(volume.knownLibraryUsageBytes, '400');
    assert.equal(volume.usedSpace, 100);
    assert.equal(volume.unaccountedUsageBytes, null);
    assert.equal(volume.usageExceedsPhysical, true);
  });

  it('keeps Pending Removal inside occupied usage and reports unavailable projection state', () => {
    const candidate = location(
      'radarr:1:root:10',
      'radarr',
      10,
      '/volume1/media-movies',
      1_000,
      400
    );
    const pending = groupPhysicalVolumes([candidate], {
      roots: [
        {
          provider: 'radarr',
          serviceId: 1,
          sourceRootId: 10,
          sizeBytes: '300',
          pendingRemovalBytes: '75',
        },
      ],
      pendingRemovalAvailable: true,
      pendingRemovalComplete: true,
      omittedScheduleCount: 0,
    })[0];
    assert.equal(pending.usedSpace, 600);
    assert.equal(pending.freeSpace, 400);
    assert.equal(pending.knownLibraryUsageBytes, '300');
    assert.equal(pending.pendingRemovalBytes, '75');
    assert.equal(pending.pendingRemovalPercentage, 25);
    assert.equal(pending.unaccountedUsageBytes, '300');
    assert.equal(pending.segments[0].percentage, 30);
    assert.equal(pending.segments[0].pendingRemovalPercentage, 25);

    const unavailable = groupPhysicalVolumes([candidate], {
      roots: [
        {
          provider: 'radarr',
          serviceId: 1,
          sourceRootId: 10,
          sizeBytes: '300',
          pendingRemovalBytes: null,
        },
      ],
      pendingRemovalAvailable: false,
      pendingRemovalComplete: false,
      omittedScheduleCount: 0,
    })[0];
    assert.equal(unavailable.pendingRemovalBytes, null);
    assert.equal(unavailable.pendingRemovalPercentage, null);
    assert.equal(unavailable.segments[0].pendingRemovalBytes, null);
    assert.equal(unavailable.usedSpace, 600);
    assert.equal(unavailable.freeSpace, 400);
  });

  it('retains known roots when a provider is inaccessible', async () => {
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies({ failSonarrRoots: true, failSonarrCapacity: true })
    );
    const shows = result.locations.filter(
      (candidate) => candidate.provider === 'sonarr'
    );
    assert.ok(shows.length > 0);
    assert.ok(
      shows.every((candidate) => !candidate.accessible && !candidate.routable)
    );
    assert.equal(
      result.instances.find(({ provider }) => provider === 'sonarr')?.available,
      false
    );
  });

  it('validates compatible volume routes and fails closed on outages', async () => {
    const route: OverflowVolumeRoute = {
      sourceVolumeId: 'physical:volume1',
      destinationVolumeId: 'physical:volume4',
      thresholdGb: 50,
      enabled: true,
    };
    const available = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies()
    );
    assert.deepEqual(validateOverflowRouteLocations([route], available), {
      valid: true,
    });
    const volume9Discovery = structuredClone(available);
    const sharedTarget = volume9Discovery.volumes.find(
      (volume) => volume.id === 'physical:volume4'
    );
    assert.ok(sharedTarget);
    sharedTarget.id = 'physical:volume9';
    sharedTarget.volumeKey = 'volume9';
    sharedTarget.name = 'Volume 9';
    assert.deepEqual(
      validateOverflowRouteLocations(
        [
          { ...route, destinationVolumeId: 'physical:volume9' },
          {
            ...route,
            sourceVolumeId: 'physical:volume3',
            destinationVolumeId: 'physical:volume9',
          },
        ],
        volume9Discovery
      ),
      { valid: true }
    );
    assert.deepEqual(
      validateOverflowRouteLocations(
        [{ ...route, destinationVolumeId: 'physical:volume99' }],
        available
      ),
      {
        valid: false,
        status: 400,
        message: 'A referenced physical volume does not exist.',
      }
    );

    const unavailable = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies({ failSonarrRoots: true })
    );
    assert.deepEqual(
      validateOverflowRouteLocations(
        [
          {
            sourceVolumeId: 'physical:volume3',
            destinationVolumeId: 'physical:volume4',
            thresholdGb: 50,
            enabled: true,
          },
        ],
        unavailable
      ),
      {
        valid: false,
        status: 503,
        message: 'A referenced physical volume has no available Servarr roots.',
      }
    );
  });
});
