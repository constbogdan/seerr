import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectNextSeasonUpcomingRows } from './upcoming';

describe('Next Season Upcoming presentation', () => {
  it('shows only requestable dry-run outcomes with exact Series, Season, and viewer', () => {
    assert.deepEqual(
      selectNextSeasonUpcomingRows({
        status: 'succeeded',
        failed: 0,
        candidates: [
          {
            canonicalMediaId: 10,
            tmdbId: 100,
            seasonNumber: 4,
            outcome: 'would-request',
            title: 'Foundation',
            qualifyingViewer: 'Example viewer',
            qualifyingLastViewedAt: '2026-10-23T11:55:00.000Z',
          },
          {
            canonicalMediaId: 11,
            tmdbId: 101,
            seasonNumber: 2,
            outcome: 'already-requested',
            title: 'Requested',
            qualifyingViewer: 'Viewer',
          },
          {
            canonicalMediaId: 12,
            tmdbId: 102,
            seasonNumber: 3,
            outcome: 'active-acquisition',
            title: 'Acquiring',
            qualifyingViewer: 'Viewer',
          },
        ],
      }),
      [
        {
          key: '10:4',
          seriesTitle: 'Foundation',
          seasonNumber: 4,
          href: '/tv/100',
          viewer: 'Example viewer',
          lastWatchedAt: '2026-10-23T11:55:00.000Z',
          status: 'eligible',
        },
      ]
    );
  });

  it('supports multiple Seasons and fails closed for incomplete or failed evaluation data', () => {
    assert.equal(
      selectNextSeasonUpcomingRows({
        status: 'succeeded',
        failed: 0,
        candidates: [
          {
            canonicalMediaId: 1,
            tmdbId: 101,
            seasonNumber: 2,
            outcome: 'would-request',
            title: 'Series',
            qualifyingViewer: 'One',
            qualifyingLastViewedAt: '2026-10-23T11:55:00.000Z',
          },
          {
            canonicalMediaId: 1,
            tmdbId: 101,
            seasonNumber: 4,
            outcome: 'would-request',
            title: 'Series',
            qualifyingViewer: 'Two',
            qualifyingLastViewedAt: '2026-10-23T11:50:00.000Z',
          },
        ],
      }).length,
      2
    );
    assert.deepEqual(
      selectNextSeasonUpcomingRows({
        status: 'failed',
        failed: 1,
        candidates: [],
      }),
      []
    );
    assert.deepEqual(
      selectNextSeasonUpcomingRows({
        status: 'succeeded',
        failed: 0,
        candidates: [
          {
            canonicalMediaId: 1,
            tmdbId: 101,
            seasonNumber: 2,
            outcome: 'would-request',
          },
        ],
      }),
      []
    );
  });

  it('deduplicates canonical targets and orders Series and Seasons deterministically', () => {
    const candidate = (
      canonicalMediaId: number,
      tmdbId: number,
      title: string,
      seasonNumber: number
    ) => ({
      canonicalMediaId,
      tmdbId,
      title,
      seasonNumber,
      outcome: 'would-request',
      qualifyingViewer: 'Viewer',
      qualifyingLastViewedAt: '2026-10-23T11:55:00.000Z',
    });
    const rows = selectNextSeasonUpcomingRows({
      status: 'succeeded',
      failed: 0,
      candidates: [
        candidate(2, 202, 'Zulu', 3),
        candidate(1, 101, 'Alpha', 4),
        candidate(1, 101, 'Alpha', 2),
        candidate(1, 101, 'Alpha', 2),
      ],
    });

    assert.deepEqual(
      rows.map(({ key, href }) => ({ key, href })),
      [
        { key: '1:2', href: '/tv/101' },
        { key: '1:4', href: '/tv/101' },
        { key: '2:3', href: '/tv/202' },
      ]
    );
  });
});
