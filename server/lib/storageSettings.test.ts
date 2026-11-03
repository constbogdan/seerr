import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RootFolder } from '@server/api/servarr/base';
import type { OverflowVolumeRoute } from '@server/constants/overflow';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import {
  discoverStorageLocations,
  groupPhysicalVolumes,
  validateOverflowRouteLocations,
  validateOverflowThresholds,
  validateSeriesPlacementVolumes,
  type StorageDiscoveryDependencies,
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

const root = (
  id: number,
  path: string,
  totalSpace: number,
  freeSpace: number
): RootFolder => ({
  id,
  path,
  totalSpace,
  freeSpace,
  unmappedFolders: [],
});

const dependencies = (failSonarr = false): StorageDiscoveryDependencies => ({
  getStoredRoots: async (provider) =>
    provider === 'radarr'
      ? [
          {
            sourceRootId: 10,
            path: '/volume1/media-movies',
            displayName: 'Movies Internal',
            color: null,
            isAnimation: false,
          },
          {
            sourceRootId: 11,
            path: '/volume4/media-movies',
            displayName: 'Movies External',
            color: null,
            isAnimation: false,
          },
        ]
      : [
          {
            sourceRootId: 20,
            path: '/volume3/media-shows',
            displayName: 'Shows Internal',
            color: null,
            isAnimation: false,
          },
          {
            sourceRootId: 21,
            path: '/volume4/media-shows',
            displayName: 'Shows External',
            color: null,
            isAnimation: false,
          },
        ],
  getFreshRoots: async (provider) => {
    if (provider === 'sonarr' && failSonarr) throw new Error('offline');
    return provider === 'radarr'
      ? [
          root(10, '/volume1/media-movies', 1_000, 400),
          root(11, '/volume4/media-movies', 2_000, 1_250),
        ]
      : [
          root(20, '/volume3/media-shows', 500, 100),
          root(21, '/volume4/media-shows', 2_000, 1_240),
        ];
  },
  getFreshDiskSpace: async (provider) =>
    provider === 'radarr'
      ? [
          { path: '/volume1', totalSpace: 1_000, freeSpace: 400 },
          { path: '/volume4', totalSpace: 2_000, freeSpace: 1_240 },
        ]
      : [
          { path: '/volume3', totalSpace: 500, freeSpace: 100 },
          { path: '/volume4', totalSpace: 2_000, freeSpace: 1_240 },
        ],
  getLibraryUsage: async () => ({
    roots: [
      {
        provider: 'radarr',
        serviceId: 1,
        sourceRootId: 10,
        sizeBytes: '100',
      },
      {
        provider: 'radarr',
        serviceId: 1,
        sourceRootId: 11,
        sizeBytes: '200',
      },
      {
        provider: 'sonarr',
        serviceId: 2,
        sourceRootId: 20,
        sizeBytes: '50',
      },
      {
        provider: 'sonarr',
        serviceId: 2,
        sourceRootId: 21,
        sizeBytes: '300',
      },
    ],
    pendingRemovalAvailable: true,
    pendingRemovalComplete: true,
    omittedScheduleCount: 0,
  }),
  now: () => new Date('2026-10-16T08:00:00.000Z'),
});

describe('Storage settings discovery', () => {
  it('groups standardized roots by physical volume and aggregates Library usage', async () => {
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies()
    );

    assert.equal(result.locations.length, 4);
    assert.equal(result.refreshedAt, '2026-10-16T08:00:00.000Z');
    const internal = result.locations.find(
      (location) => location.name === 'Movies Internal'
    );
    assert.deepEqual(
      {
        total: internal?.totalSpace,
        used: internal?.usedSpace,
        free: internal?.freeSpace,
        percentage: internal?.usedPercentage,
      },
      { total: 1_000, used: 600, free: 400, percentage: 60 }
    );
    assert.equal(result.volumes.length, 3);
    assert.deepEqual(
      result.volumes.map((volume) => volume.name),
      ['Volume 1', 'Volume 3', 'Volume 4']
    );
    const external = result.volumes.find(
      (volume) => volume.volumeKey === 'volume4'
    );
    assert.deepEqual(
      {
        locations: external?.locationIds,
        total: external?.totalSpace,
        used: external?.usedSpace,
        free: external?.freeSpace,
        usage: external?.knownLibraryUsageBytes,
        segments: external?.segments.map((segment) => ({
          id: segment.id,
          bytes: segment.indexedUsageBytes,
        })),
        other: external?.unaccountedUsageBytes,
        differing: external?.capacityReadingsDiffer,
      },
      {
        locations: ['radarr:1:root:11', 'sonarr:2:root:21'],
        total: 2_000,
        used: 760,
        free: 1_240,
        usage: '500',
        segments: [
          { id: 'radarr:1:root:11', bytes: '200' },
          { id: 'sonarr:2:root:21', bytes: '300' },
        ],
        other: '260',
        differing: false,
      }
    );
  });

  it('keeps unrecognized paths separate even when capacities match', () => {
    const locations = [
      {
        id: 'radarr:1:root:30',
        provider: 'radarr' as const,
        serviceId: 1,
        serviceName: 'Movies',
        rootFolderId: 30,
        name: 'Legacy A',
        path: '/legacy/a',
        color: null,
        diskSpacePath: '/legacy/a',
        totalSpace: 1_000,
        usedSpace: 600,
        freeSpace: 400,
        usedPercentage: 60,
        accessible: true,
        routable: true,
      },
      {
        id: 'sonarr:2:root:31',
        provider: 'sonarr' as const,
        serviceId: 2,
        serviceName: 'Shows',
        rootFolderId: 31,
        name: 'Legacy B',
        path: '/legacy/b',
        color: null,
        diskSpacePath: '/legacy/b',
        totalSpace: 1_000,
        usedSpace: 600,
        freeSpace: 400,
        usedPercentage: 60,
        accessible: true,
        routable: true,
      },
    ];

    const volumes = groupPhysicalVolumes(locations, []);
    assert.equal(volumes.length, 2);
    assert.ok(volumes.every((volume) => volume.volumeKey === null));
    assert.deepEqual(
      volumes.map((volume) => volume.locationIds),
      [['radarr:1:root:30'], ['sonarr:2:root:31']]
    );
  });

  it('does not duplicate Library files through Episode or observation fan-out', () => {
    const volume = groupPhysicalVolumes(
      [
        {
          id: 'sonarr:2:root:21',
          provider: 'sonarr',
          serviceId: 2,
          serviceName: 'Shows',
          rootFolderId: 21,
          name: 'Shows External',
          path: '/volume4/media-shows',
          color: null,
          diskSpacePath: '/volume4',
          totalSpace: 2_000,
          usedSpace: 750,
          freeSpace: 1_250,
          usedPercentage: 37.5,
          accessible: true,
          routable: true,
        },
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

    assert.equal(volume.segments[0].indexedUsageBytes, '400');
    assert.equal(volume.unaccountedUsageBytes, '350');
  });

  it('retains known roots with Unknown capacity when a provider is inaccessible', async () => {
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies(true)
    );
    const shows = result.locations.filter(
      (location) => location.provider === 'sonarr'
    );
    assert.equal(shows.length, 2);
    assert.ok(
      shows.every(
        (location) =>
          !location.accessible &&
          !location.routable &&
          location.totalSpace === null &&
          location.usedSpace === null &&
          location.freeSpace === null
      )
    );
    assert.equal(
      result.instances.find((instance) => instance.provider === 'sonarr')
        ?.available,
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
      dependencies(true)
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

describe('Overflow threshold validation', () => {
  it('caps each threshold at its source volume capacity', async () => {
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies()
    );
    const volume1 = result.volumes.find(
      (volume) => volume.volumeKey === 'volume1'
    );
    assert.ok(volume1);
    volume1.totalSpace = 100 * 1024 ** 3;
    volume1.freeSpace = 50 * 1024 ** 3;
    volume1.usedSpace = 50 * 1024 ** 3;
    const routes: OverflowVolumeRoute[] = [
      {
        sourceVolumeId: 'physical:volume1',
        destinationVolumeId: 'physical:volume4',
        thresholdGb: 100,
        enabled: true,
      },
    ];

    assert.deepEqual(validateOverflowThresholds(routes, result), {
      valid: true,
    });
    routes[0].thresholdGb = 101;
    assert.deepEqual(validateOverflowThresholds(routes, result), {
      valid: false,
      status: 400,
      message: 'An Overflow threshold exceeds its source volume capacity.',
    });
  });
});

describe('Automatic Series Placement volume validation', () => {
  it('requires two eligible Sonarr volumes without requiring an Overflow route', async () => {
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies()
    );
    const settings = {
      automaticSeriesPlacement: true,
      defaultSeriesVolumeId: 'physical:volume3',
      expansionSeriesVolumeId: 'physical:volume4',
    };
    assert.deepEqual(validateSeriesPlacementVolumes(settings, result), {
      valid: true,
    });
    assert.deepEqual(
      validateSeriesPlacementVolumes(
        { ...settings, automaticSeriesPlacement: false },
        result,
        true
      ),
      { valid: true },
      'Series Relocation validates the same volumes independently'
    );
  });

  it('fails closed when direct preferred-volume root resolution is missing or ambiguous', async () => {
    const result = await discoverStorageLocations(
      { radarr: [radarr], sonarr: [sonarr] },
      dependencies()
    );
    const settings = {
      automaticSeriesPlacement: true,
      defaultSeriesVolumeId: 'physical:volume3',
      expansionSeriesVolumeId: 'physical:volume4',
    };
    assert.deepEqual(
      validateSeriesPlacementVolumes(
        { ...settings, expansionSeriesVolumeId: 'physical:volume9' },
        result
      ),
      {
        valid: false,
        status: 400,
        message: 'A preferred Series volume does not exist.',
      }
    );

    const external = result.locations.find(
      (location) =>
        location.provider === 'sonarr' && location.path.startsWith('/volume4/')
    );
    const expansion = result.volumes.find(
      (volume) => volume.id === 'physical:volume4'
    );
    assert.ok(external);
    assert.ok(expansion);
    const duplicate = {
      ...external,
      id: 'sonarr:2:root:22',
      rootFolderId: 22,
      path: '/volume4/media-shows-duplicate',
    };
    assert.deepEqual(
      validateSeriesPlacementVolumes(settings, {
        ...result,
        locations: [...result.locations, duplicate],
        volumes: result.volumes.map((volume) =>
          volume.id === expansion.id
            ? {
                ...volume,
                locationIds: [...volume.locationIds, duplicate.id],
              }
            : volume
        ),
      }),
      {
        valid: false,
        status: 400,
        message:
          'A preferred Series volume has multiple matching Sonarr roots.',
      }
    );
  });
});
