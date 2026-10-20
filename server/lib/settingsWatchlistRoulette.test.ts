import {
  DEFAULT_WATCHLIST_ROULETTE_SETTINGS,
  normalizeWatchlistRouletteSettings,
} from '@server/constants/watchlistRoulette';
import Settings, {
  normalizeWatchlistRouletteJobSchedules,
} from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Watchlist Roulette settings', () => {
  it('defaults both jobs to disabled with the agreed schedules', () => {
    const settings = new Settings();
    assert.deepEqual(settings.watchlistRoulette, {
      requestOwnerUserId: null,
      movieItemsPerRun: 3,
      seriesItemsPerRun: 1,
    });
    assert.deepEqual(settings.jobs['watchlist-roulette-movies'], {
      schedule: '0 0 1 */7 * *',
      enabled: false,
    });
    assert.deepEqual(settings.jobs['watchlist-roulette-series'], {
      schedule: '0 0 1 */30 * *',
      enabled: false,
    });
  });

  it('normalizes malformed legacy values without enabling anything', () => {
    assert.deepEqual(
      normalizeWatchlistRouletteSettings({
        requestOwnerUserId: -1,
        movieItemsPerRun: 0,
        seriesItemsPerRun: 101,
      }),
      DEFAULT_WATCHLIST_ROULETTE_SETTINGS
    );
  });

  it('replaces only the obsolete Roulette calendar defaults', () => {
    const jobs = {
      'watchlist-roulette-movies': {
        schedule: '0 0 2 * * 0',
        enabled: true,
      },
      'watchlist-roulette-series': {
        schedule: '0 0 2 1 * *',
        enabled: false,
      },
      'fresh-sync': { schedule: '0 */5 * * * *' },
    } as Parameters<typeof normalizeWatchlistRouletteJobSchedules>[0];

    assert.deepEqual(normalizeWatchlistRouletteJobSchedules(jobs), {
      'watchlist-roulette-movies': {
        schedule: '0 0 1 */7 * *',
        enabled: true,
      },
      'watchlist-roulette-series': {
        schedule: '0 0 1 */30 * *',
        enabled: false,
      },
      'fresh-sync': { schedule: '0 */5 * * * *' },
    });

    assert.equal(
      normalizeWatchlistRouletteJobSchedules({
        ...jobs,
        'watchlist-roulette-movies': { schedule: '0 0 1 */14 * *' },
      })['watchlist-roulette-movies'].schedule,
      '0 0 1 */14 * *'
    );
  });

  it('retains compact valid request-ID run summaries', () => {
    const normalized = normalizeWatchlistRouletteSettings({
      requestOwnerUserId: 4,
      movieItemsPerRun: 5,
      seriesItemsPerRun: 2,
      lastMovieRun: {
        startedAt: '2026-10-19T00:00:00.000Z',
        completedAt: '2026-10-19T00:01:00.000Z',
        status: 'succeeded',
        requested: 1,
        skipped: 2,
        failed: 0,
        examined: 3,
        requestIds: [44],
      },
    });
    assert.equal(normalized.requestOwnerUserId, 4);
    assert.deepEqual(normalized.lastMovieRun?.requestIds, [44]);
  });
});
