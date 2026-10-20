import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_OVERFLOW_SETTINGS } from '@server/constants/overflow';
import {
  createSeriesRelocationJobControl,
  createSeriesRelocationRunner,
} from '@server/job/seriesRelocationJob';

describe('Series Relocation job control', () => {
  const schedule = readFileSync(path.join(__dirname, 'schedule.ts'), 'utf8');
  const settingsRoutes = readFileSync(
    path.join(__dirname, '../routes/settings/index.ts'),
    'utf8'
  );

  it('restores the disabled state when persistence rejects enablement', async () => {
    const persisted = {
      jobs: { 'series-relocation': { enabled: false } },
      overflow: DEFAULT_OVERFLOW_SETTINGS,
      save: async () => {
        throw new Error('disk unavailable');
      },
    };
    const control = createSeriesRelocationJobControl({
      settings: () => persisted,
      validateEnablement: async () => undefined,
    });

    await assert.rejects(control.setEnabled(true), /disk unavailable/);
    assert.equal(persisted.jobs['series-relocation'].enabled, false);
    assert.equal(control.enabled(), false);
  });

  it('cannot run relocation while a failing enable is pending or after it rejects', async () => {
    let relocations = 0;
    let rejectSave!: (error: Error) => void;
    const save = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    const persisted = {
      jobs: { 'series-relocation': { enabled: false } },
      overflow: DEFAULT_OVERFLOW_SETTINGS,
      save: () => save,
    };
    const control = createSeriesRelocationJobControl({
      settings: () => persisted,
      validateEnablement: async () => undefined,
    });
    const run = createSeriesRelocationRunner({
      enabled: control.enabled,
      relocate: async () => {
        relocations += 1;
        return null;
      },
    });

    const enable = control.setEnabled(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(persisted.jobs['series-relocation'].enabled, true);
    assert.equal(control.enabled(), false);
    assert.equal(await run(), null);
    rejectSave(new Error('disk unavailable'));
    await assert.rejects(enable, /disk unavailable/);
    assert.equal(await run(), null);
    assert.equal(relocations, 0);
  });

  it('serializes concurrent transitions so a rollback cannot overwrite a later request', async () => {
    let releaseFirstSave!: () => void;
    const firstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let saveCount = 0;
    const persisted = {
      jobs: { 'series-relocation': { enabled: false } },
      overflow: DEFAULT_OVERFLOW_SETTINGS,
      save: async () => {
        saveCount += 1;
        if (saveCount === 1) {
          await firstSave;
          throw new Error('first save failed');
        }
      },
    };
    const control = createSeriesRelocationJobControl({
      settings: () => persisted,
      validateEnablement: async () => undefined,
    });

    const failedEnable = control.setEnabled(true);
    const disable = control.setEnabled(false);
    assert.equal(saveCount, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(saveCount, 1);
    assert.equal(persisted.jobs['series-relocation'].enabled, true);
    releaseFirstSave();
    await assert.rejects(failedEnable, /first save failed/);
    await disable;
    assert.equal(saveCount, 2);
    assert.equal(persisted.jobs['series-relocation'].enabled, false);
  });

  it('persists successful enable and disable transitions', async () => {
    let saves = 0;
    const persisted = {
      jobs: { 'series-relocation': { enabled: false } },
      overflow: DEFAULT_OVERFLOW_SETTINGS,
      save: async () => {
        saves += 1;
      },
    };
    const control = createSeriesRelocationJobControl({
      settings: () => persisted,
      validateEnablement: async () => undefined,
    });

    await control.setEnabled(true);
    assert.equal(persisted.jobs['series-relocation'].enabled, true);
    assert.equal(control.enabled(), true);
    await control.setEnabled(false);
    assert.equal(persisted.jobs['series-relocation'].enabled, false);
    assert.equal(control.enabled(), false);
    assert.equal(saves, 2);
  });

  it('retains one scheduler registration with its existing schedule and enable API', () => {
    assert.match(
      schedule,
      /id: 'series-relocation'[\s\S]*?cronSchedule: jobs\['series-relocation'\]\.schedule[\s\S]*?enabled: seriesRelocationJobEnabled[\s\S]*?setEnabled: setSeriesRelocationJobEnabled/
    );
    assert.match(
      settingsRoutes,
      /if \(scheduledJob\.enabled && !scheduledJob\.enabled\(\)\) \{[\s\S]*?status: 409, message: 'Job is disabled\.'/
    );
    assert.match(
      settingsRoutes,
      /'\/jobs\/:jobId\/enabled'[\s\S]*?await scheduledJob\.setEnabled\(parsed\.data\.enabled\)/
    );
    assert.match(
      settingsRoutes,
      /'\/jobs\/:jobId\/schedule'[\s\S]*?settings\.jobs\[scheduledJob\.id\]\.schedule = req\.body\.schedule/
    );
  });

  it('reconciles durable claims during safe startup before registering jobs', () => {
    const recovery = schedule.indexOf(
      'await seriesRelocation.reconcileOutstanding()'
    );
    const registration = schedule.indexOf("id: 'series-relocation'");
    assert.ok(recovery >= 0);
    assert.ok(recovery < registration);
    assert.match(
      schedule,
      /if \(synchronizationPolicy\.startupCatchUpsAllowed\) \{[\s\S]*?await seriesRelocation\.reconcileOutstanding\(\)/
    );
  });
});
