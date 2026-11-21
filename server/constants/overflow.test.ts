import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_OVERFLOW_SETTINGS,
  normalizeOverflowSettings,
  resolveOverflowRoot,
  resolveOverflowRouteRoot,
  resolveSeriesPreferredRoot,
  validateOverflowRouteRootMappings,
  validateSeriesRootPreferenceEntries,
} from '@server/constants/overflow';

describe('Overflow settings', () => {
  it('defaults to disabled with no routes for backward compatibility', () => {
    assert.deepEqual(normalizeOverflowSettings(undefined), {
      enabled: false,
      freeSpaceThreshold: 10,
      automaticSeriesPlacement: false,
      defaultSeriesVolumeId: null,
      expansionSeriesVolumeId: null,
      seriesSeasonThreshold: 3,
      torrentRelocationDelayHours: 48,
      routes: [],
    });
    assert.deepEqual(DEFAULT_OVERFLOW_SETTINGS, {
      enabled: false,
      freeSpaceThreshold: 10,
      automaticSeriesPlacement: false,
      defaultSeriesVolumeId: null,
      expansionSeriesVolumeId: null,
      seriesSeasonThreshold: 3,
      torrentRelocationDelayHours: 48,
      routes: [],
    });
  });

  it('preserves valid routes and their enabled state', () => {
    assert.deepEqual(
      normalizeOverflowSettings({
        enabled: true,
        freeSpaceThreshold: 15,
        automaticSeriesPlacement: true,
        defaultSeriesVolumeId: 'physical:volume3',
        expansionSeriesVolumeId: 'physical:volume9',
        seriesSeasonThreshold: 4,
        torrentRelocationDelayHours: 72,
        routes: [
          {
            sourceVolumeId: 'physical:volume1',
            destinationVolumeId: 'physical:volume9',
            thresholdGb: 75,
            enabled: false,
          },
        ],
      }),
      {
        enabled: true,
        freeSpaceThreshold: 15,
        automaticSeriesPlacement: true,
        defaultSeriesVolumeId: 'physical:volume3',
        expansionSeriesVolumeId: 'physical:volume9',
        seriesSeasonThreshold: 4,
        torrentRelocationDelayHours: 72,
        routes: [
          {
            sourceVolumeId: 'physical:volume1',
            destinationVolumeId: 'physical:volume9',
            thresholdGb: 75,
            enabled: false,
          },
        ],
      }
    );
  });

  it('drops invalid routes and duplicate source mappings', () => {
    const route = {
      sourceVolumeId: 'physical:volume1',
      destinationVolumeId: 'physical:volume9',
      thresholdGb: 50,
      enabled: true,
    };
    assert.deepEqual(
      normalizeOverflowSettings({
        enabled: true,
        routes: [
          route,
          route,
          { ...route, sourceVolumeId: 'bad' },
          { ...route, destinationVolumeId: 'physical:volume1' },
          { ...route, thresholdGb: 0 },
        ],
      }),
      {
        enabled: true,
        freeSpaceThreshold: 10,
        automaticSeriesPlacement: false,
        defaultSeriesVolumeId: null,
        expansionSeriesVolumeId: null,
        seriesSeasonThreshold: 3,
        torrentRelocationDelayHours: 48,
        routes: [route],
      }
    );
  });

  it('uses only an explicit boolean to enable the current contract', () => {
    assert.equal(normalizeOverflowSettings({ enabled: true }).enabled, true);
    assert.equal(normalizeOverflowSettings({ enabled: false }).enabled, false);
    assert.equal(normalizeOverflowSettings({ enabled: 'true' }).enabled, false);
    assert.equal(normalizeOverflowSettings({}).enabled, false);
  });

  it('persists valid explicit root mappings without changing legacy routes', () => {
    const route = {
      sourceVolumeId: 'physical:volume1',
      destinationVolumeId: 'physical:volume9',
      thresholdGb: 50,
      enabled: true,
      rootMappings: [
        {
          sourceLocationId: 'radarr:0:root:9',
          destinationLocationId: 'radarr:0:root:12',
        },
      ],
    };
    assert.deepEqual(normalizeOverflowSettings({ routes: [route] }).routes, [
      route,
    ]);
    assert.deepEqual(
      normalizeOverflowSettings({
        routes: [
          {
            ...route,
            rootMappings: [...route.rootMappings, ...route.rootMappings],
          },
        ],
      }).routes,
      [],
      'a corrupt duplicate mapping must not fall back to automatic selection'
    );
  });

  it('round-trips Series preferences and discards duplicate saved choices safely', () => {
    const preference = {
      sourceLocationId: 'sonarr:0:root:7',
      destinationVolumeId: 'physical:volume9',
      destinationLocationId: 'sonarr:0:root:9',
    };
    assert.deepEqual(
      normalizeOverflowSettings({ seriesRootPreferences: [preference] })
        .seriesRootPreferences,
      [preference]
    );
    assert.deepEqual(
      normalizeOverflowSettings({
        seriesRootPreferences: [preference, preference],
      }).seriesRootPreferences,
      [],
      'a duplicate cannot silently choose one destination'
    );
  });
});

describe('Overflow root resolution', () => {
  const source = {
    provider: 'radarr' as const,
    serviceId: 0,
    isAnimation: false,
    routable: true,
  };

  it('ignores unrelated roots on a shared target volume', () => {
    const movie = { ...source, id: 12 };
    const result = resolveOverflowRoot(source, [
      movie,
      { ...source, id: 13, isAnimation: true },
      {
        provider: 'sonarr' as const,
        serviceId: 0,
        isAnimation: false,
        routable: true,
        id: 9,
      },
    ]);
    assert.deepEqual(result, { status: 'resolved', location: movie });
  });

  it('fails closed for missing classifications, missing roots, and duplicates', () => {
    assert.deepEqual(
      resolveOverflowRoot({ ...source, isAnimation: undefined }, []),
      { status: 'source-classification-missing' }
    );
    assert.deepEqual(
      resolveOverflowRoot(source, [{ ...source, id: 13, isAnimation: true }]),
      { status: 'destination-root-missing' }
    );
    assert.deepEqual(
      resolveOverflowRoot(source, [
        { ...source, id: 12 },
        { ...source, id: 14 },
      ]),
      { status: 'destination-root-ambiguous' }
    );
  });
});

describe('Explicit Overflow root mappings', () => {
  const source = {
    id: 'radarr:0:root:9',
    provider: 'radarr' as const,
    serviceId: 0,
    isAnimation: false,
    routable: true,
  };
  const movies = { ...source, id: 'radarr:0:root:12' };
  const documentaries = { ...source, id: 'radarr:0:root:14' };
  const animation = {
    ...source,
    id: 'radarr:0:root:13',
    isAnimation: true,
  };
  const mapping = {
    sourceLocationId: source.id,
    destinationLocationId: movies.id,
  };

  it('requires selection for two matching targets and uses the selected root', () => {
    const targets = [movies, documentaries, animation];
    assert.equal(
      resolveOverflowRouteRoot(source, targets).status,
      'destination-root-ambiguous'
    );
    assert.deepEqual(resolveOverflowRouteRoot(source, targets, [mapping]), {
      status: 'resolved',
      location: movies,
    });
    assert.equal(
      validateOverflowRouteRootMappings([source], targets, [mapping]),
      'resolved'
    );
  });

  it('keeps unique automatic matching and rejects stale or incompatible choices', () => {
    assert.deepEqual(resolveOverflowRouteRoot(source, [movies]), {
      status: 'resolved',
      location: movies,
    });
    for (const destinationLocationId of [
      animation.id,
      'radarr:0:root:99',
      'sonarr:0:root:12',
    ]) {
      assert.equal(
        resolveOverflowRouteRoot(
          source,
          [movies, animation],
          [{ ...mapping, destinationLocationId }]
        ).status,
        'invalid-root-mapping'
      );
    }
    assert.equal(
      resolveOverflowRouteRoot(source, [{ ...movies, serviceId: 1 }]).status,
      'destination-root-missing'
    );
  });

  it('rejects duplicate and out-of-scope source mappings', () => {
    const targets = [movies, documentaries];
    assert.equal(
      validateOverflowRouteRootMappings([source], targets, [mapping, mapping]),
      'invalid-root-mapping'
    );
    assert.equal(
      validateOverflowRouteRootMappings([source], targets, [
        { ...mapping, sourceLocationId: 'radarr:0:root:88' },
      ]),
      'invalid-root-mapping'
    );
    assert.equal(
      validateOverflowRouteRootMappings([source], [], [mapping]),
      'destination-root-missing'
    );
  });

  it('resolves mixed Radarr and Sonarr roots independently on one target volume', () => {
    const seriesSource = {
      ...source,
      id: 'sonarr:0:root:7',
      provider: 'sonarr' as const,
    };
    const seriesTarget = { ...seriesSource, id: 'sonarr:0:root:10' };
    assert.equal(
      validateOverflowRouteRootMappings(
        [source, seriesSource],
        [movies, documentaries, animation, seriesTarget],
        [mapping]
      ),
      'resolved',
      'the unique Sonarr root still resolves automatically'
    );
    assert.equal(
      validateOverflowRouteRootMappings(
        [source, seriesSource],
        [movies, documentaries, animation, { ...seriesTarget, serviceId: 1 }],
        [mapping]
      ),
      'destination-root-missing',
      'a different Sonarr instance cannot satisfy the route'
    );
  });
});

describe('Series preferred root selections', () => {
  const source = {
    id: 'sonarr:0:root:7',
    provider: 'sonarr' as const,
    serviceId: 0,
    isAnimation: false,
    routable: true,
  };
  const shows = { ...source, id: 'sonarr:0:root:9' };
  const docuseries = { ...source, id: 'sonarr:0:root:10' };
  const volumeId = 'physical:volume9';
  const preference = {
    sourceLocationId: source.id,
    destinationVolumeId: volumeId,
    destinationLocationId: shows.id,
  };

  it('requires an explicit choice only when a preferred volume is ambiguous', () => {
    assert.equal(
      resolveSeriesPreferredRoot(source, [shows, docuseries], volumeId).status,
      'destination-root-ambiguous'
    );
    assert.deepEqual(
      resolveSeriesPreferredRoot(source, [shows, docuseries], volumeId, [
        preference,
      ]),
      { status: 'resolved', location: shows }
    );
    assert.deepEqual(resolveSeriesPreferredRoot(source, [shows], volumeId), {
      status: 'resolved',
      location: shows,
    });
  });

  it('rejects stale, incompatible, and duplicate selections without affecting other volumes', () => {
    const targets = new Map([[volumeId, [shows, docuseries]]]);
    assert.equal(
      validateSeriesRootPreferenceEntries([source], targets, [preference]),
      true
    );
    assert.equal(
      validateSeriesRootPreferenceEntries([source], targets, [
        preference,
        preference,
      ]),
      false
    );
    for (const destinationLocationId of [
      'sonarr:0:root:99',
      'sonarr:1:root:9',
      'radarr:0:root:9',
    ]) {
      assert.equal(
        validateSeriesRootPreferenceEntries([source], targets, [
          { ...preference, destinationLocationId },
        ]),
        false
      );
    }
    assert.equal(
      resolveSeriesPreferredRoot(source, [shows], 'physical:volume3', [
        preference,
      ]).status,
      'resolved'
    );
  });
});
