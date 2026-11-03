import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BoundedRequestCoordinator,
  BoundedRequestQueueClosedError,
  BoundedRequestQueueFullError,
} from '@server/lib/boundedRequestCoordinator';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('BoundedRequestCoordinator', () => {
  it('bounds active and queued work without dropping accepted requests', async () => {
    const coordinator = new BoundedRequestCoordinator({
      maxConcurrency: 2,
      maxPending: 2,
    });
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    const work = gates.map((gate, index) =>
      coordinator.schedule(async () => gate.promise.then(() => index))
    );

    assert.deepEqual(coordinator.stats(), {
      active: 2,
      pending: 2,
      closed: false,
      maxConcurrency: 2,
      maxPending: 2,
    });
    await assert.rejects(
      coordinator.schedule(async () => 5),
      BoundedRequestQueueFullError
    );

    gates[0].resolve(0);
    gates[1].resolve(1);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(coordinator.stats().active, 2);
    assert.equal(coordinator.stats().pending, 0);
    gates[2].resolve(2);
    gates[3].resolve(3);
    assert.deepEqual(await Promise.all(work), [0, 1, 2, 3]);
  });

  it('rejects queued and future work during shutdown while active work settles', async () => {
    const coordinator = new BoundedRequestCoordinator({
      maxConcurrency: 1,
      maxPending: 1,
    });
    const gate = deferred<number>();
    const active = coordinator.schedule(async () => gate.promise);
    const queued = coordinator.schedule(async () => 2);

    coordinator.close();
    await assert.rejects(queued, BoundedRequestQueueClosedError);
    await assert.rejects(
      coordinator.schedule(async () => 3),
      BoundedRequestQueueClosedError
    );
    gate.resolve(1);
    assert.equal(await active, 1);
  });
});
