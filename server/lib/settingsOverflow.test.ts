import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AllSettings } from '@server/lib/settings';
import Settings from '@server/lib/settings';

const serializeSettings = (settings: Settings): AllSettings =>
  JSON.parse(
    JSON.stringify((settings as unknown as { data: AllSettings }).data)
  ) as AllSettings;

describe('Overflow settings persistence', () => {
  it('keeps the overnight Series relocation job disabled by default', () => {
    const settings = new Settings();
    assert.deepEqual(settings.jobs['series-relocation'], {
      schedule: '0 0 2 * * *',
      enabled: false,
    });
  });

  it('defaults missing legacy settings to disabled', () => {
    const legacy = serializeSettings(new Settings()) as Partial<AllSettings>;
    delete legacy.overflow;

    const loaded = new Settings(legacy as AllSettings);

    assert.deepEqual(loaded.overflow, {
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

  it('survives the settings JSON serialization round trip', () => {
    const settings = new Settings();
    settings.overflow = {
      enabled: true,
      freeSpaceThreshold: 15,
      automaticSeriesPlacement: true,
      defaultSeriesVolumeId: 'physical:volume3',
      expansionSeriesVolumeId: 'physical:volume9',
      seriesSeasonThreshold: 3,
      torrentRelocationDelayHours: 48,
      routes: [
        {
          sourceVolumeId: 'physical:volume1',
          destinationVolumeId: 'physical:volume9',
          thresholdGb: 80,
          enabled: false,
        },
      ],
    };

    const reloaded = new Settings(serializeSettings(settings));

    assert.deepEqual(reloaded.overflow, settings.overflow);
  });

  it('loads the pre-Overflow production settings shape with safe defaults', () => {
    const production = serializeSettings(
      new Settings()
    ) as Partial<AllSettings>;
    Reflect.deleteProperty(production, 'overflow');
    Reflect.deleteProperty(production.jobs!, 'series-relocation');
    production.migrations = [
      '0007_migrate_arr_tags',
      '0008_migrate_blacklist_to_blocklist',
    ];

    const loaded = new Settings(production as AllSettings);

    assert.deepEqual(loaded.overflow, {
      enabled: false,
      freeSpaceThreshold: 10,
      automaticSeriesPlacement: false,
      defaultSeriesVolumeId: null,
      expansionSeriesVolumeId: null,
      seriesSeasonThreshold: 3,
      torrentRelocationDelayHours: 48,
      routes: [],
    });
    assert.equal(loaded.jobs['series-relocation'].enabled, false);
    assert.deepEqual(loaded.migrations, production.migrations);
  });

  it('preserves a locally recorded development migration marker as inert history', () => {
    const local = serializeSettings(new Settings());
    local.migrations = ['0009_remove_overflow_preview_mode'];

    const loaded = new Settings(local);

    assert.deepEqual(loaded.migrations, local.migrations);
    assert.deepEqual(loaded.overflow, local.overflow);
  });

  it('persists the three feature activation states independently', () => {
    const settings = new Settings();
    settings.overflow = {
      ...settings.overflow,
      enabled: true,
      automaticSeriesPlacement: false,
    };
    settings.jobs['series-relocation'].enabled = true;

    const reloaded = new Settings(serializeSettings(settings));

    assert.equal(reloaded.overflow.enabled, true);
    assert.equal(reloaded.overflow.automaticSeriesPlacement, false);
    assert.equal(reloaded.jobs['series-relocation'].enabled, true);
  });
});
