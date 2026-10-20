import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OverflowSettings } from '@server/constants/overflow';

import {
  isOverflowRoutingActivationValid,
  replaceStorageJobState,
  seriesRelocationConfigurationChanged,
  setAutomaticSeriesPlacementEnabled,
  setOverflowRoutingEnabled,
  type StorageJobState,
} from './featureToggleState';

const settings = (
  enabled: boolean,
  automaticSeriesPlacement: boolean
): OverflowSettings => ({
  enabled,
  freeSpaceThreshold: 10,
  automaticSeriesPlacement,
  defaultSeriesVolumeId: 'physical:volume3',
  expansionSeriesVolumeId: 'physical:volume9',
  seriesSeasonThreshold: 3,
  torrentRelocationDelayHours: 48,
  routes: [],
});

const jobs = (enabled: boolean): StorageJobState[] => [
  {
    id: 'series-relocation',
    enabled,
    configurableEnabled: true,
  },
];

describe('Storage feature toggle state', () => {
  it('requires an enabled route only when Overflow Routing is enabled', () => {
    assert.equal(
      isOverflowRoutingActivationValid({ enabled: false, routes: [] }),
      true
    );
    assert.equal(
      isOverflowRoutingActivationValid({
        enabled: false,
        routes: [
          {
            sourceVolumeId: 'physical:volume1',
            destinationVolumeId: 'physical:volume9',
            thresholdGb: 50,
            enabled: false,
          },
        ],
      }),
      true
    );
    assert.equal(
      isOverflowRoutingActivationValid({ enabled: true, routes: [] }),
      false
    );
    assert.equal(
      isOverflowRoutingActivationValid({
        enabled: true,
        routes: [
          {
            sourceVolumeId: 'physical:volume1',
            destinationVolumeId: 'physical:volume9',
            thresholdGb: 50,
            enabled: false,
          },
        ],
      }),
      false
    );
    assert.equal(
      isOverflowRoutingActivationValid({
        enabled: true,
        routes: [
          {
            sourceVolumeId: 'physical:volume1',
            destinationVolumeId: 'physical:volume9',
            thresholdGb: 50,
            enabled: true,
          },
        ],
      }),
      true
    );
  });

  it('preserves independent authorities for all eight boolean combinations', () => {
    for (const overflowEnabled of [false, true]) {
      for (const placementEnabled of [false, true]) {
        for (const relocationEnabled of [false, true]) {
          const currentSettings = settings(overflowEnabled, placementEnabled);
          const currentJobs = jobs(relocationEnabled);

          const overflowUpdate = setOverflowRoutingEnabled(
            currentSettings,
            !overflowEnabled
          );
          assert.equal(overflowUpdate.enabled, !overflowEnabled);
          assert.equal(
            overflowUpdate.automaticSeriesPlacement,
            placementEnabled
          );
          assert.equal(currentJobs[0].enabled, relocationEnabled);

          const placementUpdate = setAutomaticSeriesPlacementEnabled(
            currentSettings,
            !placementEnabled
          );
          assert.equal(placementUpdate.enabled, overflowEnabled);
          assert.equal(
            placementUpdate.automaticSeriesPlacement,
            !placementEnabled
          );
          assert.equal(currentJobs[0].enabled, relocationEnabled);

          const relocationUpdate = replaceStorageJobState(currentJobs, {
            ...currentJobs[0],
            enabled: !relocationEnabled,
          });
          assert.equal(relocationUpdate[0].enabled, !relocationEnabled);
          assert.equal(currentSettings.enabled, overflowEnabled);
          assert.equal(
            currentSettings.automaticSeriesPlacement,
            placementEnabled
          );
        }
      }
    }
  });

  it('detects only unsaved relocation-policy changes', () => {
    const persisted = settings(false, false);
    assert.equal(
      seriesRelocationConfigurationChanged(
        { ...persisted, enabled: true, automaticSeriesPlacement: true },
        persisted
      ),
      false
    );
    assert.equal(
      seriesRelocationConfigurationChanged(
        { ...persisted, expansionSeriesVolumeId: 'physical:volume10' },
        persisted
      ),
      true
    );
    assert.equal(
      seriesRelocationConfigurationChanged(
        { ...persisted, torrentRelocationDelayHours: 72 },
        persisted
      ),
      true
    );
  });
});
