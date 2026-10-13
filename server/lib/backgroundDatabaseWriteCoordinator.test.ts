import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BackgroundDatabaseWriteCoordinator } from './backgroundDatabaseWriteCoordinator';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('BackgroundDatabaseWriteCoordinator', () => {
  it('serializes background database writers and continues after a failure', async () => {
    const coordinator = new BackgroundDatabaseWriteCoordinator();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = coordinator.runExclusive(async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      events.push('first-end');
      throw new Error('expected');
    });
    const second = coordinator.runExclusive(async () => {
      events.push('second-start');
      events.push('second-end');
      return 'done';
    });

    await flush();
    assert.equal(coordinator.isRunning(), true);
    assert.deepEqual(events, ['first-start']);
    releaseFirst?.();
    await assert.rejects(first, /expected/);
    assert.equal(await second, 'done');
    assert.deepEqual(events, [
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
    assert.equal(coordinator.isRunning(), false);
  });
});
