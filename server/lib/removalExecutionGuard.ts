export const removalExecutionTargetKey = (canonicalMediaId: number) =>
  `canonical-media:${canonicalMediaId}`;

export class RemovalExecutionGuard {
  private readonly activeKeys = new Set<string>();

  public isActive(key: string): boolean {
    return this.activeKeys.has(key);
  }

  public acquire(key: string): (() => void) | null {
    if (this.activeKeys.has(key)) return null;
    this.activeKeys.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeKeys.delete(key);
    };
  }
}

const removalExecutionGuard = new RemovalExecutionGuard();
export default removalExecutionGuard;
