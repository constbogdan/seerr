import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_REMOVAL_SETTINGS,
  normalizeRemovalSettings,
} from '@server/constants/removal';
import { removalSettingsSchema } from '@server/routes/settings/removal';

describe('Removal settings validation', () => {
  it('accepts the minimal native-job-gated settings contract', () => {
    assert.deepEqual(
      removalSettingsSchema.parse(DEFAULT_REMOVAL_SETTINGS),
      DEFAULT_REMOVAL_SETTINGS
    );
    assert.deepEqual(Object.keys(DEFAULT_REMOVAL_SETTINGS.movie).sort(), [
      'enabled',
      'inactivityMonths',
      'itemsPerRun',
      'minimumAgeMonths',
    ]);
  });

  it('rejects invalid policy values and obsolete cadence state', () => {
    for (const invalid of [
      { removalDelayDays: 0 },
      { removalDelayDays: 1.5 },
      { removalDelayDays: 11 },
      { movie: { minimumAgeMonths: -1 } },
      { movie: { itemsPerRun: -1 } },
      { series: { itemsPerRun: 1001 } },
      { movie: { obsoleteField: 5 } },
      { candidateSelection: { enabled: true, intervalDays: 14 } },
      { nextRunAt: '2026-10-20T08:00:00.000Z' },
    ]) {
      const value = {
        ...DEFAULT_REMOVAL_SETTINGS,
        ...invalid,
        movie: {
          ...DEFAULT_REMOVAL_SETTINGS.movie,
          ...('movie' in invalid ? invalid.movie : {}),
        },
        series: {
          ...DEFAULT_REMOVAL_SETTINGS.series,
          ...('series' in invalid ? invalid.series : {}),
        },
      };
      assert.equal(removalSettingsSchema.safeParse(value).success, false);
    }
  });

  it('accepts only the fixed countdown values', () => {
    for (const removalDelayDays of [10, 20, 30, 60, 90])
      assert.equal(
        removalSettingsSchema.safeParse({
          ...DEFAULT_REMOVAL_SETTINGS,
          removalDelayDays,
        }).success,
        true
      );
  });

  it('persists only execution gates and drops superseded cadence fields', () => {
    const expected = {
      ...structuredClone(DEFAULT_REMOVAL_SETTINGS),
      removalScanEnabled: true,
      removalProcessingEnabled: true,
    };
    const reloaded = normalizeRemovalSettings(
      JSON.parse(
        JSON.stringify({
          ...expected,
          candidateSelection: { intervalDays: 14, nextRunAt: 'obsolete' },
        })
      )
    );

    assert.deepEqual(reloaded, expected);
    assert.deepEqual(Object.keys(reloaded).sort(), [
      'movie',
      'removalDelayDays',
      'removalProcessingEnabled',
      'removalScanEnabled',
      'series',
    ]);
    assert.equal(
      normalizeRemovalSettings({
        ...expected,
        removalDelayDays: 14,
      }).removalDelayDays,
      60
    );
  });
});
