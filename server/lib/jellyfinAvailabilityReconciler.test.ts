import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaType } from '@server/constants/media';
import type {
  ConfirmedServarrImport,
  FinalizingAcquisitionTarget,
} from '@server/lib/downloadtracker';
import type { TargetedReadiness } from '@server/lib/jellyfinTargetedAvailability';
import {
  JELLYFIN_RECONCILIATION_ACTIVE_WINDOW_MS,
  JELLYFIN_RECONCILIATION_CONCURRENCY,
  JELLYFIN_RECONCILIATION_DEBOUNCE_MS,
  JELLYFIN_RECONCILIATION_RETRY_INTERVAL_MS,
  JellyfinAvailabilityReconciler,
  type JellyfinAvailabilityTarget,
} from './jellyfinAvailabilityReconciler';

const buildImport = (
  externalId: number,
  downloadId = `download-${externalId}`
): ConfirmedServarrImport => ({
  mediaType: MediaType.MOVIE,
  externalId,
  downloadId,
  serverAliases: [{ id: 1, is4k: false }],
  episodes: [],
});

const buildTarget = (
  mediaId: number,
  downloadId = `download-${mediaId}`
): JellyfinAvailabilityTarget => ({
  mediaId,
  mediaType: MediaType.MOVIE,
  is4k: false,
  tmdbId: mediaId + 1_000,
  episodes: [],
  presentationTargets: [
    {
      mediaType: MediaType.MOVIE,
      externalId: mediaId,
      downloadId,
      serverId: 1,
      is4k: false,
      episodes: [],
    },
  ],
});

const ready = (): TargetedReadiness => ({
  state: 'ready',
  lookupMethod: 'exact-id',
  lookupDurationMs: 2,
  processingDurationMs: 3,
  jellyfinRequestCount: 1,
});

const notReady = (): TargetedReadiness => ({
  state: 'not_ready',
  reason: 'item_absent',
  lookupMethod: 'bounded-search',
  lookupDurationMs: 2,
  jellyfinRequestCount: 2,
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface FakeTimer {
  id: NodeJS.Timeout;
  at: number;
  callback: () => void;
}

class FakeClock {
  public now = Date.parse('2026-01-01T00:00:00Z');
  public timers: FakeTimer[] = [];
  private nextId = 1;

  public setTimer = (callback: () => void, delay: number): NodeJS.Timeout => {
    const id = this.nextId++ as unknown as NodeJS.Timeout;
    this.timers.push({ id, at: this.now + delay, callback });
    this.timers.sort((left, right) => left.at - right.at);
    return id;
  };

  public clearTimer = (id: NodeJS.Timeout): void => {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  };

  public async runNext(): Promise<number> {
    const timer = this.timers.shift();
    assert.ok(timer, 'expected a pending timer');
    const delay = timer.at - this.now;
    this.now = timer.at;
    timer.callback();
    await flush();
    await flush();
    return delay;
  }
}

describe('JellyfinAvailabilityReconciler', () => {
  for (const order of [
    [2, 1],
    [1, 2],
  ]) {
    it(`merges presentation Episode hints with readiness for one generation in order ${order.join(',')}`, async () => {
      const clock = new FakeClock();
      const episodes = [1, 2].map((number) => ({
        id: 100 + number,
        seasonNumber: 1,
        episodeNumber: number,
        absoluteEpisodeNumber: number,
      }));
      const evidence = episodes.map((episode) => ({
        observationId: `observation-${episode.id}`,
        providerKey: 'fixture',
        queueRecordId: episode.id,
        historyEventId: episode.id,
        importedAt: new Date(clock.now).toISOString(),
        episodeId: episode.id,
        historyEpisodeId: episode.id,
      }));
      let next = episodes[order[0] - 1];
      const shown: FinalizingAcquisitionTarget[] = [];
      const inspected: JellyfinAvailabilityTarget[] = [];
      const reconciler = new JellyfinAvailabilityReconciler({
        resolveImports: async () => [
          {
            ...buildTarget(1, 'pack'),
            mediaType: MediaType.TV,
            episodes: [next, next],
            presentationTargets: [
              {
                ...buildTarget(1, 'pack').presentationTargets[0],
                mediaType: MediaType.TV,
                episodes: [next, next],
                evidence,
              },
            ],
          },
        ],
        reconcileTarget: async (value) => {
          inspected.push(value as JellyfinAvailabilityTarget);
          return notReady();
        },
        now: () => clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        presentation: {
          startFinalizing: (value) => {
            shown.push(value);
          },
          clearFinalizing: () => undefined,
          isCurrentFinalizingTarget: () => true,
        },
      });
      await reconciler.request([buildImport(1, 'pack')]);
      next = episodes[order[1] - 1];
      await reconciler.request([buildImport(1, 'pack')]);
      assert.equal(reconciler.getStatus().pendingTargets, 1);
      assert.deepEqual(shown.at(-1)?.episodes, episodes);
      assert.deepEqual(shown.at(-1)?.evidence, evidence);
      await clock.runNext();
      assert.equal(inspected.length, 1);
      assert.deepEqual(inspected[0].episodes, episodes);
      assert.deepEqual(inspected[0].presentationTargets[0].episodes, episodes);
    });
  }

  it('does not merge presentation hints across distinct exact evidence generations', async () => {
    const clock = new FakeClock();
    let generation = 1;
    const shown: FinalizingAcquisitionTarget[] = [];
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async () => [
        {
          ...buildTarget(1, 'same-hash'),
          episodes: [
            {
              id: generation,
              seasonNumber: generation,
              episodeNumber: 1,
              absoluteEpisodeNumber: 1,
            },
          ],
          presentationTargets: [
            {
              ...buildTarget(1, 'same-hash').presentationTargets[0],
              episodes: [
                {
                  id: generation,
                  seasonNumber: generation,
                  episodeNumber: 1,
                  absoluteEpisodeNumber: 1,
                },
              ],
              evidence: [
                {
                  observationId: `generation-${generation}`,
                  providerKey: 'fixture',
                  queueRecordId: generation,
                  historyEventId: generation,
                  importedAt: new Date(clock.now).toISOString(),
                  episodeId: generation,
                  historyEpisodeId: generation,
                },
              ],
            },
          ],
        },
      ],
      reconcileTarget: async () => notReady(),
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      presentation: {
        startFinalizing: (value) => {
          shown.push(value);
        },
        clearFinalizing: () => undefined,
      },
    });
    await reconciler.request([buildImport(1, 'same-hash')]);
    generation = 2;
    await reconciler.request([buildImport(1, 'same-hash')]);
    assert.equal(reconciler.getStatus().pendingTargets, 2);
    assert.deepEqual(
      shown.map((value) =>
        value.episodes.map((episode) => episode.seasonNumber)
      ),
      [[1], [2]]
    );
  });

  it('uses a five-second debounce and preserves Finalizing across fixed retries', async () => {
    const clock = new FakeClock();
    const started: { phaseStartedAt: string }[] = [];
    const cleared: FinalizingAcquisitionTarget[] = [];
    let attempts = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async () => [buildTarget(1)],
      reconcileTarget: async () => {
        attempts += 1;
        clock.now += 2_000;
        return attempts === 3 ? ready() : notReady();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
      presentation: {
        startFinalizing: (_target, phaseStartedAt) =>
          started.push({ phaseStartedAt }),
        clearFinalizing: (target) => cleared.push(target),
      },
    });

    await reconciler.request([buildImport(1)]);
    const phaseStartedAt = started[0].phaseStartedAt;
    await reconciler.request([buildImport(1)]);
    assert.equal(started[1].phaseStartedAt, phaseStartedAt);

    assert.equal(await clock.runNext(), JELLYFIN_RECONCILIATION_DEBOUNCE_MS);
    assert.equal(cleared.length, 0);
    assert.equal(
      await clock.runNext(),
      JELLYFIN_RECONCILIATION_RETRY_INTERVAL_MS
    );
    assert.equal(cleared.length, 0);
    assert.equal(
      await clock.runNext(),
      JELLYFIN_RECONCILIATION_RETRY_INTERVAL_MS
    );

    assert.equal(attempts, 3);
    assert.equal(cleared.length, 1);
    assert.deepEqual(reconciler.getStatus(), {
      pendingTargets: 0,
      running: false,
    });
  });

  it('bounds active retries and clears Finalizing for scheduled recovery', async () => {
    const clock = new FakeClock();
    const cleared: FinalizingAcquisitionTarget[] = [];
    let attempts = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async () => [buildTarget(1)],
      reconcileTarget: async () => {
        attempts += 1;
        return notReady();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
      presentation: {
        startFinalizing: () => undefined,
        clearFinalizing: (target) => cleared.push(target),
      },
    });

    await reconciler.request([buildImport(1)]);
    const beganAt = clock.now;
    while (clock.timers.length) await clock.runNext();

    assert.equal(attempts, 16);
    assert.equal(clock.now - beganAt, JELLYFIN_RECONCILIATION_ACTIVE_WINDOW_MS);
    assert.equal(cleared.length, 1);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });

  it('retains an unknown target and retries transient failures', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async () => [buildTarget(1)],
      reconcileTarget: async () => {
        attempts += 1;
        return attempts === 1
          ? {
              state: 'unknown',
              reason: 'lookup_failed',
              errorType: 'ConnectionError',
              lookupMethod: 'exact-id',
              lookupDurationMs: 1,
              jellyfinRequestCount: 1,
            }
          : ready();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });

    await reconciler.request([buildImport(1)]);
    await clock.runNext();
    assert.equal(reconciler.getStatus().pendingTargets, 1);
    assert.equal(
      await clock.runNext(),
      JELLYFIN_RECONCILIATION_RETRY_INTERVAL_MS
    );
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });

  it('schedules a new target promptly while another waits for retry', async () => {
    const clock = new FakeClock();
    const attempts = new Map<number, number>();
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async (imports) =>
        imports.map((item) => buildTarget(item.externalId)),
      reconcileTarget: async (target) => {
        attempts.set(target.mediaId, (attempts.get(target.mediaId) ?? 0) + 1);
        return target.mediaId === 2 ? ready() : notReady();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });

    await reconciler.request([buildImport(1)]);
    await clock.runNext();
    await reconciler.request([buildImport(2)]);
    assert.equal(clock.timers.length, 1);
    assert.equal(await clock.runNext(), JELLYFIN_RECONCILIATION_DEBOUNCE_MS);

    assert.equal(attempts.get(1), 1);
    assert.equal(attempts.get(2), 1);
    assert.equal(reconciler.getStatus().pendingTargets, 1);
  });

  it('limits concurrent lookups to three and admits waiting targets fairly', async () => {
    const clock = new FakeClock();
    const started: number[] = [];
    const releases = new Map<number, () => void>();
    let active = 0;
    let maxActive = 0;
    const imports = Array.from({ length: 7 }, (_, index) =>
      buildImport(index + 1)
    );
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async (items) =>
        items.map((item) => buildTarget(item.externalId)),
      reconcileTarget: async (target) => {
        started.push(target.mediaId);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) =>
          releases.set(target.mediaId, resolve)
        );
        active -= 1;
        return ready();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
      concurrency: JELLYFIN_RECONCILIATION_CONCURRENCY,
    });

    await reconciler.request(imports);
    assert.equal(clock.timers.length, 1);
    const timer = clock.timers.shift();
    assert.ok(timer);
    clock.now = timer.at;
    timer.callback();
    await flush();
    assert.deepEqual(started, [1, 2, 3]);

    for (let id = 1; id <= 7; id += 1) {
      releases.get(id)?.();
      await flush();
    }
    await flush();

    assert.equal(maxActive, JELLYFIN_RECONCILIATION_CONCURRENCY);
    assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });

  it('does not let an in-flight stale generation clear an updated target', async () => {
    const clock = new FakeClock();
    let releaseFirst: (() => void) | undefined;
    let attempts = 0;
    const cleared: FinalizingAcquisitionTarget[] = [];
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async () => [buildTarget(1)],
      reconcileTarget: async () => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise<void>((resolve) => (releaseFirst = resolve));
        }
        return ready();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
      presentation: {
        startFinalizing: () => undefined,
        clearFinalizing: (target) => cleared.push(target),
      },
    });

    await reconciler.request([buildImport(1)]);
    const timer = clock.timers.shift();
    assert.ok(timer);
    clock.now = timer.at;
    timer.callback();
    await flush();
    await reconciler.request([buildImport(1)]);
    releaseFirst?.();
    await flush();
    await flush();

    assert.equal(cleared.length, 0);
    assert.equal(reconciler.getStatus().pendingTargets, 1);
    assert.equal(await clock.runNext(), 0);
    assert.equal(attempts, 2);
    assert.equal(cleared.length, 1);
  });

  it('keeps distinct download generations as distinct targets', async () => {
    const clock = new FakeClock();
    const reconciled: string[] = [];
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async (imports) =>
        imports.map((item) => buildTarget(item.externalId, item.downloadId)),
      reconcileTarget: async (target) => {
        reconciled.push(
          (target as JellyfinAvailabilityTarget).presentationTargets[0]
            .downloadId
        );
        return ready();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });

    await reconciler.request([
      buildImport(1, 'download-old'),
      buildImport(1, 'download-new'),
    ]);
    assert.equal(reconciler.getStatus().pendingTargets, 2);
    await clock.runNext();
    assert.deepEqual(reconciled.sort(), ['download-new', 'download-old']);
  });

  it('does not re-add an already reconciled download generation', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async () => [buildTarget(1)],
      reconcileTarget: async () => {
        attempts += 1;
        return ready();
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: () => clock.now,
    });

    await reconciler.request([buildImport(1)]);
    await clock.runNext();
    await reconciler.request([buildImport(1)]);

    assert.equal(attempts, 1);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
    assert.equal(clock.timers.length, 0);
  });

  it('expires a hung target independently while another target succeeds; late readiness cannot acknowledge', async () => {
    const clock = new FakeClock();
    let release: ((value: TargetedReadiness) => void) | undefined;
    const cleared: number[] = [];
    const acknowledged: number[] = [];
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async (imports) =>
        imports.map((item) => buildTarget(item.externalId)),
      reconcileTarget: async (target) =>
        target.mediaId === 1
          ? new Promise<TargetedReadiness>((resolve) => {
              release = resolve;
            })
          : ready(),
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      presentation: {
        startFinalizing: () => undefined,
        clearFinalizing: (target) => {
          cleared.push(target.externalId);
        },
        acknowledgeImport: (target) => {
          acknowledged.push(target.externalId);
        },
      },
    });
    await reconciler.request([buildImport(1), buildImport(2)]);
    await clock.runNext();
    assert.deepEqual(acknowledged, [2]);
    assert.equal(reconciler.getStatus().pendingTargets, 1);
    await clock.runNext();
    assert.equal(reconciler.getStatus().pendingTargets, 0);
    assert.equal(reconciler.getStatus().running, false);
    assert.deepEqual(cleared.sort(), [1, 2]);
    release?.(ready());
    await flush();
    await flush();
    assert.deepEqual(acknowledged, [2]);
  });

  it('catches rejected targets and uses the existing fifteen-second retry without blocking peers', async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async (imports) =>
        imports.map((item) => buildTarget(item.externalId)),
      reconcileTarget: async (target) => {
        if (target.mediaId === 1 && ++attempts === 1)
          throw new Error('database read failed');
        return ready();
      },
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await reconciler.request([buildImport(1), buildImport(2)]);
    await clock.runNext();
    assert.equal(reconciler.getStatus().pendingTargets, 1);
    assert.equal(
      await clock.runNext(),
      JELLYFIN_RECONCILIATION_RETRY_INTERVAL_MS
    );
    assert.equal(attempts, 2);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });

  it('does not acknowledge ready results for a replaced observation', async () => {
    const clock = new FakeClock();
    let current = true;
    let release: (() => void) | undefined;
    let acknowledged = 0;
    const reconciler = new JellyfinAvailabilityReconciler({
      resolveImports: async () => [buildTarget(1)],
      reconcileTarget: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return ready();
      },
      now: () => clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      presentation: {
        startFinalizing: () => undefined,
        clearFinalizing: () => undefined,
        isCurrentFinalizingTarget: () => current,
        acknowledgeImport: () => {
          acknowledged++;
        },
      },
    });
    await reconciler.request([buildImport(1)]);
    await clock.runNext();
    current = false;
    release?.();
    await flush();
    await flush();
    assert.equal(acknowledged, 0);
    assert.equal(reconciler.getStatus().pendingTargets, 0);
  });
});
