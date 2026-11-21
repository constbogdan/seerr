import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OverflowSettings } from '@server/constants/overflow';
import { isSeriesRelocationJobEnabled } from '@server/job/seriesRelocationJob';
import {
  evaluateOverflowPlacement,
  requestedRegularSeasonCount,
  resolveOverflowRoutingTags,
} from '@server/lib/overflowRouting';
import type {
  PhysicalVolume,
  StorageDiscoveryResult,
  StorageLocation,
} from '@server/lib/storageSettings';
import { groupPhysicalVolumes } from '@server/lib/storageSettings';

const gib = 1024 ** 3;
const source: StorageLocation = {
  id: 'radarr:1:root:10',
  provider: 'radarr',
  serviceId: 1,
  serviceName: 'Movies',
  rootFolderId: 10,
  name: 'Movies',
  path: '/volume1/movies',
  color: null,
  isAnimation: false,
  diskSpacePath: '/volume1',
  totalSpace: 100 * gib,
  usedSpace: 50 * gib,
  freeSpace: 50 * gib,
  usedPercentage: 50,
  accessible: true,
  routable: true,
};
const destination: StorageLocation = {
  ...source,
  id: 'radarr:1:root:11',
  rootFolderId: 11,
  name: 'Movies External',
  path: '/volume9/movies',
  diskSpacePath: '/volume9',
  totalSpace: 200 * gib,
  usedSpace: 50 * gib,
  freeSpace: 150 * gib,
  usedPercentage: 25,
};

const volume = (id: string, location: StorageLocation): PhysicalVolume => ({
  id,
  name: id === 'physical:volume1' ? 'Volume 1' : 'Volume 9',
  volumeKey: id.replace('physical:', ''),
  locationIds: [location.id],
  segments: [],
  totalSpace: location.totalSpace,
  usedSpace: location.usedSpace,
  freeSpace: location.freeSpace,
  usedPercentage: location.usedPercentage,
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

const discovery = (
  sourceLocation: StorageLocation = source,
  destinationLocation: StorageLocation = destination
): StorageDiscoveryResult => ({
  locations: [sourceLocation, destinationLocation],
  volumes: [
    volume('physical:volume1', sourceLocation),
    volume('physical:volume9', destinationLocation),
  ],
  instances: [
    {
      provider: 'radarr',
      serviceId: 1,
      serviceName: 'Movies',
      available: true,
      capacityAvailable: true,
    },
  ],
  refreshedAt: '2026-10-18T00:00:00.000Z',
});

const settings: OverflowSettings = {
  enabled: true,
  freeSpaceThreshold: 10,
  automaticSeriesPlacement: false,
  defaultSeriesVolumeId: null,
  expansionSeriesVolumeId: null,
  seriesSeasonThreshold: 3,
  torrentRelocationDelayHours: 48,
  routes: [
    {
      sourceVolumeId: 'physical:volume1',
      destinationVolumeId: 'physical:volume9',
      thresholdGb: 50,
      enabled: true,
    },
  ],
};

const movieInput = (overrides = {}) => ({
  mediaType: 'movie' as const,
  settings,
  discovery: discovery(),
  provider: 'radarr' as const,
  serviceId: 1,
  configuredRootPath: '/volume1/movies',
  regularSourceRootPath: '/volume1/movies',
  existingMediaHasFiles: false,
  existingMediaAcquisitionActiveOrUnknown: false,
  ...overrides,
});

describe('Overflow routing evaluation', () => {
  it('does not evaluate or select a placement while Overflow is disabled', () => {
    const decision = evaluateOverflowPlacement(
      movieInput({ settings: { ...settings, enabled: false } })
    );

    assert.deepEqual(decision, {
      selected: false,
      reason: 'disabled',
      placement: null,
      location: null,
      routeKey: null,
    });
  });

  for (const [freeSpaceGb, expectedPlacement, expectedLocationId] of [
    [51, 'internal', source.id],
    [50, 'external', destination.id],
    [49, 'external', destination.id],
  ] as const) {
    it(`selects the ${expectedPlacement} Movie root with ${freeSpaceGb} GB free`, () => {
      const sourceWithFreeSpace = {
        ...source,
        freeSpace: freeSpaceGb * gib,
      };
      const decision = evaluateOverflowPlacement(
        movieInput({ discovery: discovery(sourceWithFreeSpace) })
      );

      assert.equal(decision.selected, true);
      assert.equal(decision.placement, expectedPlacement);
      assert.equal(decision.location?.id, expectedLocationId);
    });
  }

  it('routes the Volume 1 Movie root to the explicitly selected Volume 9 root', () => {
    const movieSource = {
      ...source,
      id: 'radarr:0:root:9',
      serviceId: 0,
      rootFolderId: 9,
      path: '/volume1/media-movies/movies',
    };
    const movieTarget = {
      ...destination,
      id: 'radarr:0:root:12',
      serviceId: 0,
      rootFolderId: 12,
      path: '/volume9/media-movies/movies',
    };
    const documentary = {
      ...movieTarget,
      id: 'radarr:0:root:14',
      rootFolderId: 14,
      path: '/volume9/media-movies/documentaries',
    };
    const base = discovery(movieSource, movieTarget);
    const ambiguous = {
      ...base,
      locations: [...base.locations, documentary],
      volumes: [
        base.volumes[0],
        {
          ...base.volumes[1],
          locationIds: [movieTarget.id, documentary.id],
        },
      ],
    };
    const mappedSettings: OverflowSettings = {
      ...settings,
      routes: [
        {
          ...settings.routes[0],
          rootMappings: [
            {
              sourceLocationId: movieSource.id,
              destinationLocationId: movieTarget.id,
            },
          ],
        },
      ],
    };
    const input = movieInput({
      discovery: ambiguous,
      settings: mappedSettings,
      serviceId: 0,
      configuredRootPath: movieSource.path,
      regularSourceRootPath: movieSource.path,
    });
    assert.equal(evaluateOverflowPlacement(input).location?.id, movieTarget.id);
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          ...input,
          settings: { ...mappedSettings, routes: settings.routes },
        })
      ).reason,
      'ambiguous-destination-root'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          ...input,
          settings: {
            ...mappedSettings,
            routes: [
              {
                ...mappedSettings.routes[0],
                rootMappings: [
                  {
                    sourceLocationId: movieSource.id,
                    destinationLocationId: documentary.id,
                  },
                ],
              },
            ],
          },
        })
      ).location?.id,
      documentary.id,
      'the destination is chosen by the saved ID, not by a name or path guess'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          ...input,
          settings: {
            ...mappedSettings,
            routes: [
              {
                ...mappedSettings.routes[0],
                rootMappings: [
                  {
                    sourceLocationId: movieSource.id,
                    destinationLocationId: 'radarr:0:root:99',
                  },
                ],
              },
            ],
          },
        })
      ).selected,
      false,
      'a stale saved ID cannot fall back to the remaining compatible root'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({ ...input, existingMediaHasFiles: true })
      ).selected,
      false,
      'configuration alone must not relocate an existing Movie'
    );
  });

  it('evaluates the Overflow threshold against the minimum shared-volume free-space reading', () => {
    const regularSource = {
      ...source,
      freeSpace: 51 * gib,
      usedSpace: 49 * gib,
      usedPercentage: 49,
    };
    const animationSource = {
      ...regularSource,
      id: 'radarr:1:root:12',
      rootFolderId: 12,
      name: 'Animation Internal',
      path: '/volume1/animation',
      isAnimation: true,
      freeSpace: 49 * gib,
      usedSpace: 51 * gib,
      usedPercentage: 51,
    };
    const animationDestination = {
      ...destination,
      id: 'radarr:1:root:13',
      rootFolderId: 13,
      name: 'Animation External',
      path: '/volume9/animation',
      isAnimation: true,
    };
    const locations = [
      regularSource,
      animationSource,
      destination,
      animationDestination,
    ];
    const sharedDiscovery: StorageDiscoveryResult = {
      locations,
      volumes: groupPhysicalVolumes(locations, []),
      instances: discovery().instances,
      refreshedAt: '2026-10-18T00:00:00.000Z',
    };

    const decision = evaluateOverflowPlacement(
      movieInput({ discovery: sharedDiscovery })
    );
    assert.equal(
      sharedDiscovery.volumes.find(({ id }) => id === 'physical:volume1')
        ?.freeSpace,
      49 * gib
    );
    assert.equal(decision.selected, true);
    assert.equal(decision.placement, 'external');
    assert.equal(decision.location?.id, destination.id);
  });

  it('keeps independent roots off-scope unless explicitly mapped', () => {
    const lowSource = { ...source, freeSpace: 49 * gib };
    const animationDestination = {
      ...destination,
      id: 'radarr:1:root:12',
      rootFolderId: 12,
      name: 'Animation',
      path: '/volume9/animation',
      isAnimation: true,
    };
    const animationSource = {
      ...lowSource,
      id: 'radarr:1:root:14',
      rootFolderId: 14,
      name: 'Animation Internal',
      path: '/volume1/animation',
      isAnimation: true,
    };
    const baseDiscovery = discovery(lowSource);
    const classifiedDiscovery = {
      ...baseDiscovery,
      locations: [
        ...baseDiscovery.locations,
        animationSource,
        animationDestination,
      ],
      volumes: baseDiscovery.volumes.map((candidate) =>
        candidate.id === 'physical:volume1'
          ? {
              ...candidate,
              locationIds: [...candidate.locationIds, animationSource.id],
            }
          : candidate.id === 'physical:volume9'
            ? {
                ...candidate,
                locationIds: [
                  ...candidate.locationIds,
                  animationDestination.id,
                ],
              }
            : candidate
      ),
    };
    assert.equal(
      evaluateOverflowPlacement(movieInput({ discovery: classifiedDiscovery }))
        .location?.id,
      destination.id
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          discovery: classifiedDiscovery,
          configuredRootPath: animationSource.path,
        })
      ).reason,
      'source-root-not-eligible'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          discovery: classifiedDiscovery,
          configuredRootPath: animationSource.path,
          settings: {
            ...settings,
            routes: [
              {
                ...settings.routes[0],
                rootMappings: [
                  {
                    sourceLocationId: lowSource.id,
                    destinationLocationId: destination.id,
                  },
                  {
                    sourceLocationId: animationSource.id,
                    destinationLocationId: animationDestination.id,
                  },
                ],
              },
            ],
          },
        })
      ).location?.id,
      animationDestination.id,
      'an independent root requires an explicit source mapping'
    );

    const duplicateRegular = {
      ...animationDestination,
      id: 'radarr:1:root:13',
      rootFolderId: 13,
      path: '/volume9/movies-duplicate',
      isAnimation: false,
    };
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          discovery: {
            ...classifiedDiscovery,
            locations: [...classifiedDiscovery.locations, duplicateRegular],
            volumes: classifiedDiscovery.volumes.map((candidate) =>
              candidate.id === 'physical:volume9'
                ? {
                    ...candidate,
                    locationIds: [
                      ...candidate.locationIds,
                      duplicateRegular.id,
                    ],
                  }
                : candidate
            ),
          },
        })
      ).reason,
      'ambiguous-destination-root'
    );
  });

  it('routes only the configured Movie source when a same-volume Documentary root is independent', () => {
    const documentarySource = {
      ...source,
      id: 'radarr:1:root:15',
      rootFolderId: 15,
      path: '/volume1/documentaries',
    };
    const documentaryTarget = {
      ...destination,
      id: 'radarr:1:root:16',
      rootFolderId: 16,
      path: '/volume9/documentaries',
    };
    const base = discovery({ ...source, freeSpace: 49 * gib });
    const mixed = {
      ...base,
      locations: [...base.locations, documentarySource, documentaryTarget],
      volumes: base.volumes.map((candidate) =>
        candidate.id === 'physical:volume1'
          ? {
              ...candidate,
              locationIds: [...candidate.locationIds, documentarySource.id],
            }
          : {
              ...candidate,
              locationIds: [...candidate.locationIds, documentaryTarget.id],
            }
      ),
    };
    const mapped = {
      ...settings,
      routes: [
        {
          ...settings.routes[0],
          rootMappings: [
            {
              sourceLocationId: source.id,
              destinationLocationId: destination.id,
            },
          ],
        },
      ],
    };
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({ discovery: mixed, settings: mapped })
      ).location?.id,
      destination.id
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          discovery: mixed,
          settings: mapped,
          configuredRootPath: documentarySource.path,
        })
      ).reason,
      'source-root-not-eligible'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          discovery: mixed,
          settings: {
            ...mapped,
            routes: [
              {
                ...mapped.routes[0],
                rootMappings: [
                  {
                    sourceLocationId: source.id,
                    destinationLocationId: destination.id,
                  },
                  {
                    sourceLocationId: documentarySource.id,
                    destinationLocationId: documentaryTarget.id,
                  },
                ],
              },
            ],
          },
          configuredRootPath: documentarySource.path,
        })
      ).location?.id,
      documentaryTarget.id
    );
  });

  it('fails closed for existing files, missing roots, and unknown capacity', () => {
    assert.equal(
      evaluateOverflowPlacement(movieInput({ existingMediaHasFiles: true }))
        .reason,
      'existing-media-with-files'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({ existingMediaAcquisitionActiveOrUnknown: true })
      ).reason,
      'existing-media-acquisition-active-or-unknown'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          discovery: discovery({
            ...source,
            totalSpace: null,
            freeSpace: null,
            accessible: false,
          }),
        })
      ).reason,
      'source-capacity-unavailable'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          discovery: discovery(source, {
            ...destination,
            totalSpace: null,
            freeSpace: null,
            accessible: false,
          }),
        })
      ).reason,
      'destination-capacity-unavailable'
    );
    assert.equal(
      evaluateOverflowPlacement(
        movieInput({
          discovery: {
            ...discovery({ ...source, freeSpace: 49 * gib }),
            locations: [{ ...source, freeSpace: 49 * gib }],
          },
        })
      ).reason,
      'missing-root'
    );
  });

  it('counts distinct requested regular Seasons and excludes Specials', () => {
    assert.equal(requestedRegularSeasonCount([0, 1, 1, 2, -1]), 2);
    assert.equal(requestedRegularSeasonCount([]), 0);
  });

  it('routes new Series by policy and preserves every existing Series root', () => {
    const sonarrSource = {
      ...source,
      id: 'sonarr:2:root:20',
      provider: 'sonarr' as const,
      serviceId: 2,
      rootFolderId: 20,
      path: '/volume3/shows',
      freeSpace: 51 * gib,
    };
    const sonarrDestination = {
      ...destination,
      id: 'sonarr:2:root:21',
      provider: 'sonarr' as const,
      serviceId: 2,
      rootFolderId: 21,
      path: '/volume9/shows',
    };
    const seriesSettings: OverflowSettings = {
      ...settings,
      automaticSeriesPlacement: true,
      defaultSeriesVolumeId: 'physical:volume1',
      expansionSeriesVolumeId: 'physical:volume9',
      seriesSeasonThreshold: 3,
      torrentRelocationDelayHours: 48,
      routes: [
        {
          sourceVolumeId: 'physical:volume1',
          destinationVolumeId: 'physical:volume9',
          thresholdGb: 50,
          enabled: true,
        },
      ],
    };
    const base = {
      mediaType: 'series' as const,
      settings: seriesSettings,
      discovery: discovery(sonarrSource, sonarrDestination),
      provider: 'sonarr' as const,
      serviceId: 2,
      configuredRootPath: '/volume3/shows',
      regularSourceRootPath: '/volume3/shows',
      existingSeries: false,
      requestedRegularSeasonNumbers: [0, 1, 2],
    };
    assert.equal(evaluateOverflowPlacement(base).placement, 'internal');
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        discovery: discovery(
          { ...sonarrSource, freeSpace: 50 * gib },
          sonarrDestination
        ),
      }).placement,
      'external',
      'Series placement falls back at exact byte-level threshold equality'
    );
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        settings: {
          ...seriesSettings,
          routes: [
            ...seriesSettings.routes,
            {
              sourceVolumeId: 'physical:volume9',
              destinationVolumeId: 'physical:volume1',
              thresholdGb: 50,
              enabled: true,
            },
          ],
        },
      }).placement,
      'internal',
      'Series placement follows configured volume roles, not unrelated route direction'
    );
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        settings: { ...seriesSettings, automaticSeriesPlacement: false },
      }).reason,
      'series-placement-disabled'
    );
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        requestedRegularSeasonNumbers: [1, 2, 3],
      }).placement,
      'external'
    );
    assert.equal(
      evaluateOverflowPlacement({ ...base, existingSeries: true }).reason,
      'existing-series'
    );
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        configuredRootPath: '/volume9/shows',
      }).reason,
      'source-root-not-eligible'
    );
    const unavailableExternal = {
      ...sonarrDestination,
      totalSpace: null,
      freeSpace: null,
      accessible: false,
    };
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        discovery: discovery(sonarrSource, unavailableExternal),
        requestedRegularSeasonNumbers: [1, 2, 3],
      }).placement,
      'internal'
    );
    const missingExpansion = discovery(sonarrSource, sonarrDestination);
    const alternate = {
      ...sonarrDestination,
      id: 'sonarr:2:root:22',
      rootFolderId: 22,
      path: '/volume9/docuseries',
    };
    const ambiguousDiscovery = discovery(sonarrSource, sonarrDestination);
    ambiguousDiscovery.locations.push(alternate);
    ambiguousDiscovery.volumes[1].locationIds.push(alternate.id);
    const expansionInput = {
      ...base,
      discovery: ambiguousDiscovery,
      requestedRegularSeasonNumbers: [1, 2, 3],
    };
    assert.equal(
      evaluateOverflowPlacement(expansionInput).reason,
      'ambiguous-destination-root'
    );
    assert.equal(
      evaluateOverflowPlacement({
        ...expansionInput,
        settings: {
          ...seriesSettings,
          seriesRootPreferences: [
            {
              sourceLocationId: sonarrSource.id,
              destinationVolumeId: 'physical:volume9',
              destinationLocationId: sonarrDestination.id,
            },
          ],
        },
      }).location?.id,
      sonarrDestination.id
    );
    assert.equal(
      evaluateOverflowPlacement({
        ...expansionInput,
        settings: {
          ...seriesSettings,
          seriesRootPreferences: [
            {
              sourceLocationId: sonarrSource.id,
              destinationVolumeId: 'physical:volume9',
              destinationLocationId: 'sonarr:2:root:999',
            },
          ],
        },
      }).reason,
      'missing-root',
      'a stale preference must not pick another Sonarr root'
    );
    const defaultAlternative = {
      ...sonarrSource,
      id: 'sonarr:2:root:23',
      rootFolderId: 23,
      path: '/volume3/docuseries',
    };
    const ambiguousDefault = discovery(sonarrSource, sonarrDestination);
    ambiguousDefault.locations.push(defaultAlternative);
    ambiguousDefault.volumes[0].locationIds.push(defaultAlternative.id);
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        discovery: ambiguousDefault,
        configuredRootPath: defaultAlternative.path,
      }).reason,
      'source-root-not-eligible',
      'another regular Sonarr root on the default volume is off-scope'
    );
    assert.equal(
      evaluateOverflowPlacement({ ...base, discovery: ambiguousDefault })
        .reason,
      'ambiguous-destination-root'
    );
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        discovery: ambiguousDefault,
        settings: {
          ...seriesSettings,
          seriesRootPreferences: [
            {
              sourceLocationId: sonarrSource.id,
              destinationVolumeId: 'physical:volume1',
              destinationLocationId: sonarrSource.id,
            },
          ],
        },
      }).location?.id,
      sonarrSource.id
    );
    missingExpansion.locations = [sonarrSource];
    missingExpansion.volumes = [missingExpansion.volumes[0]];
    assert.equal(
      evaluateOverflowPlacement({
        ...base,
        discovery: missingExpansion,
      }).reason,
      'preferred-volume-not-configured'
    );
  });

  it('keeps all three Storage feature activation states independent in every combination', () => {
    const sonarrSource = {
      ...source,
      id: 'sonarr:2:root:20',
      provider: 'sonarr' as const,
      serviceId: 2,
      rootFolderId: 20,
      path: '/volume3/shows',
    };
    const sonarrDestination = {
      ...destination,
      id: 'sonarr:2:root:21',
      provider: 'sonarr' as const,
      serviceId: 2,
      rootFolderId: 21,
      path: '/volume9/shows',
    };
    const seriesBase = {
      mediaType: 'series' as const,
      discovery: discovery(sonarrSource, sonarrDestination),
      provider: 'sonarr' as const,
      serviceId: 2,
      configuredRootPath: sonarrSource.path,
      regularSourceRootPath: sonarrSource.path,
      existingSeries: false,
      requestedRegularSeasonNumbers: [1, 2, 3],
    };

    for (const overflowEnabled of [false, true]) {
      for (const seriesPlacementEnabled of [false, true]) {
        for (const seriesRelocationEnabled of [false, true]) {
          const movieDecision = evaluateOverflowPlacement(
            movieInput({
              settings: { ...settings, enabled: overflowEnabled },
            })
          );
          assert.equal(
            movieDecision.selected,
            overflowEnabled,
            'Movie routing must follow only Overflow Routing'
          );

          const seriesDecision = evaluateOverflowPlacement({
            ...seriesBase,
            settings: {
              ...settings,
              enabled: overflowEnabled,
              automaticSeriesPlacement: seriesPlacementEnabled,
              defaultSeriesVolumeId: 'physical:volume1',
              expansionSeriesVolumeId: 'physical:volume9',
              routes: [],
            },
          });
          assert.equal(
            seriesDecision.selected,
            seriesPlacementEnabled,
            'Series placement must follow only Automatic Series Placement'
          );
          assert.equal(
            isSeriesRelocationJobEnabled(seriesRelocationEnabled),
            seriesRelocationEnabled,
            'Series relocation must follow only its persisted job state'
          );
        }
      }
    }
  });

  it('keeps root and routing tag selection atomic and preserves unrelated tags', () => {
    assert.deepEqual(
      resolveOverflowRoutingTags(
        [
          { id: 1, label: 'internal' },
          { id: 2, label: 'external' },
          { id: 3, label: 'requester' },
        ],
        [1, 3],
        'external'
      ),
      { valid: true, selectedTagId: 2, tags: [3, 2] }
    );
    assert.deepEqual(
      resolveOverflowRoutingTags(
        [{ id: 1, label: 'internal' }],
        [1],
        'external'
      ),
      { valid: false, reason: 'missing-routing-tag' }
    );
  });
});
