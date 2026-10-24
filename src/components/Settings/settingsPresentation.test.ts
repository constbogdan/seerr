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
  const navigation = readFileSync(
    path.join(__dirname, 'settingsNavigation.ts'),
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
      'Automatically relocates eligible Series between storage volumes.',
      'Automatically requests the next season when viewing progress reaches 70%.',
      'Adds missing genre information to Watchlist items.',
      "Updates watched status and progress for each user's Watchlist.",
    ]) {
      assert.ok(jobs.includes(description), description);
    }
    assert.doesNotMatch(
      jobs,
      /Moves at most one eligible whole Series from the default volume to the expansion volume\./
    );
  });

  it('sorts by the localized displayed name with a deterministic tie-break', () => {
    assert.match(jobs, /const orderedJobs = data\?\.slice\(\)\.sort/);
    assert.match(jobs, /formatMessage\(jobMessages\[left\.id\]/);
    assert.match(
      jobs,
      /displayedNameOrder \|\| left\.id\.localeCompare\(right\.id, locale\)/
    );
  });

  it('uses the status column as the only configurable-job enabled-state presentation', () => {
    assert.doesNotMatch(jobs, /<SlideCheckbox/);
    assert.doesNotMatch(jobs, /setJobEnabled/);
    assert.doesNotMatch(jobs, /messages\.enabled/);
    assert.match(
      jobs,
      /'watchlist-roulette-movies': 'Watchlist Roulette Movies'/
    );
    assert.match(
      jobs,
      /'watchlist-roulette-series': 'Watchlist Roulette Series'/
    );
    assert.match(jobs, /'series-relocation': 'Series Relocation'/);
    assert.match(
      jobs,
      /!job\.enabled \? \([\s\S]*?intl\.formatMessage\(messages\.disabled\)/
    );
    assert.match(
      jobs,
      /job\.type === 'process' \? 'primary' : 'warning'[\s\S]*?messages\.process/
    );
    assert.match(
      jobs,
      /onClick=\{\(\) => dispatch\(\{ type: 'open', job \}\)\}/
    );
    assert.match(
      jobs,
      /disabled=\{!job\.enabled \|\| !job\.manualExecutionAllowed\}/
    );
  });

  it('uses the standard interval-based Modify Job editor', () => {
    assert.match(
      jobs,
      /interval: 'seconds' \| 'minutes' \| 'hours' \| 'days' \| 'fixed'/
    );
    assert.match(jobs, /\[1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30\]/);
    assert.doesNotMatch(jobs, /interval === 'weekly'/);
    assert.doesNotMatch(jobs, /interval === 'monthly'/);
    assert.doesNotMatch(
      jobs,
      /scheduleWeekday|scheduleDayOfMonth|scheduleHourOfDay/
    );
  });

  it('links the independent Next Season settings page after Watchlist Roulette', () => {
    const roulette = navigation.indexOf(
      "route: '/settings/watchlist-roulette'"
    );
    const nextSeason = navigation.indexOf("route: '/settings/next-season'");
    const network = navigation.indexOf("route: '/settings/network'");
    assert.ok(roulette > -1);
    assert.ok(nextSeason > roulette);
    assert.ok(network > nextSeason);
  });

  it('places Removal immediately after Discovery Sources and before Notifications', () => {
    const discovery = navigation.indexOf(
      "route: '/settings/discovery-sources/fresh'"
    );
    const removal = navigation.indexOf("route: '/settings/removal'");
    const notifications = navigation.indexOf(
      "route: '/settings/notifications/email'"
    );
    assert.ok(discovery > -1);
    assert.ok(removal > discovery);
    assert.ok(notifications > removal);
    assert.equal(
      (navigation.match(/route: '\/settings\/removal'/g) ?? []).length,
      1
    );
  });

  it('exposes the administrator Storage page after Services', () => {
    const services = navigation.indexOf("route: '/settings/services'");
    const storage = navigation.indexOf("route: '/settings/storage'");
    const network = navigation.indexOf("route: '/settings/network'");
    assert.ok(services > -1);
    assert.ok(storage > services);
    assert.ok(network > storage);
    assert.equal(
      (navigation.match(/route: '\/settings\/storage'/g) ?? []).length,
      1
    );
  });

  it('uses the shared Settings inventory and renders only the compact page selector', () => {
    assert.match(layout, /useSettingsNavigation\(\)/);
    assert.match(
      layout,
      /<SettingsNavigationSelector routes=\{settingsRoutes\}/
    );
    assert.doesNotMatch(layout, /<SettingsTabs/);
    assert.equal(
      (navigation.match(/route: '\/settings\/notifications\/email'/g) ?? [])
        .length,
      1
    );
  });
});
