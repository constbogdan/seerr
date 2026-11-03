import { MediaType } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import { acquisitionDownload } from '@server/test/acquisitionFixtures';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  finalizingEpisodeLabel,
  type DownloadTitleItem,
} from './downloadTitle';

describe('Finalizing Episode label hints', () => {
  const row: DownloadTitleItem = {
    ...acquisitionDownload(1, {
      title: '',
      acquisitionPhase: AcquisitionPhase.FINALIZING,
    }),
    episode: {
      id: 101,
      seasonNumber: 1,
      episodeNumber: 1,
      absoluteEpisodeNumber: 1,
      title: 'Synthetic Episode',
    },
  };
  it('uses existing coordinates/title without reading providers', () => {
    assert.equal(finalizingEpisodeLabel(row), 'S01E01 — Synthetic Episode');
    assert.equal(
      finalizingEpisodeLabel({
        ...row,
        episode: { ...row.episode!, title: undefined },
      }),
      'S01E01'
    );
  });
  it('leaves normal downloads and Movies untouched', () => {
    assert.equal(
      finalizingEpisodeLabel({
        ...row,
        acquisitionPhase: AcquisitionPhase.DOWNLOADING,
      }),
      undefined
    );
    assert.equal(
      finalizingEpisodeLabel({
        ...row,
        mediaType: MediaType.MOVIE,
        episode: undefined,
      }),
      undefined
    );
  });
  for (const coordinates of [
    { seasonNumber: -1, episodeNumber: 1 },
    { seasonNumber: 1, episodeNumber: 0 },
    { seasonNumber: NaN, episodeNumber: 1 },
    { seasonNumber: 1, episodeNumber: 1.5 },
  ]) {
    it(`does not invent invalid coordinates ${JSON.stringify(coordinates)}`, () => {
      assert.equal(
        finalizingEpisodeLabel({
          ...row,
          episode: { ...row.episode!, ...coordinates },
        }),
        undefined
      );
    });
  }
  it('supports Specials and large Episode numbers without truncating', () => {
    assert.equal(
      finalizingEpisodeLabel({
        ...row,
        episode: { ...row.episode!, seasonNumber: 0, episodeNumber: 123 },
      }),
      'S00E123 — Synthetic Episode'
    );
  });
});
