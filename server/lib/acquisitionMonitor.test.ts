import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  ACQUISITION_ACTIVE_INTERVAL_MS,
  ACQUISITION_FAILURE_BACKOFF_BASE_MS,
  ACQUISITION_FAILURE_BACKOFF_MAX_MS,
  ACQUISITION_WARM_DURATION_MS,
  AcquisitionMonitor,
  AcquisitionMonitorState,
} from '@server/lib/acquisitionMonitor';
import type { DownloadTrackerUpdateOutcome } from '@server/lib/downloadtracker';

const successfulOutcome = (
  overrides: Partial<DownloadTrackerUpdateOutcome> = {}
): DownloadTrackerUpdateOutcome => ({
  providersAttempted: 1,
  providersSucceeded: 1,
  providersFailed: 0,
  queueCount: 0,
  changed: false,
  authoritative: true,
  ...overrides,
});

class FakeClock {
  public nowMs = Date.parse('2026-01-01T00:00:00Z');
  private nextId = 1;
  private timers = new Map<
    number,
    { callback: () => void; dueAt: number; delay: number }
  >();

  public readonly now = () => this.nowMs;

  public readonly setTimer = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.timers.set(id, {
      callback,
      delay,
      dueAt: this.nowMs + delay,
    });
    return id as unknown as NodeJS.Timeout;
  };

  public readonly clearTimer = (timer: NodeJS.Timeout) => {
    this.timers.delete(timer as unknown as number);
  };

  public get nextDelay(): number | undefined {
    const next = [...this.timers.values()].sort(
      (first, second) => first.dueAt - second.dueAt
    )[0];
    return next?.delay;
  }

  public get timerCount(): number {
    return this.timers.size;
  }

  public advanceBy(milliseconds: number): void {
    this.nowMs += milliseconds;
  }

  public async runNext(): Promise<void> {
    const entry = [...this.timers.entries()].sort(
      ([, first], [, second]) => first.dueAt - second.dueAt
    )[0];
    assert.ok(entry, 'Expected a scheduled adaptive refresh');
    this.timers.delete(entry[0]);
    this.nowMs = Math.max(this.nowMs, entry[1].dueAt);
    entry[1].callback();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const buildMonitor = (
  outcomes: (DownloadTrackerUpdateOutcome | Error)[] = []
) => {
  const clock = new FakeClock();
  const tracker = {
    updateDownloads: mock.fn(async () => {
      const next = outcomes.shift() ?? successfulOutcome();
      if (next instanceof Error) {
        throw next;
      }
      return next;
    }),
    resetDownloadTracker: mock.fn(async () => undefined),
  };
  const monitor = new AcquisitionMonitor(tracker, {
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  return { clock, monitor, tracker };
};

describe('AcquisitionMonitor', () => {
  it('keeps an authoritative empty background refresh idle', async () => {
    const { clock, monitor } = buildMonitor();

    const outcome = await monitor.refresh('background');

    assert.strictEqual(outcome.queueCount, 0);
    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.IDLE);
    assert.strictEqual(clock.timerCount, 0);
  });

  it('moves through warm, active, cooldown, and idle without losing a wake', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({ queueCount: 0 }),
      successfulOutcome({ queueCount: 2, changed: true }),
      successfulOutcome({ queueCount: 0, changed: true }),
      successfulOutcome({ queueCount: 0 }),
    ]);

    monitor.wake('seerr-request');
    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);
    assert.strictEqual(clock.nextDelay, 0);

    await clock.runNext();
    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);
    assert.strictEqual(clock.nextDelay, ACQUISITION_ACTIVE_INTERVAL_MS);

    await clock.runNext();
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );

    clock.advanceBy(ACQUISITION_WARM_DURATION_MS);
    await monitor.refresh('background');
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.COOLDOWN
    );

    await clock.runNext();
    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.IDLE);
    assert.strictEqual(clock.timerCount, 0);
  });

  it('extends the warm window for multiple wakes during an active refresh', async () => {
    const clock = new FakeClock();
    let resolveRefresh:
      | ((outcome: DownloadTrackerUpdateOutcome) => void)
      | undefined;
    let updateCount = 0;
    const tracker = {
      updateDownloads: mock.fn(() => {
        updateCount += 1;
        if (updateCount > 1) {
          return Promise.resolve(successfulOutcome());
        }
        return new Promise<DownloadTrackerUpdateOutcome>((resolve) => {
          resolveRefresh = resolve;
        });
      }),
      resetDownloadTracker: mock.fn(async () => undefined),
    };
    const monitor = new AcquisitionMonitor(tracker, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    monitor.wake('seerr-request');
    await clock.runNext();
    clock.advanceBy(ACQUISITION_WARM_DURATION_MS - 1_000);
    monitor.wake('seerr-request');
    resolveRefresh?.(successfulOutcome());
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);
    clock.advanceBy(2_000);
    await monitor.refresh('background');
    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);
  });

  it('shares one active refresh across adaptive, scheduled, and manual callers', async () => {
    const clock = new FakeClock();
    let resolveRefresh:
      | ((outcome: DownloadTrackerUpdateOutcome) => void)
      | undefined;
    const tracker = {
      updateDownloads: mock.fn(
        () =>
          new Promise<DownloadTrackerUpdateOutcome>((resolve) => {
            resolveRefresh = resolve;
          })
      ),
      resetDownloadTracker: mock.fn(async () => undefined),
    };
    const monitor = new AcquisitionMonitor(tracker, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const background = monitor.refresh('background');
    const adaptive = monitor.refresh('adaptive');
    const manual = monitor.refresh('background');

    assert.strictEqual(background, adaptive);
    assert.strictEqual(background, manual);
    assert.strictEqual(tracker.updateDownloads.mock.callCount(), 1);
    resolveRefresh?.(successfulOutcome());
    await Promise.all([background, adaptive, manual]);
  });

  it('schedules from completion time instead of refresh start time', async () => {
    const clock = new FakeClock();
    let resolveRefresh:
      | ((outcome: DownloadTrackerUpdateOutcome) => void)
      | undefined;
    const tracker = {
      updateDownloads: mock.fn(
        () =>
          new Promise<DownloadTrackerUpdateOutcome>((resolve) => {
            resolveRefresh = resolve;
          })
      ),
      resetDownloadTracker: mock.fn(async () => undefined),
    };
    const monitor = new AcquisitionMonitor(tracker, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const refresh = monitor.refresh('background');
    clock.advanceBy(8_000);
    resolveRefresh?.(successfulOutcome({ queueCount: 1 }));
    await refresh;

    assert.strictEqual(clock.nextDelay, ACQUISITION_ACTIVE_INTERVAL_MS);
    assert.strictEqual(
      monitor.getStatus().nextRunAt,
      new Date(clock.nowMs + ACQUISITION_ACTIVE_INTERVAL_MS).toISOString()
    );
    assert.strictEqual(monitor.getStatus().lastRefreshDurationMs, 8_000);
  });

  it('does not lower lifecycle state on partial or total provider failure', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({ queueCount: 1 }),
      successfulOutcome({
        providersAttempted: 2,
        providersSucceeded: 1,
        providersFailed: 1,
        queueCount: 0,
        authoritative: false,
      }),
      successfulOutcome({
        providersSucceeded: 0,
        providersFailed: 1,
        queueCount: 0,
        authoritative: false,
      }),
    ]);

    await monitor.refresh('background');
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );

    await clock.runNext();
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );
    assert.strictEqual(clock.nextDelay, ACQUISITION_FAILURE_BACKOFF_BASE_MS);

    await clock.runNext();
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );
    assert.strictEqual(clock.nextDelay, 30_000);
  });

  it('bounds failure backoff and recovers after a successful refresh', async () => {
    const failures = Array.from({ length: 4 }, () =>
      successfulOutcome({
        providersSucceeded: 0,
        providersFailed: 1,
        authoritative: false,
      })
    );
    const { clock, monitor } = buildMonitor([...failures, successfulOutcome()]);

    monitor.wake('seerr-request');
    await clock.runNext();
    assert.strictEqual(clock.nextDelay, 15_000);
    await clock.runNext();
    assert.strictEqual(clock.nextDelay, 30_000);
    await clock.runNext();
    assert.strictEqual(clock.nextDelay, 60_000);
    await clock.runNext();
    assert.strictEqual(clock.nextDelay, ACQUISITION_FAILURE_BACKOFF_MAX_MS);
    await clock.runNext();

    assert.strictEqual(monitor.getStatus().consecutiveFailures, 0);
    assert.strictEqual(clock.timerCount, 1);
    assert.strictEqual(clock.nextDelay, ACQUISITION_ACTIVE_INTERVAL_MS);
  });

  it('lets warm intent expire only after bounded authoritative observations', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome(),
      successfulOutcome(),
      successfulOutcome(),
    ]);

    monitor.wake('seerr-request');
    await clock.runNext();
    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);

    clock.advanceBy(ACQUISITION_WARM_DURATION_MS);
    await monitor.refresh('background');
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.COOLDOWN
    );

    await clock.runNext();
    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.IDLE);
  });

  it('enters active directly when background discovery finds an external queue', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({ queueCount: 3 }),
    ]);

    await monitor.refresh('background');

    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );
    assert.strictEqual(clock.timerCount, 1);
    assert.strictEqual(clock.nextDelay, ACQUISITION_ACTIVE_INTERVAL_MS);
  });

  it('keeps active for non-empty queues and cools down on authoritative empty', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({ queueCount: 1 }),
      successfulOutcome({ queueCount: 2 }),
      successfulOutcome(),
    ]);

    await monitor.refresh('background');
    await clock.runNext();
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );

    await clock.runNext();
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.COOLDOWN
    );
  });

  it('returns from cooldown to active if the queue reappears', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({ queueCount: 1 }),
      successfulOutcome(),
      successfulOutcome({ queueCount: 1 }),
    ]);

    await monitor.refresh('background');
    await clock.runNext();
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.COOLDOWN
    );

    await clock.runNext();
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );
  });

  it('returns from cooldown to warm on a new request using the same timer', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({ queueCount: 1 }),
      successfulOutcome(),
    ]);

    await monitor.refresh('background');
    await clock.runNext();
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.COOLDOWN
    );
    assert.strictEqual(clock.timerCount, 1);

    monitor.wake('seerr-request');

    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);
    assert.strictEqual(clock.timerCount, 1);
    assert.strictEqual(clock.nextDelay, 0);
  });

  it('preserves a new wake received while active when the old queue disappears', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({ queueCount: 1 }),
      successfulOutcome(),
    ]);

    await monitor.refresh('background');
    monitor.wake('seerr-request');
    assert.strictEqual(clock.timerCount, 1);

    await clock.runNext();

    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);
    assert.strictEqual(clock.timerCount, 1);
  });

  it('does not let an in-flight observation consume a newer request wake', async () => {
    const clock = new FakeClock();
    let resolveActive:
      | ((outcome: DownloadTrackerUpdateOutcome) => void)
      | undefined;
    let updateCount = 0;
    const tracker = {
      updateDownloads: mock.fn(() => {
        updateCount += 1;
        if (updateCount === 1) {
          return Promise.resolve(successfulOutcome({ queueCount: 1 }));
        }
        if (updateCount === 2) {
          return new Promise<DownloadTrackerUpdateOutcome>((resolve) => {
            resolveActive = resolve;
          });
        }
        return Promise.resolve(successfulOutcome());
      }),
      resetDownloadTracker: mock.fn(async () => undefined),
    };
    const monitor = new AcquisitionMonitor(tracker, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    await monitor.refresh('background');
    await clock.runNext();
    monitor.wake('seerr-request');
    resolveActive?.(successfulOutcome({ queueCount: 1 }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );

    await clock.runNext();

    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);
  });

  it('does not start an adaptive retry loop for an idle background failure', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({
        providersSucceeded: 0,
        providersFailed: 1,
        authoritative: false,
      }),
    ]);

    await monitor.refresh('background');

    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.IDLE);
    assert.strictEqual(monitor.getStatus().consecutiveFailures, 1);
    assert.strictEqual(clock.timerCount, 0);
  });

  it('keeps warm state and schedules bounded backoff after an unexpected refresh error', async () => {
    const { clock, monitor } = buildMonitor([new Error('transient failure')]);

    monitor.wake('seerr-request');
    await clock.runNext();

    assert.strictEqual(monitor.getStatus().state, AcquisitionMonitorState.WARM);
    assert.strictEqual(monitor.getStatus().consecutiveFailures, 1);
    assert.strictEqual(clock.nextDelay, ACQUISITION_FAILURE_BACKOFF_BASE_MS);
    assert.ok(monitor.getStatus().lastFailedRefreshAt);
  });

  it('records observational success and failure diagnostics without changing state', async () => {
    const { clock, monitor } = buildMonitor([
      successfulOutcome({ queueCount: 1 }),
      successfulOutcome({
        providersSucceeded: 0,
        providersFailed: 1,
        authoritative: false,
      }),
    ]);

    await monitor.refresh('background');
    const successfulStatus = monitor.getStatus();
    assert.ok(successfulStatus.lastSuccessfulRefreshAt);
    assert.strictEqual(successfulStatus.lastFailedRefreshAt, undefined);

    await clock.runNext();
    const failedStatus = monitor.getStatus();
    assert.ok(failedStatus.lastFailedRefreshAt);
    assert.strictEqual(failedStatus.lastQueueCount, 0);
    assert.strictEqual(failedStatus.consecutiveFailures, 1);
    assert.strictEqual(failedStatus.cadenceMs, 15_000);
  });

  it('waits for an active refresh before clearing and authoritatively reconciling reset state', async () => {
    const clock = new FakeClock();
    let resolveActive:
      | ((outcome: DownloadTrackerUpdateOutcome) => void)
      | undefined;
    let updateCount = 0;
    const tracker = {
      updateDownloads: mock.fn(() => {
        updateCount += 1;
        if (updateCount === 1) {
          return new Promise<DownloadTrackerUpdateOutcome>((resolve) => {
            resolveActive = resolve;
          });
        }
        return Promise.resolve(successfulOutcome({ queueCount: 1 }));
      }),
      resetDownloadTracker: mock.fn(async () => undefined),
    };
    const monitor = new AcquisitionMonitor(tracker, {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    const activeRefresh = monitor.refresh('background');
    const reset = monitor.resetAndReconcile();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(tracker.resetDownloadTracker.mock.callCount(), 0);

    resolveActive?.(successfulOutcome({ queueCount: 1 }));
    await activeRefresh;
    const resetOutcome = await reset;

    assert.strictEqual(tracker.resetDownloadTracker.mock.callCount(), 1);
    assert.strictEqual(tracker.updateDownloads.mock.callCount(), 2);
    assert.strictEqual(resetOutcome.queueCount, 1);
    assert.strictEqual(
      monitor.getStatus().state,
      AcquisitionMonitorState.ACTIVE
    );
    assert.strictEqual(monitor.getStatus().lastRefreshSource, 'reset');
  });

  for (const state of Object.values(AcquisitionMonitorState)) {
    it(`immediately reconciles a daily reset while ${state}`, async () => {
      const { monitor, tracker } = buildMonitor([
        successfulOutcome({ queueCount: state === 'ACTIVE' ? 1 : 0 }),
      ]);
      const internals = monitor as unknown as {
        state: AcquisitionMonitorState;
        warmUntil: number;
      };
      internals.state = state;
      internals.warmUntil = Date.parse('2026-01-01T01:00:00Z');

      await monitor.resetAndReconcile();

      assert.strictEqual(tracker.resetDownloadTracker.mock.callCount(), 1);
      assert.strictEqual(tracker.updateDownloads.mock.callCount(), 1);
      assert.strictEqual(monitor.getStatus().lastRefreshSource, 'reset');
      assert.strictEqual(
        monitor.getStatus().state,
        state === AcquisitionMonitorState.COOLDOWN
          ? AcquisitionMonitorState.IDLE
          : state
      );
    });
  }
});
