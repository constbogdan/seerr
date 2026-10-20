import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  PhysicalVolume,
  StorageLocation,
} from '@server/lib/storageSettings';

import { storageRouteLabel } from './routeLabels';

const location = (id: string, path: string): StorageLocation => ({
  id,
  provider: 'radarr',
  serviceId: 1,
  serviceName: 'radarr',
  rootFolderId: Number(id.at(-1)),
  name: 'Animation',
  path,
  color: null,
  diskSpacePath: null,
  totalSpace: null,
  usedSpace: null,
  freeSpace: null,
  usedPercentage: null,
  accessible: false,
  routable: true,
});

const volume = (name: string, locationId: string): PhysicalVolume =>
  ({
    id: `physical:${name}`,
    name,
    volumeKey: name.toLowerCase().replace(' ', ''),
    locationIds: [locationId],
    segments: [],
    totalSpace: null,
    usedSpace: null,
    freeSpace: null,
    usedPercentage: null,
    knownLibraryUsageBytes: '0',
    pendingRemovalBytes: null,
    pendingRemovalPercentage: null,
    pendingRemovalAvailable: false,
    pendingRemovalComplete: false,
    omittedRemovalScheduleCount: 0,
    unaccountedUsageBytes: null,
    provisionedSpaceBytes: null,
    usageExceedsPhysical: false,
    capacityReadingsDiffer: false,
    accessible: false,
  }) as PhysicalVolume;

describe('Storage Overflow route labels', () => {
  it('distinguishes duplicate display names using discovered volume identity', () => {
    const internal = location('radarr:1:root:1', '/volume1/animation');
    const external = location('radarr:1:root:9', '/volume9/animation');
    const volumes = [
      volume('Volume 1', internal.id),
      volume('Volume 9', external.id),
    ];

    assert.equal(
      storageRouteLabel(internal, volumes, 'Unknown volume'),
      'Animation (radarr) \u2014 Volume 1'
    );
    assert.equal(
      storageRouteLabel(external, volumes, 'Unknown volume'),
      'Animation (radarr) \u2014 Volume 9'
    );
  });

  it('labels an ungrouped current root truthfully', () => {
    assert.equal(
      storageRouteLabel(
        location('radarr:1:root:7', '/mnt/legacy'),
        [],
        'Unknown volume'
      ),
      'Animation (radarr) \u2014 Unknown volume'
    );
  });
});
