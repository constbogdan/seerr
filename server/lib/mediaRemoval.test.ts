import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  SonarrEpisode,
  SonarrEpisodeFile,
} from '@server/api/servarr/sonarr';
import {
  MediaRemovalError,
  buildSeasonRemovalPlan,
} from '@server/lib/mediaRemoval';

const episode = (
  id: number,
  seasonNumber: number,
  episodeFileId: number
): SonarrEpisode => ({ id, seasonNumber, episodeFileId }) as SonarrEpisode;

const file = (id: number): SonarrEpisodeFile => ({ id }) as SonarrEpisodeFile;

describe('buildSeasonRemovalPlan', () => {
  it('deduplicates target EpisodeFiles and includes fileless episodes for unmonitoring', () => {
    assert.deepEqual(
      buildSeasonRemovalPlan({
        episodes: [episode(1, 2, 10), episode(2, 2, 10), episode(3, 2, 0)],
        files: [file(10)],
        seasonNumber: 2,
      }),
      { episodeIds: [1, 2, 3], fileIds: [10] }
    );
  });

  it('does not delete file identifiers absent from the authoritative file list', () => {
    assert.deepEqual(
      buildSeasonRemovalPlan({
        episodes: [episode(1, 2, 10)],
        files: [],
        seasonNumber: 2,
      }),
      { episodeIds: [1], fileIds: [] }
    );
  });

  it('rejects a shared EpisodeFile before any provider mutation is planned', () => {
    assert.throws(
      () =>
        buildSeasonRemovalPlan({
          episodes: [episode(1, 2, 10), episode(2, 3, 10)],
          files: [file(10)],
          seasonNumber: 2,
        }),
      (error) =>
        error instanceof MediaRemovalError && error.code === 'CROSS_SEASON_FILE'
    );
  });
});
