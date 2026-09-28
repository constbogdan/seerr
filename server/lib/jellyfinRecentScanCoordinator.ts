import type { JellyfinScanOutcome } from '@server/lib/scanners/jellyfin';
import { jellyfinRecentScanner } from '@server/lib/scanners/jellyfin';

interface RecentScanner {
  run(): Promise<JellyfinScanOutcome>;
}

export class JellyfinRecentScanCoordinator {
  private activeRun?: Promise<JellyfinScanOutcome>;

  constructor(private readonly scanner: RecentScanner) {}

  public run(): Promise<JellyfinScanOutcome> {
    if (!this.activeRun) {
      const run = this.scanner.run().finally(() => {
        if (this.activeRun === run) {
          this.activeRun = undefined;
        }
      });
      this.activeRun = run;
    }

    return this.activeRun;
  }

  public isRunning(): boolean {
    return !!this.activeRun;
  }
}

const jellyfinRecentScanCoordinator = new JellyfinRecentScanCoordinator(
  jellyfinRecentScanner
);

export default jellyfinRecentScanCoordinator;
