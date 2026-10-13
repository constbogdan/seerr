import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Current Library Hydration native job', () => {
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
  const hydration = readFileSync(
    path.join(__dirname, '../lib/libraryHistoryHydration.ts'),
    'utf8'
  );
  const currentViewing = readFileSync(
    path.join(__dirname, '../lib/currentJellyfinViewing.ts'),
    'utf8'
  );
  const watchlistPlayState = readFileSync(
    path.join(__dirname, '../lib/watchlistPlayState.ts'),
    'utf8'
  );
  const freshService = readFileSync(
    path.join(__dirname, '../lib/fresh/service.ts'),
    'utf8'
  );
  const jellyfinCoordinator = readFileSync(
    path.join(__dirname, '../lib/jellyfinCanonicalProcessingCoordinator.ts'),
    'utf8'
  );
  const server = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
  const auth = readFileSync(path.join(__dirname, '../routes/auth.ts'), 'utf8');

  it('registers scheduled, manual, startup, and single-flight status through native Jobs', () => {
    assert.match(schedule, /id: 'library-history-hydration'/);
    assert.match(schedule, /name: 'Current Library Hydration'/);
    assert.match(schedule, /void libraryHistoryHydration\.run\(\)/);
    assert.match(
      schedule,
      /running: \(\) => libraryHistoryHydration\.running\(\)/
    );
    assert.match(schedule, /libraryHistoryHydration\.startCatchUp\(\)/);
  });

  it('uses a conservative daily schedule and a native display name', () => {
    assert.match(
      settings,
      /'library-history-hydration': \{[\s\S]*?schedule: '0 30 5 \* \* \*'/
    );
    assert.match(jobsUi, /'library-history-hydration': 'Library Sync'/);
    assert.match(
      jobsUi,
      /'library-history-hydration-description':[\s\S]*?Keeps your Library in sync with your local media files\./
    );
  });

  it('registers ongoing current viewing synchronization at the native Watchlist cadence', () => {
    assert.match(schedule, /id: 'current-jellyfin-viewing-sync'/);
    assert.match(schedule, /name: 'Current Jellyfin Viewing Sync'/);
    assert.match(schedule, /void currentJellyfinViewing\.run\(\)/);
    assert.match(
      schedule,
      /running: \(\) => currentJellyfinViewing\.running\(\)/
    );
    assert.match(schedule, /currentJellyfinViewing\.startCatchUp\(\)/);
    assert.match(
      settings,
      /'current-jellyfin-viewing-sync': \{[\s\S]*?schedule: '45 \*\/5 \* \* \* \*'/
    );
    assert.match(
      jobsUi,
      /'current-jellyfin-viewing-sync': 'Jellyfin Activity Sync'/
    );
    assert.match(
      jobsUi,
      /'current-jellyfin-viewing-sync-description':[\s\S]*?Updates what each user has watched in Jellyfin\./
    );
  });

  it('awaits current-viewing recovery before registering jobs or startup catch-up work', () => {
    const recovery = schedule.indexOf(
      'await currentJellyfinViewing.recoverAbandonedRuns()'
    );
    const firstRegistration = schedule.indexOf('scheduledJobs.push(');
    const catchUp = schedule.indexOf('currentJellyfinViewing.startCatchUp()');
    assert.ok(recovery >= 0);
    assert.ok(recovery < firstRegistration);
    assert.ok(recovery < catchUp);
    assert.match(server, /await startJobs\(\)/);
    assert.equal(auth.match(/await startJobs\(\)/g)?.length, 2);
  });

  it('shares the exclusive background database-write boundary with overlapping jobs', () => {
    for (const source of [
      hydration,
      currentViewing,
      watchlistPlayState,
      freshService,
    ]) {
      assert.match(
        source,
        /backgroundDatabaseWriteCoordinator[\s\S]*?\.runExclusive/
      );
    }
    assert.match(jellyfinCoordinator, /backgroundDatabaseWriteCoordinator/);
  });
});
