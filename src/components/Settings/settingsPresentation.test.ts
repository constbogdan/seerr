import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Settings jobs and navigation presentation', () => {
  const jobs = readFileSync(
    path.join(__dirname, 'SettingsJobsCache/index.tsx'),
    'utf8'
  );
  const layout = readFileSync(
    path.join(__dirname, 'SettingsLayout.tsx'),
    'utf8'
  );

  it('gives every downstream job a concise user-facing description', () => {
    for (const description of [
      'Updates what each user has watched in Jellyfin.',
      'Keeps your Library in sync with your local media files.',
      'Finds new releases matching your selected discovery sources.',
      'Keeps Fresh results up to date as media becomes available or changes.',
      'Finds media eligible for scheduled removal.',
      'Processes scheduled removals when their deadlines arrive.',
      'Adds missing genre information to Watchlist items.',
      "Updates watched status and progress for each user's Watchlist.",
    ]) {
      assert.ok(jobs.includes(description), description);
    }
  });

  it('sorts by the localized displayed name with a deterministic tie-break', () => {
    assert.match(jobs, /const orderedJobs = data\?\.slice\(\)\.sort/);
    assert.match(jobs, /formatMessage\(jobMessages\[left\.id\]/);
    assert.match(
      jobs,
      /displayedNameOrder \|\| left\.id\.localeCompare\(right\.id, locale\)/
    );
  });

  it('places Removal immediately after Discovery Sources and before Notifications', () => {
    const discovery = layout.indexOf(
      "route: '/settings/discovery-sources/fresh'"
    );
    const removal = layout.indexOf("route: '/settings/removal'");
    const notifications = layout.indexOf(
      "route: '/settings/notifications/email'"
    );
    assert.ok(discovery > -1);
    assert.ok(removal > discovery);
    assert.ok(notifications > removal);
    assert.equal(
      (layout.match(/route: '\/settings\/removal'/g) ?? []).length,
      1
    );
  });
});
