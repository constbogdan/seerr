import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
const navigation = readFileSync(
  path.join(__dirname, '..', 'settingsNavigation.ts'),
  'utf8'
);
const page = readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    'pages',
    'settings',
    'watchlist-roulette.tsx'
  ),
  'utf8'
);

describe('Watchlist Roulette settings presentation', () => {
  it('uses the centralized Settings navigation and administrator-only route', () => {
    assert.match(navigation, /route: '\/settings\/watchlist-roulette'/);
    assert.match(navigation, /menuWatchlistRoulette: 'Watchlist Roulette'/);
    assert.match(page, /useRouteGuard\(Permission\.ADMIN\)/);
  });

  it('keeps independent job toggles and configuration fields visible', () => {
    assert.match(source, /watchlist-roulette-movies/);
    assert.match(source, /watchlist-roulette-series/);
    assert.match(source, /movieItemsPerRun/);
    assert.match(source, /seriesItemsPerRun/);
    assert.match(source, /requestOwnerUserId/);
    assert.match(source, /<SlideCheckbox/);
  });

  it('uses compact standard Settings inputs without panel subtitles', () => {
    assert.match(
      source,
      /type="text"[\s\S]*?inputMode="numeric"[\s\S]*?pattern="\[0-9\]\*"/
    );
    assert.match(source, /className="mt-2 h-10 w-full max-w-\[120px\]"/);
    assert.match(source, /className="w-full max-w-\[200px\]"/);
    assert.doesNotMatch(
      source,
      /Randomly request Movies from the aggregated Watchlist\./
    );
    assert.doesNotMatch(
      source,
      /Randomly request Series from the aggregated Watchlist\./
    );
  });

  it('renders safe external links without duplicating scheduler controls', () => {
    assert.match(source, /target="_blank"/);
    assert.match(source, /rel="noopener noreferrer"/);
    assert.doesNotMatch(source, /Run Now/);
    assert.doesNotMatch(source, /cronSchedule/);
  });
});
