// Internal cancellation fence. Cancellation/expiry is never import evidence.
export interface TargetedReconciliationControl {
  signal: AbortSignal;
  timeoutMs: number;
  isCurrent: () => boolean;
}

export const assertTargetCurrent = (
  control?: TargetedReconciliationControl
): void => {
  if (control && (control.signal.aborted || !control.isCurrent())) {
    throw new Error('Targeted reconciliation is no longer current');
  }
};

export const runAbortable = <T>(
  work: () => Promise<T>,
  signal: AbortSignal
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Targeted reconciliation expired'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    // Both handlers stay attached even if abort wins; late rejection is handled.
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
