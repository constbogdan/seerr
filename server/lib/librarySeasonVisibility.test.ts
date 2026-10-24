import { MediaRequestStatus, MediaType } from '@server/constants/media';
import {
  activeLibraryRequestSeasonNumbers,
  isLibrarySeasonVisible,
} from '@server/lib/library';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const today = '2026-10-24';

describe('Library Season TMDB visibility', () => {
  it('shows aired regular Seasons and hides future, unknown, and Specials', () => {
    const seasons = [
      { seasonNumber: 1, airDate: '2024-01-01' },
      { seasonNumber: 2, airDate: '2026-10-25' },
      { seasonNumber: 3, airDate: null },
    ];
    const missing = (seasonNumber: number) => ({
      seasonNumber,
      isSpecial: seasonNumber === 0,
      state: 'known_missing' as const,
    });
    assert.equal(isLibrarySeasonVisible(missing(1), seasons, today), true);
    assert.equal(isLibrarySeasonVisible(missing(2), seasons, today), false);
    assert.equal(isLibrarySeasonVisible(missing(3), seasons, today), false);
    assert.equal(isLibrarySeasonVisible(missing(0), seasons, today), false);
  });

  it('preserves current and historical physical Seasons despite TMDB metadata', () => {
    for (const state of ['current', 'archive'] as const) {
      assert.equal(
        isLibrarySeasonVisible(
          { seasonNumber: 4, isSpecial: false, state },
          [{ seasonNumber: 4, airDate: null }],
          today
        ),
        true
      );
    }
  });

  it('marks only exact active non-4K Season requests as acquiring', () => {
    const baseRequest = {
      id: 1,
      type: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      is4k: false,
      isAutoRequest: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const season = (seasonNumber: number, status: MediaRequestStatus) => ({
      id: seasonNumber,
      seasonNumber,
      status,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const active = activeLibraryRequestSeasonNumbers([
      {
        id: 1,
        displayName: 'Viewer',
        avatar: null,
        requests: [
          {
            ...baseRequest,
            seasons: [
              season(2, MediaRequestStatus.APPROVED),
              season(3, MediaRequestStatus.DECLINED),
              season(4, MediaRequestStatus.COMPLETED),
            ],
          },
          {
            ...baseRequest,
            id: 2,
            is4k: true,
            seasons: [season(5, MediaRequestStatus.APPROVED)],
          },
          {
            ...baseRequest,
            id: 3,
            status: MediaRequestStatus.FAILED,
            seasons: [season(6, MediaRequestStatus.APPROVED)],
          },
        ],
      },
    ]);
    assert.deepEqual([...active], [2]);
  });
});
