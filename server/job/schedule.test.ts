import { MediaServerType } from '@server/constants/server';
import { scheduledJobs, startJobs } from '@server/job/schedule';
import seriesRelocation from '@server/job/seriesRelocationJob';
import currentJellyfinViewing from '@server/lib/currentJellyfinViewing';
import freshService from '@server/lib/fresh/service';
import libraryHistoryHydration from '@server/lib/libraryHistoryHydration';
import { getSettings } from '@server/lib/settings';
import watchlistPlayStateSync from '@server/lib/watchlistPlayState';
import schedule from 'node-schedule';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it, mock } from 'node:test';

beforeEach(() => {
  scheduledJobs.length = 0;
  getSettings().main.mediaServerType = MediaServerType.PLEX;
  mock.method(schedule, 'scheduleJob', () => ({ cancel: mock.fn() }));
  mock.method(seriesRelocation, 'reconcileOutstanding', async () => undefined);
  mock.method(watchlistPlayStateSync, 'startCatchUp', () => undefined);
  mock.method(currentJellyfinViewing, 'startCatchUp', () => undefined);
  mock.method(libraryHistoryHydration, 'startCatchUp', () => undefined);
  mock.method(freshService, 'startCatchUp', () => undefined);
});
afterEach(() => {
  scheduledJobs.forEach(({ job }) => job.cancel());
  scheduledJobs.length = 0;
  mock.restoreAll();
});

it('coalesces overlapping async startup and retains downstream jobs and catch-ups', async (t) => {
  getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
  let release!: () => void;
  const recovery = t.mock.method(
    currentJellyfinViewing,
    'recoverAbandonedRuns',
    () => new Promise<void>((resolve) => (release = resolve))
  );
  const first = startJobs();
  const second = startJobs();
  assert.equal(first, second);
  assert.equal(scheduledJobs.length, 0);
  assert.equal(recovery.mock.callCount(), 1);
  release();
  await Promise.all([first, second]);
  const ids = scheduledJobs.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    'jellyfin-full-scan',
    'next-season',
    'fresh-sync',
    'current-jellyfin-viewing-sync',
    'library-history-hydration',
    'series-relocation',
  ])
    assert.ok(ids.includes(id as (typeof ids)[number]), id);
});

it('replaces schedules on repeated setup without cancelling active job ownership', async (t) => {
  t.mock.method(currentJellyfinViewing, 'recoverAbandonedRuns', async () => 0);
  await startJobs();
  const previous = [...scheduledJobs];
  const cancellation = t.mock.method(
    currentJellyfinViewing,
    'cancel',
    () => undefined
  );
  getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
  await startJobs();
  for (const { job } of previous) {
    assert.equal(
      (job.cancel as unknown as ReturnType<typeof mock.fn>).mock.callCount(),
      1
    );
  }
  assert.equal(cancellation.mock.callCount(), 0);
  const ids = scheduledJobs.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('jellyfin-full-scan'));
  assert.ok(!ids.includes('plex-full-scan'));
});

it('uses the configured media server when setup overlaps awaited recovery', async (t) => {
  getSettings().main.mediaServerType = MediaServerType.NOT_CONFIGURED;
  let release!: () => void;
  t.mock.method(
    currentJellyfinViewing,
    'recoverAbandonedRuns',
    () => new Promise<void>((resolve) => (release = resolve))
  );
  const boot = startJobs();
  getSettings().main.mediaServerType = MediaServerType.PLEX;
  const ownerSetup = startJobs();
  assert.equal(boot, ownerSetup);
  release();
  await ownerSetup;
  const ids = scheduledJobs.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('plex-full-scan'));
});

it('propagates recovery failure, preserves existing schedules and permits retry', async (t) => {
  t.mock.method(currentJellyfinViewing, 'recoverAbandonedRuns', async () => 0);
  await startJobs();
  const previous = [...scheduledJobs];
  const failure = new Error('Synthetic startup recovery failure');
  const recovery = t.mock.method(
    currentJellyfinViewing,
    'recoverAbandonedRuns',
    async () => {
      throw failure;
    }
  );
  const first = startJobs();
  const second = startJobs();
  assert.equal(first, second);
  await assert.rejects(first, (error) => error === failure);
  await assert.rejects(second, (error) => error === failure);
  assert.deepEqual(scheduledJobs, previous);
  for (const { job } of previous) {
    assert.equal(
      (job.cancel as unknown as ReturnType<typeof mock.fn>).mock.callCount(),
      0
    );
  }
  recovery.mock.mockImplementation(async () => 0);
  await startJobs();
  assert.equal(
    new Set(scheduledJobs.map(({ id }) => id)).size,
    scheduledJobs.length
  );
});
