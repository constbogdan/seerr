import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Watchlist play-state native job', () => {
  const schedule = readFileSync(path.join(__dirname, 'schedule.ts'), 'utf8');
  const settings = readFileSync(
    path.join(__dirname, '../lib/settings/index.ts'),
    'utf8'
  );
  const jobsUi = readFileSync(
    path.join(
      __dirname,
      '../../src/components/Settings/SettingsJobsCache/index.tsx'
    ),
    'utf8'
  );

  it('registers startup, scheduled, manual, running, and cancellation behavior', () => {
    assert.match(schedule, /id: 'watchlist-play-state-sync'/);
    assert.match(schedule, /name: 'Watchlist Play State Sync'/);
    assert.match(schedule, /void watchlistPlayStateSync\.run\(\)/);
    assert.match(
      schedule,
      /running: \(\) => watchlistPlayStateSync\.running\(\)/
    );
    assert.match(
      schedule,
      /cancelFn: \(\) => watchlistPlayStateSync\.cancel\(\)/
    );
    assert.match(schedule, /watchlistPlayStateSync\.startCatchUp\(\)/);
    assert.match(
      readFileSync(
        path.join(__dirname, '../lib/watchlistPlayState.ts'),
        'utf8'
      ),
      /STARTUP_RETRY_LIMIT = 12[\s\S]*?isRetryableWatchlistStartupError/
    );
  });

  it('uses a five-minute offset schedule and a native Jobs display name', () => {
    assert.match(
      settings,
      /'watchlist-play-state-sync': \{[\s\S]*?schedule: '30 \*\/5 \* \* \* \*'/
    );
    assert.match(
      jobsUi,
      /'watchlist-play-state-sync': 'Watchlist Play State Sync'/
    );
    assert.match(
      jobsUi,
      /'watchlist-play-state-sync-description':[\s\S]*?Reconciles current per-user watched state/
    );
    assert.match(
      jobsUi,
      /'watchlist-metadata-backfill-description':[\s\S]*?Fills missing TMDB genre metadata/
    );
    assert.match(
      jobsUi,
      /jobMessages\['jellyfin-recently-added-scan'\][\s\S]*?jobMessages\['jellyfin-full-scan'\][\s\S]*?const orderedJobs/
    );
    assert.doesNotMatch(
      jobsUi,
      /messages\['jellyfin-(?:recently-added|full)-scan'\]\s*=/
    );
    assert.match(jobsUi, /\.sort\(\(left, right\) =>/);
  });
});
