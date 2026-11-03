export class BoundedRequestQueueFullError extends Error {}
export class BoundedRequestQueueClosedError extends Error {}

interface PendingRequest<T> {
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export interface BoundedRequestCoordinatorOptions {
  maxConcurrency: number;
  maxPending: number;
  maxStartsPerInterval?: number;
  intervalMs?: number;
  now?: () => number;
}

/**
 * Process-local concurrency, queue, and start-rate containment for external
 * requests. Running work is allowed to settle; queued work is rejected when
 * the coordinator closes.
 */
export class BoundedRequestCoordinator {
  private active = 0;
  private closed = false;
  private readonly pending: PendingRequest<unknown>[] = [];
  private readonly starts: number[] = [];
  private timer?: NodeJS.Timeout;
  private readonly maxStartsPerInterval: number;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: BoundedRequestCoordinatorOptions) {
    if (
      !Number.isInteger(options.maxConcurrency) ||
      options.maxConcurrency < 1 ||
      !Number.isInteger(options.maxPending) ||
      options.maxPending < 0
    ) {
      throw new Error('Bounded request limits are invalid');
    }
    this.maxStartsPerInterval =
      options.maxStartsPerInterval ?? Number.MAX_SAFE_INTEGER;
    this.intervalMs = options.intervalMs ?? 1000;
    this.now = options.now ?? Date.now;
  }

  public schedule<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new BoundedRequestQueueClosedError('Request coordinator is closed')
      );
    }
    if (this.pending.length >= this.options.maxPending) {
      return Promise.reject(
        new BoundedRequestQueueFullError('Request queue capacity was reached')
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.push({ work, resolve, reject } as PendingRequest<unknown>);
      this.drain();
    });
  }

  public close(reason = 'Request coordinator is shutting down'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const error = new BoundedRequestQueueClosedError(reason);
    this.pending.splice(0).forEach(({ reject }) => reject(error));
  }

  public stats() {
    return {
      active: this.active,
      pending: this.pending.length,
      closed: this.closed,
      maxConcurrency: this.options.maxConcurrency,
      maxPending: this.options.maxPending,
    };
  }

  private pruneStarts(current: number): void {
    while (
      this.starts.length > 0 &&
      this.starts[0] <= current - this.intervalMs
    ) {
      this.starts.shift();
    }
  }

  private scheduleDrain(delay: number): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.drain();
      },
      Math.max(1, delay)
    );
    this.timer.unref();
  }

  private drain(): void {
    if (this.closed) return;
    let current = this.now();
    this.pruneStarts(current);
    while (
      this.active < this.options.maxConcurrency &&
      this.pending.length > 0
    ) {
      if (this.starts.length >= this.maxStartsPerInterval) {
        this.scheduleDrain(this.starts[0] + this.intervalMs - current);
        return;
      }
      const request = this.pending.shift();
      if (!request) return;
      this.active += 1;
      this.starts.push(current);
      void request
        .work()
        .then(request.resolve, request.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
      current = this.now();
      this.pruneStarts(current);
    }
  }
}
