import {
  assertCompleteSeriesRequest,
  InvalidRequestSeasonsError,
  resolveRequestedSeasons,
} from '@server/lib/requestSeasonValidation';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const seasons = [
  { season_number: 0, episode_count: 2 },
  { season_number: 1, episode_count: 10 },
  { season_number: 2, episode_count: 8 },
  { season_number: 3, episode_count: 0 },
];

describe('request Season validation', () => {
  it('accepts only actual non-empty Seasons and preserves all-Series semantics', () => {
    assert.deepEqual(
      resolveRequestedSeasons({
        requestedSeasons: 'all',
        tmdbSeasons: seasons,
        enableSpecialEpisodes: true,
      }),
      [1, 2]
    );
    assert.deepEqual(
      resolveRequestedSeasons({
        requestedSeasons: [0, 2],
        tmdbSeasons: seasons,
        enableSpecialEpisodes: true,
      }),
      [0, 2]
    );
  });

  for (const invalid of [
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1],
    [3],
    [99],
  ]) {
    it(`rejects invalid Season selection ${String(invalid[0])}`, () => {
      assert.throws(
        () =>
          resolveRequestedSeasons({
            requestedSeasons: invalid,
            tmdbSeasons: seasons,
            enableSpecialEpisodes: true,
          }),
        InvalidRequestSeasonsError
      );
    });
  }

  it('rejects duplicate Seasons and disabled Specials', () => {
    assert.throws(
      () =>
        resolveRequestedSeasons({
          requestedSeasons: [1, 1],
          tmdbSeasons: seasons,
          enableSpecialEpisodes: true,
        }),
      InvalidRequestSeasonsError
    );
    assert.throws(
      () =>
        resolveRequestedSeasons({
          requestedSeasons: [0],
          tmdbSeasons: seasons,
          enableSpecialEpisodes: false,
        }),
      InvalidRequestSeasonsError
    );
  });

  it('requires the complete currently requestable set when partial requests are disabled', () => {
    assert.throws(
      () =>
        assertCompleteSeriesRequest({
          requestedSeasons: [1],
          requestableSeasons: [1, 2],
          partialRequestsEnabled: false,
        }),
      InvalidRequestSeasonsError
    );
    assert.doesNotThrow(() =>
      assertCompleteSeriesRequest({
        requestedSeasons: [2, 1],
        requestableSeasons: [1, 2],
        partialRequestsEnabled: false,
      })
    );
  });
});
