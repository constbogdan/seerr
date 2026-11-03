import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const schedule = readFileSync(path.join(__dirname, 'schedule.ts'), 'utf8');
const jobs = readFileSync(
  path.join(__dirname, 'watchlistRouletteJobs.ts'),
  'utf8'
);

describe('Watchlist Roulette jobs', () => {
  it('registers independent standard day-interval configurable jobs', () => {
    assert.match(
      schedule,
      /id: 'watchlist-roulette-movies'[\s\S]*?interval: 'days'/
    );
    assert.match(
      schedule,
      /id: 'watchlist-roulette-series'[\s\S]*?interval: 'days'/
    );
    assert.match(
      schedule,
      /id: 'watchlist-roulette-movies'[\s\S]*?cronSchedule: jobs\['watchlist-roulette-movies'\]\.schedule/
    );
    assert.match(
      schedule,
      /id: 'watchlist-roulette-series'[\s\S]*?cronSchedule: jobs\['watchlist-roulette-series'\]\.schedule/
    );
    assert.match(
      schedule,
      /setWatchlistRouletteJobEnabled\('watchlist-roulette-movies', enabled\)/
    );
    assert.match(
      schedule,
      /setWatchlistRouletteJobEnabled\('watchlist-roulette-series', enabled\)/
    );
  });

  it('validates the persisted administrator before enabling either job', () => {
    assert.match(jobs, /if \(enabled\) await assertRequestOwner\(\)/);
    assert.match(jobs, /validateWatchlistRouletteRequestOwner/);
    assert.match(jobs, /settings\.jobs\[jobId\]\.enabled = enabled/);
  });

  it('keeps disabled jobs operationally inert', () => {
    assert.match(
      jobs,
      /if \(!watchlistRouletteJobEnabled\('watchlist-roulette-movies'\)\) return null/
    );
    assert.match(
      jobs,
      /if \(!watchlistRouletteJobEnabled\('watchlist-roulette-series'\)\) return null/
    );
  });
});
