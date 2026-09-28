export class JellyfinCanonicalProcessingCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;

  public runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      this.active += 1;
      try {
        return await work();
      } finally {
        this.active -= 1;
      }
    });

    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  public isRunning(): boolean {
    return this.active > 0;
  }
}

const jellyfinCanonicalProcessingCoordinator =
  new JellyfinCanonicalProcessingCoordinator();

export default jellyfinCanonicalProcessingCoordinator;
