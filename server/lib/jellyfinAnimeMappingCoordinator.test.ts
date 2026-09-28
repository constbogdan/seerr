import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JellyfinAnimeMappingCoordinator } from './jellyfinAnimeMappingCoordinator';

describe('JellyfinAnimeMappingCoordinator', () => {
  it('coalesces concurrent mapping initialization and permits a later refresh', async () => {
    let calls = 0;
    let finish: (() => void) | undefined;
    const coordinator = new JellyfinAnimeMappingCoordinator(async () => {
      calls += 1;
      await new Promise<void>((resolve) => (finish = resolve));
    });

    const first = coordinator.prepare();
    const second = coordinator.prepare();
    assert.equal(first, second);
    assert.equal(calls, 1);
    finish?.();
    await Promise.all([first, second]);

    const third = coordinator.prepare();
    assert.equal(calls, 2);
    finish?.();
    await third;
  });
});
