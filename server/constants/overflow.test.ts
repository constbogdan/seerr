import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_OVERFLOW_SETTINGS,
  normalizeOverflowSettings,
  resolveOverflowRoot,
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
