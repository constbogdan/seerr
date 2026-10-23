import {
  createNextSeasonJobControl,
  createNextSeasonRunner,
} from '@server/job/nextSeasonJob';
import {
  createNextSeasonScheduledJob,
  type ScheduledJob,
} from '@server/job/schedule';
import { SynchronizationPolicy } from '@server/job/synchronizationPolicy';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Next Season job lifecycle', () => {
  it('registers the independent five-minute job through the standard scheduler', async () => {
    let scheduled:
      | { id: string; cronSchedule: string; callback: () => Promise<unknown> }
      | undefined;
    let runs = 0;
    const scheduledJob = {} as ScheduledJob['job'];
    const job = createNextSeasonScheduledJob('15 */5 * * * *', {
      schedule: (id, cronSchedule, callback) => {
        scheduled = { id, cronSchedule, callback: async () => callback() };
        return scheduledJob;
      },
      run: async () => {
        runs += 1;
      },
      running: () => false,
      enabled: () => false,
      setEnabled: async () => undefined,
      result: () => undefined,
      cancel: () => undefined,
      dryRun: async () => ({}) as never,
    });

    assert.equal(job.id, 'next-season');
    assert.equal(job.interval, 'minutes');
    assert.equal(job.cronSchedule, '15 */5 * * * *');
    assert.equal(job.job, scheduledJob);
    assert.equal(job.enabled?.(), false);
    assert.equal(job.configurableEnabled, true);
    assert.deepEqual(
      scheduled && {
        id: scheduled.id,
        cronSchedule: scheduled.cronSchedule,
      },
      { id: 'next-season', cronSchedule: '15 */5 * * * *' }
    );
    await scheduled?.callback();
    assert.equal(runs, 1);
  });

  it('rolls back failed persistence and serializes enable transitions', async () => {
    let saveCount = 0;
    const settings = {
      jobs: { 'next-season': { enabled: false } },
      watchlistRoulette: { requestOwnerUserId: 7 },
      save: async () => {
        saveCount += 1;
        if (saveCount === 1) throw new Error('disk unavailable');
      },
    };
    const control = createNextSeasonJobControl({
      settings: () => settings,
      validateEnablement: async () => undefined,
    });
    const enable = control.setEnabled(true);
    const disable = control.setEnabled(false);
    await assert.rejects(enable, /disk unavailable/);
    await disable;
    assert.equal(settings.jobs['next-season'].enabled, false);
    assert.equal(control.enabled(), false);
    assert.equal(saveCount, 2);
  });

  it('requires a valid configured request owner before enabling', async () => {
    const settings = {
      jobs: { 'next-season': { enabled: false } },
      watchlistRoulette: { requestOwnerUserId: null },
      save: async () => undefined,
    };
    const control = createNextSeasonJobControl({
      settings: () => settings,
      validateEnablement: async () => {
        throw new Error('owner required');
      },
    });
    await assert.rejects(control.setEnabled(true), /owner required/);
    assert.equal(settings.jobs['next-season'].enabled, false);
  });

  it('does not run while disabled and prevents scheduled execution in contained mode', async () => {
    let runs = 0;
    const runner = createNextSeasonRunner({
      enabled: () => false,
      run: async () => {
        runs += 1;
      },
    });
    assert.equal(await runner(), null);
    assert.equal(runs, 0);

    const policy = new SynchronizationPolicy('contained');
    const result = policy.executeScheduled('next-season', () => {
      runs += 1;
    });
    assert.equal(result, undefined);
    assert.equal(runs, 0);
    assert.equal(policy.startupCatchUpsAllowed, false);
  });
});
