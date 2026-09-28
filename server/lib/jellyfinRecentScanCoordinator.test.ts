import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JellyfinRecentScanCoordinator } from './jellyfinRecentScanCoordinator';

describe('JellyfinRecentScanCoordinator', () => {
  it('shares one active recent scan across concurrent callers', async () => {
    let resolveRun: (() => void) | undefined;
    let calls = 0;
    const coordinator = new JellyfinRecentScanCoordinator({
      run: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          resolveRun = resolve;
        });
        return { status: 'completed', durationMs: 25 };
      },
    });

    const first = coordinator.run();
    const second = coordinator.run();

    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(coordinator.isRunning(), true);
    resolveRun?.();
    assert.deepEqual(await first, { status: 'completed', durationMs: 25 });
    assert.equal(coordinator.isRunning(), false);
  });

  it('allows a later scan after the active run completes', async () => {
    let calls = 0;
    const coordinator = new JellyfinRecentScanCoordinator({
      run: async () => {
        calls += 1;
        return { status: 'completed', durationMs: 1 };
      },
    });

    await coordinator.run();
    await coordinator.run();
    assert.equal(calls, 2);
  });
});
