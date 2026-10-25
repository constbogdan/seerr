import {
  COMMISSIONING_JOB_SEQUENCE,
  SynchronizationExecutionBlockedError,
  SynchronizationPolicy,
  parseSynchronizationMode,
} from '@server/job/synchronizationPolicy';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const flushPromises = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe('SynchronizationPolicy', () => {
  it('strictly parses an immutable startup mode', () => {
    assert.equal(parseSynchronizationMode(undefined), 'normal');
    assert.equal(parseSynchronizationMode('normal'), 'normal');
    assert.equal(parseSynchronizationMode('contained'), 'contained');
    assert.equal(parseSynchronizationMode('commissioning'), 'commissioning');
    for (const invalid of [
      '',
      'true',
      'false',
      'NORMAL',
      ' contained ',
      'disabled',
    ]) {
      assert.throws(
        () => parseSynchronizationMode(invalid),
        /SEERR_SYNCHRONIZATION_MODE must be exactly one of/
      );
    }
  });

  it('preserves normal scheduled and manual behavior', () => {
    const policy = new SynchronizationPolicy('normal');
    let executions = 0;
    assert.equal(
      policy.executeScheduled('library-history-hydration', () => ++executions),
      1
    );
    assert.equal(executions, 1);
    assert.equal(policy.startupCatchUpsAllowed, true);
    assert.equal(policy.manualExecutionAllowed('radarr-scan', false), true);
    assert.doesNotThrow(() => policy.assertDirectManualExecutionAllowed());
  });

  it('suppresses scheduled and manual execution in contained mode', () => {
    const policy = new SynchronizationPolicy('contained');
    let executions = 0;
    assert.equal(
      policy.executeScheduled('library-history-hydration', () => ++executions),
      undefined
    );
    assert.equal(executions, 0);
    assert.equal(policy.startupCatchUpsAllowed, false);
    assert.equal(
      policy.manualExecutionAllowed('library-history-hydration', false),
      false
    );
    assert.throws(
      () => policy.assertDirectManualExecutionAllowed(),
      SynchronizationExecutionBlockedError
    );
  });

  it('enforces commissioning order and prevents overlap', async () => {
    const policy = new SynchronizationPolicy('commissioning');
    const library = deferred();
    assert.deepEqual(COMMISSIONING_JOB_SEQUENCE, [
      'library-history-hydration',
      'current-jellyfin-viewing-sync',
      'watchlist-play-state-sync',
      'fresh-sync',
    ]);
    assert.equal(
      policy.manualExecutionAllowed('library-history-hydration', false),
      true
    );
    policy.startCommissioningJob(
      'library-history-hydration',
      false,
      () => library.promise
    );
    assert.equal(
      policy.status(false).commissioning?.activeJobId,
      'library-history-hydration'
    );
    assert.throws(
      () =>
        policy.startCommissioningJob(
          'current-jellyfin-viewing-sync',
          false,
          () => Promise.resolve()
        ),
      /must finish before another commissioning job starts/
    );
    library.resolve();
    await flushPromises();
    assert.equal(
      policy.status(false).commissioning?.nextRequiredJobId,
      'current-jellyfin-viewing-sync'
    );
    assert.throws(
      () =>
        policy.startCommissioningJob('watchlist-play-state-sync', false, () =>
          Promise.resolve()
        ),
      /current-jellyfin-viewing-sync must complete successfully/
    );
  });

  it('does not advance a failed commissioning phase', async () => {
    const policy = new SynchronizationPolicy('commissioning');
    const library = deferred();
    policy.startCommissioningJob(
      'library-history-hydration',
      false,
      () => library.promise
    );
    library.reject(new Error('fixture failure'));
    await flushPromises();
    const status = policy.status(false).commissioning;
    assert.equal(status?.activeJobId, null);
    assert.equal(status?.nextRequiredJobId, 'library-history-hydration');
    assert.equal(status?.lastFailedJobId, 'library-history-hydration');
    assert.deepEqual(status?.completedJobIds, []);
  });

  it('requires Fresh to be intentionally enabled', async () => {
    const policy = new SynchronizationPolicy('commissioning');
    for (const jobId of COMMISSIONING_JOB_SEQUENCE.slice(0, 3)) {
      policy.startCommissioningJob(jobId, false, () => Promise.resolve());
      await flushPromises();
    }
    assert.equal(policy.manualExecutionAllowed('fresh-sync', false), false);
    assert.throws(
      () =>
        policy.startCommissioningJob('fresh-sync', false, () =>
          Promise.resolve()
        ),
      /Fresh Sync is unavailable because Fresh is disabled/
    );
    assert.equal(policy.manualExecutionAllowed('fresh-sync', true), true);
  });
});

describe('synchronization containment integration boundaries', () => {
  const scheduleSource = readFileSync(
    path.join(__dirname, 'schedule.ts'),
    'utf8'
  );
  const serverSource = readFileSync(
    path.join(__dirname, '../index.ts'),
    'utf8'
  );
  const authSource = readFileSync(
    path.join(__dirname, '../routes/auth.ts'),
    'utf8'
  );
  const settingsSource = readFileSync(
    path.join(__dirname, '../routes/settings/index.ts'),
    'utf8'
  );
  const freshSource = readFileSync(
    path.join(__dirname, '../routes/settings/fresh.ts'),
    'utf8'
  );

  it('guards every recurring callback and both startup catch-up phases', () => {
    assert.equal(
      scheduleSource.match(/schedule\.scheduleJob\(/g)?.length,
      1,
      'only scheduleGuardedJob may call node-schedule directly'
    );
    assert.match(
      scheduleSource,
      /synchronizationPolicy\.executeScheduled\(id, callback\)/
    );
    assert.match(
      scheduleSource,
      /if \(synchronizationPolicy\.startupCatchUpsAllowed\) \{[\s\S]*?recoverAbandonedRuns/
    );
    assert.match(
      scheduleSource,
      /if \(synchronizationPolicy\.startupCatchUpsAllowed\) \{[\s\S]*?watchlistPlayStateSync\.startCatchUp\(\)[\s\S]*?freshService\.startCatchUp\(\)/
    );
    assert.match(
      scheduleSource,
      /commissioningRun: async \(\) => \{[\s\S]*?libraryHistoryHydration\.run\(\)[\s\S]*?!result\.complete/
    );
    assert.match(
      scheduleSource,
      /commissioningRun: async \(\) => \{[\s\S]*?currentJellyfinViewing\.run\(\)[\s\S]*?!result\.complete/
    );
    assert.match(
      scheduleSource,
      /commissioningRun: \(\) => watchlistPlayStateSync\.run\(true\)/
    );
    assert.match(
      scheduleSource,
      /commissioningRun: \(\) => freshService\.sync\(true\)/
    );
  });

  it('covers normal startup and both initial media-server setup paths', () => {
    assert.match(serverSource, /await startJobs\(\)/);
    assert.equal(authSource.match(/await startJobs\(\)/g)?.length, 2);
    assert.match(serverSource, /logSynchronizationMode\(\)/);
    assert.match(
      serverSource,
      /Deferred automatic Plex library metadata migration due to synchronization mode/
    );
  });

  it('gates generic, direct scanner, and Fresh manual execution', () => {
    assert.match(settingsSource, /startCommissioningJob\(/);
    assert.equal(
      settingsSource.match(/assertDirectManualExecutionAllowed\(\)/g)?.length,
      3
    );
    assert.doesNotMatch(freshSource, /post\('\/(?:refresh|rebuild)'/);
    assert.match(settingsSource, /synchronization-containment/);
  });
});
