export class BackgroundDatabaseWriteCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;
  private busy = false;

  public runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const execute = async () => {
      this.active += 1;
      try {
        return await work();
      } finally {
        this.active -= 1;
      }
    };
    const run = this.busy ? this.tail.then(execute) : execute();

    this.busy = true;
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.tail = tail;
    void tail.finally(() => {
      if (this.tail === tail) this.busy = false;
    });
    return run;
  }

  public isRunning(): boolean {
    return this.active > 0;
  }
}

const backgroundDatabaseWriteCoordinator =
  new BackgroundDatabaseWriteCoordinator();

export default backgroundDatabaseWriteCoordinator;
