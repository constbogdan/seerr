import type { LibraryWatchedUser } from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyLibrarySeasonAvailability,
  formatLibraryResolution,
  formatLibrarySize,
  libraryLastActiveTooltip,
  librarySeasonStateClass,
  libraryWatchedLabel,
  libraryWatchedTooltip,
  sortLibraryWatchedUsersForPresentation,
} from './presentation';
import { serializeLibraryQuery } from './query';

const viewer = (init: Partial<LibraryWatchedUser>): LibraryWatchedUser => ({
  key: 'user:1',
  userId: 1,
  displayName: 'Viewer',
  avatar: null,
  watchedEpisodeCount: null,
  availableEpisodeCount: null,
  watchedPercentage: 100,
  lastViewedAt: null,
  ...init,
});

describe('Library factual presentation', () => {
  it('uses the blue acquiring fill and gray dashed border only for otherwise-missing active acquisitions', () => {
    assert.equal(
      librarySeasonStateClass(
        { state: 'known_missing', acquiring: true },
        'missing'
      ),
      'border-dashed border-gray-500 bg-blue-500/20 text-blue-100'
    );
    assert.match(
      librarySeasonStateClass(
        { state: 'known_missing', acquiring: false },
        'missing'
      ),
      /border-dashed border-gray-600/
    );
    assert.doesNotMatch(
      librarySeasonStateClass({ state: 'current', acquiring: true }, 'partial'),
      /blue/
    );
    assert.doesNotMatch(
      librarySeasonStateClass(
        { state: 'current', acquiring: true },
        'available'
      ),
      /blue/
    );
  });

  it('classifies complete, partial, missing, archived, Specials, and unknown Season totals truthfully', () => {
    assert.equal(
      classifyLibrarySeasonAvailability({
        state: 'current',
        availableEpisodeCount: 8,
        knownEpisodeCount: 8,
      }),
      'available'
    );
    assert.equal(
      classifyLibrarySeasonAvailability({
        state: 'current',
        availableEpisodeCount: 4,
        knownEpisodeCount: 8,
      }),
      'partial'
    );
    assert.equal(
      classifyLibrarySeasonAvailability({
        state: 'known_missing',
        availableEpisodeCount: 0,
        knownEpisodeCount: 8,
      }),
      'missing'
    );
    assert.equal(
      classifyLibrarySeasonAvailability({
        state: 'archive',
        availableEpisodeCount: 8,
        knownEpisodeCount: 8,
      }),
      'archive'
    );
    assert.equal(
      classifyLibrarySeasonAvailability({
        state: 'current',
        availableEpisodeCount: 1,
        knownEpisodeCount: 1,
      }),
      'available',
      'Specials use the same factual denominator rules as regular Seasons'
    );
    for (const knownEpisodeCount of [null, 0])
      assert.equal(
        classifyLibrarySeasonAvailability({
          state: 'current',
          availableEpisodeCount: 4,
          knownEpisodeCount,
        }),
        'available_unknown_total'
      );
    assert.equal(
      classifyLibrarySeasonAvailability({
        state: 'current',
        availableEpisodeCount: 5,
        knownEpisodeCount: 4,
      }),
      'available_unknown_total',
      'a contradictory denominator must not imply full or partial availability'
    );
  });

  it('formats Series Watched percentages with exact accessible counts', () => {
    assert.equal(libraryWatchedLabel(viewer({})), '100%');
    assert.equal(libraryWatchedTooltip(viewer({})), 'Viewer · Watched');
    const seriesViewer = viewer({
      watchedEpisodeCount: 8,
      availableEpisodeCount: 12,
      watchedPercentage: 67,
    });
    assert.equal(libraryWatchedLabel(seriesViewer), '67%');
    assert.equal(libraryWatchedTooltip(seriesViewer), 'Viewer · 8/12');
    assert.equal(
      libraryWatchedTooltip(seriesViewer, 'Oct 9, 2026, 4:30 PM'),
      'Viewer · 8/12 · Oct 9, 2026, 4:30 PM'
    );
  });

  it('formats Last Active attribution without labels or watched progress', () => {
    assert.equal(
      libraryLastActiveTooltip('Moni', 'Mar 5, 2026, 2:51 PM'),
      'Moni · Mar 5, 2026, 2:51 PM'
    );
    assert.equal(libraryLastActiveTooltip('Moni'), 'Moni');
    assert.deepEqual(
      ['Moni', 'Bogdan'].map((name) =>
        libraryLastActiveTooltip(name, 'Mar 5, 2026, 2:51 PM')
      ),
      ['Moni · Mar 5, 2026, 2:51 PM', 'Bogdan · Mar 5, 2026, 2:51 PM']
    );
    assert.doesNotMatch(
      libraryLastActiveTooltip('Moni', 'Mar 5, 2026, 2:51 PM'),
      /Last active:|\d+\/\d+|%/
    );
  });

  it('formats physical sizes', () => {
    assert.equal(formatLibrarySize(String(9.9 * 1024 ** 3)), '9.9 GB');
    assert.equal(formatLibrarySize(String(38.4 * 1024 ** 3)), '38.4 GB');
    assert.equal(formatLibrarySize(String(999.9 * 1024 ** 3)), '999.9 GB');
    assert.equal(formatLibrarySize(String(1.2 * 1024 ** 4)), '1.2 TB');
    assert.equal(formatLibrarySize(null), '—');
  });

  it('labels only supported uniform Library resolutions', () => {
    assert.equal(formatLibraryResolution(1080), '1080p');
    assert.equal(formatLibraryResolution(2160), '2160p');
    assert.equal(formatLibraryResolution(720), null);
    assert.equal(formatLibraryResolution(null), null);
  });

  it('orders watched users by completion then stable user identity without mutating facts', () => {
    const users = [
      viewer({ key: 'user:4', userId: 4, watchedPercentage: 44 }),
      viewer({ key: 'user:3', userId: 3, watchedPercentage: 100 }),
      viewer({ key: 'user:9', userId: 9, watchedPercentage: 83 }),
      viewer({ key: 'user:1', userId: 1, watchedPercentage: 100 }),
      viewer({ key: 'viewer:z', userId: null, watchedPercentage: 25 }),
      viewer({ key: 'viewer:a', userId: null, watchedPercentage: 25 }),
    ];

    assert.deepEqual(
      sortLibraryWatchedUsersForPresentation(users).map((user) => user.key),
      ['user:1', 'user:3', 'user:9', 'user:4', 'viewer:a', 'viewer:z']
    );
    assert.deepEqual(
      users.map((user) => user.key),
      ['user:4', 'user:3', 'user:9', 'user:1', 'viewer:z', 'viewer:a']
    );
  });

  it('serializes stable multi-word search and factual filters', () => {
    const params = new URLSearchParams({
      search: 'a spy among friends',
      scope: 'archive',
      watchlist: 'yes',
      watched: 'yes',
      sort: 'lastActive',
      collectionMembership: 'none',
    });
    assert.equal(
      serializeLibraryQuery(params),
      'collectionMembership=none&scope=archive&search=a%20spy%20among%20friends&sort=lastActive&watched=yes&watchlist=yes'
    );
    assert.equal(
      serializeLibraryQuery(new URLSearchParams({ search: 'a + spy' })),
      'search=a%20%2B%20spy'
    );
  });
});
