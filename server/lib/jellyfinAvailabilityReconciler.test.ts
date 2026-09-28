import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import type {
  ConfirmedServarrImport,
  FinalizingAcquisitionTarget,
} from '@server/lib/downloadtracker';
import {
  JELLYFIN_RECONCILIATION_DEBOUNCE_MS,
  JELLYFIN_RECONCILIATION_RETRY_DELAYS_MS,
  JellyfinAvailabilityReconciler,
  hasExpectedAvailability,
  type JellyfinAvailabilityTarget,
} from './jellyfinAvailabilityReconciler';

const buildImport = (externalId: number): ConfirmedServarrImport => ({
  mediaType: MediaType.MOVIE,
  externalId,
  downloadId: `download-${externalId}`,
  serverAliases: [{ id: 1, is4k: false }],
  episodes: [],
});

const buildTarget = (mediaId: number): JellyfinAvailabilityTarget => ({
  mediaId,
  mediaType: MediaType.MOVIE,
  is4k: false,
  seasonNumbers: [],
  presentationTargets: [
    {
      mediaType: MediaType.MOVIE,
      externalId: mediaId,
      downloadId: `download-${mediaId}`,
      serverId: 1,
      is4k: false,
      episodes: [],
    },
  ],
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('JellyfinAvailabilityReconciler', () => {
  it('publishes stable Finalizing state across retries and clears it when available', async () => {
    const timers: { callback: () => void; delay: number }[] = [];
    const started: {
      target: FinalizingAcquisitionTarget;
      phaseStartedAt: string;
    }[] = [];
    const cleared: FinalizingAcquisitionTarget[] = [];
    let now = Date.parse('2026-01-01T00:00:00Z');
    let scans = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      scanner: {
        run: async () => {
          scans += 1;
          return { status: 'completed', durationMs: 10 };
        },
      },
      resolveImports: async () => [buildTarget(1)],
      isAvailable: async () => scans === 3,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return {} as NodeJS.Timeout;
      },
      now: () => now,
      presentation: {
        startFinalizing: (target, phaseStartedAt) =>
          started.push({ target, phaseStartedAt }),
        clearFinalizing: (target) => cleared.push(target),
      },
    });

    await reconciler.request([buildImport(1)]);
    const originalPhaseStartedAt = started[0].phaseStartedAt;
    now += 60_000;
    await reconciler.request([buildImport(1)]);
    assert.equal(started[1].phaseStartedAt, originalPhaseStartedAt);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      timers.shift()?.callback();
      await flush();
      await flush();
      assert.equal(cleared.length, 0);
      assert.equal(reconciler.getStatus().pendingTargets, 1);
    }

    timers.shift()?.callback();
    await flush();
    await flush();
    assert.equal(scans, 3);
    assert.equal(cleared.length, 1);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });

  it('coalesces nearby imports into one recent scan', async () => {
    const timers: { callback: () => void; delay: number }[] = [];
    let scans = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      scanner: {
        run: async () => {
          scans += 1;
          return { status: 'completed', durationMs: 10 };
        },
      },
      resolveImports: async (imports) =>
        imports.map((item) => buildTarget(item.externalId)),
      isAvailable: async () => true,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return {} as NodeJS.Timeout;
      },
    });

    await reconciler.request([buildImport(1)]);
    await reconciler.request([buildImport(2)]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, JELLYFIN_RECONCILIATION_DEBOUNCE_MS);
    timers.shift()?.callback();
    await flush();

    assert.equal(scans, 1);
    assert.deepEqual(reconciler.getStatus(), {
      pendingTargets: 0,
      running: false,
    });
  });

  it('does not lose an import that arrives during an active scan', async () => {
    const timers: { callback: () => void; delay: number }[] = [];
    let finishFirst: (() => void) | undefined;
    let scans = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      scanner: {
        run: async () => {
          scans += 1;
          if (scans === 1) {
            await new Promise<void>((resolve) => (finishFirst = resolve));
          }
          return { status: 'completed', durationMs: 10 };
        },
      },
      resolveImports: async (imports) =>
        imports.map((item) => buildTarget(item.externalId)),
      isAvailable: async () => true,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return {} as NodeJS.Timeout;
      },
    });

    await reconciler.request([buildImport(1)]);
    timers.shift()?.callback();
    await flush();
    await reconciler.request([buildImport(2)]);
    finishFirst?.();
    await flush();
    await flush();

    assert.equal(reconciler.getStatus().pendingTargets, 1);
    assert.equal(timers[0].delay, JELLYFIN_RECONCILIATION_DEBOUNCE_MS);
    timers.shift()?.callback();
    await flush();
    assert.equal(scans, 2);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });

  it('uses bounded completion-relative retries and then falls back to cron', async () => {
    const timers: { callback: () => void; delay: number }[] = [];
    const cleared: FinalizingAcquisitionTarget[] = [];
    let scans = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      scanner: {
        run: async () => {
          scans += 1;
          return { status: 'completed', durationMs: 10 };
        },
      },
      resolveImports: async () => [buildTarget(1)],
      isAvailable: async () => false,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return {} as NodeJS.Timeout;
      },
      presentation: {
        startFinalizing: () => undefined,
        clearFinalizing: (target) => cleared.push(target),
      },
    });

    await reconciler.request([buildImport(1)]);
    const observedDelays: number[] = [];
    while (timers.length) {
      const timer = timers.shift();
      if (!timer) break;
      observedDelays.push(timer.delay);
      timer.callback();
      await flush();
      await flush();
    }

    assert.deepEqual(observedDelays, [
      JELLYFIN_RECONCILIATION_DEBOUNCE_MS,
      ...JELLYFIN_RECONCILIATION_RETRY_DELAYS_MS,
    ]);
    assert.equal(scans, 5);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
    assert.equal(cleared.length, 1);
  });

  it('treats scanner failure as unknown and retries without losing the target', async () => {
    const timers: { callback: () => void; delay: number }[] = [];
    let scans = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      scanner: {
        run: async () => {
          scans += 1;
          return {
            status: scans === 1 ? 'failed' : 'completed',
            durationMs: 10,
          };
        },
      },
      resolveImports: async () => [buildTarget(1)],
      isAvailable: async () => scans > 1,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return {} as NodeJS.Timeout;
      },
    });

    await reconciler.request([buildImport(1)]);
    timers.shift()?.callback();
    await flush();
    assert.equal(reconciler.getStatus().pendingTargets, 1);
    assert.equal(timers[0].delay, JELLYFIN_RECONCILIATION_RETRY_DELAYS_MS[0]);
    timers.shift()?.callback();
    await flush();
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });

  it('coalesces an import arriving during retry delay into the next scan', async () => {
    const timers: { callback: () => void; delay: number }[] = [];
    let scans = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      scanner: {
        run: async () => {
          scans += 1;
          return { status: 'completed', durationMs: 10 };
        },
      },
      resolveImports: async (imports) =>
        imports.map((item) => buildTarget(item.externalId)),
      isAvailable: async () => scans > 1,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return {} as NodeJS.Timeout;
      },
    });

    await reconciler.request([buildImport(1)]);
    timers.shift()?.callback();
    await flush();
    assert.equal(timers.length, 1);

    await reconciler.request([buildImport(2)]);
    assert.equal(timers.length, 1);
    timers.shift()?.callback();
    await flush();
    assert.equal(scans, 2);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });
});

describe('hasExpectedAvailability', () => {
  const media = {
    status: MediaStatus.AVAILABLE,
    status4k: MediaStatus.PROCESSING,
    seasons: [
      {
        seasonNumber: 1,
        status: MediaStatus.PARTIALLY_AVAILABLE,
        status4k: MediaStatus.AVAILABLE,
      },
    ],
  };

  it('requires the matching movie quality to be available', () => {
    assert.equal(hasExpectedAvailability(media as never, buildTarget(1)), true);
    assert.equal(
      hasExpectedAvailability(media as never, {
        ...buildTarget(1),
        is4k: true,
      }),
      false
    );
  });

  it('accepts partial TV season availability for the imported quality', () => {
    assert.equal(
      hasExpectedAvailability(media as never, {
        ...buildTarget(1),
        mediaType: MediaType.TV,
        is4k: false,
        seasonNumbers: [1],
      }),
      true
    );
    assert.equal(
      hasExpectedAvailability(media as never, {
        ...buildTarget(1),
        mediaType: MediaType.TV,
        is4k: false,
        seasonNumbers: [2],
      }),
      false
    );
  });
});
