import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TRANSIENT_TOAST_DURATION_MS,
  ToastDismissalManager,
  shouldAutoDismissToast,
} from './toastLifecycle';

interface ScheduledTimer {
  callback: () => void;
  delay: number;
  cancelled: boolean;
}

const createHarness = () => {
  const scheduled: ScheduledTimer[] = [];
  const manager = new ToastDismissalManager(
    (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      scheduled.push(timer);
      return timer;
    },
    (handle) => {
      (handle as ScheduledTimer).cancelled = true;
    }
  );

  return { manager, scheduled };
};

describe('toast dismissal lifecycle', () => {
  it('dismisses a transient toast after the intended timeout', () => {
    const { manager, scheduled } = createHarness();
    const dismissed: string[] = [];

    manager.schedule('toast-1', (id) => dismissed.push(id));

    assert.equal(scheduled[0].delay, TRANSIENT_TOAST_DURATION_MS);
    assert.deepEqual(dismissed, []);
    scheduled[0].callback();
    assert.deepEqual(dismissed, ['toast-1']);
  });

  it('does not schedule intentionally persistent notifications', () => {
    assert.equal(shouldAutoDismissToast(false), false);
    assert.equal(shouldAutoDismissToast(true), true);
    assert.equal(shouldAutoDismissToast(undefined), true);
  });

  it('replaces an existing timer instead of allowing duplicate dismissal', () => {
    const { manager, scheduled } = createHarness();
    const dismissed: string[] = [];

    manager.schedule('toast-1', (id) => dismissed.push(`old:${id}`));
    manager.schedule('toast-1', (id) => dismissed.push(`new:${id}`));

    assert.equal(scheduled[0].cancelled, true);
    if (!scheduled[0].cancelled) scheduled[0].callback();
    scheduled[1].callback();
    assert.deepEqual(dismissed, ['new:toast-1']);
  });

  it('cancels pending dismissal during manual cleanup', () => {
    const { manager, scheduled } = createHarness();
    const dismissed: string[] = [];

    manager.schedule('toast-1', (id) => dismissed.push(id));
    manager.cancel('toast-1');

    assert.equal(scheduled[0].cancelled, true);
    if (!scheduled[0].cancelled) scheduled[0].callback();
    assert.deepEqual(dismissed, []);
  });
});
