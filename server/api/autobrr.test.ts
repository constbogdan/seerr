import { parseFilters, parseReleasePage } from '@server/api/autobrr';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 20,
  title: 'Example Movie',
  year: 2026,
  type: 9,
  timestamp: '2026-09-26T10:00:00Z',
  filter_status: 'FILTER_APPROVED',
  source: 'WEB-DL',
  action_status: [{ filter_id: 7, status: 'PUSH_APPROVED' }],
  download_url: 'https://tracker.invalid/private?passkey=secret',
  info_url: 'https://tracker.invalid/details/20',
  ...overrides,
});

describe('autobrr Fresh boundary', () => {
  it('retains only safe fields for releases proven against the numeric filter', () => {
    const parsed = parseReleasePage(
      {
        data: [
          row(),
          row({
            id: 19,
            title: 'Example Show',
            year: 0,
            type: 6,
          }),
          row({
            id: 18,
            title: 'Other Filter',
            action_status: [{ filter_id: 8 }],
          }),
          row({ id: 17, title: 'Missing Movie Year', year: 0 }),
        ],
        next_cursor: 17,
      },
      { id: 7 }
    );

    assert.deepEqual(parsed.releaseIds, ['20', '19', '18', '17']);
    assert.deepEqual(parsed.releases, [
      {
        releaseId: '20',
        mediaType: 'movie',
        title: 'Example Movie',
        sourceTitle: 'Example Movie',
        year: 2026,
        seasonNumber: -1,
        episodeNumber: -1,
        explicitSeason: false,
        explicitSpecial: false,
        observedAt: Date.parse('2026-09-26T10:00:00Z'),
        availabilityType: 'digital',
      },
      {
        releaseId: '19',
        mediaType: 'tv',
        title: 'Example Show',
        sourceTitle: 'Example Show',
        year: 0,
        seasonNumber: -1,
        episodeNumber: -1,
        explicitSeason: false,
        explicitSpecial: false,
        observedAt: Date.parse('2026-09-26T10:00:00Z'),
        availabilityType: 'digital',
      },
    ]);
    assert.equal(parsed.counts.inspected, 4);
    assert.equal(parsed.counts.selectedFilter, 3);
    assert.doesNotMatch(JSON.stringify(parsed), /tracker|passkey|download_url/);
  });

  it('reduces release sources to safe availability classes', () => {
    const parsed = parseReleasePage(
      {
        data: [
          row({ id: 20, source: 'WEB-DL' }),
          row({ id: 19, source: 'BluRay' }),
          row({ id: 18, source: 'UHD BluRay' }),
          row({ id: 17, source: 'CAM' }),
        ],
        next_cursor: 17,
      },
      { id: 7 }
    );

    assert.deepEqual(
      parsed.releases.map((release) => release.availabilityType),
      ['digital', 'physical', 'physical', 'unknown']
    );
    assert.doesNotMatch(JSON.stringify(parsed.releases), /WEB-DL|BluRay|CAM/);
  });

  it('preserves bounded explicit TV season and special evidence without raw payloads', () => {
    const parsed = parseReleasePage(
      {
        data: [
          row({
            id: 20,
            type: 6,
            title: 'Last Week Tonight with John Oliver',
            torrent_name: 'Last.Week.Tonight.with.John.Oliver.S13E24.1080p',
            season: 13,
            episode: 24,
          }),
          row({
            id: 19,
            type: 11,
            title: 'Example Special',
            torrent_name: 'Example.Special.S00E14.1080p',
            season: 0,
            episode: 14,
          }),
          row({
            id: 18,
            type: 6,
            title: 'Unknown Season',
            torrent_name: 'Unknown.Season.1080p',
            season: 0,
            episode: 0,
          }),
        ],
        next_cursor: 18,
      },
      { id: 7 }
    );

    assert.deepEqual(
      parsed.releases.map((release) => ({
        title: release.title,
        sourceTitle: release.sourceTitle,
        season: release.seasonNumber,
        episode: release.episodeNumber,
        explicitSeason: release.explicitSeason,
        explicitSpecial: release.explicitSpecial,
      })),
      [
        {
          title: 'Last Week Tonight with John Oliver',
          sourceTitle: 'Last.Week.Tonight.with.John.Oliver.S13E24.1080p',
          season: 13,
          episode: 24,
          explicitSeason: true,
          explicitSpecial: false,
        },
        {
          title: 'Example Special',
          sourceTitle: 'Example.Special.S00E14.1080p',
          season: 0,
          episode: 14,
          explicitSeason: false,
          explicitSpecial: true,
        },
        {
          title: 'Unknown Season',
          sourceTitle: 'Unknown.Season.1080p',
          season: 0,
          episode: 0,
          explicitSeason: false,
          explicitSpecial: false,
        },
      ]
    );
    assert.doesNotMatch(
      JSON.stringify(parsed.releases),
      /download_url|action_status|passkey|tracker\.invalid/
    );
  });

  it('does not invent season evidence from date-named TV releases', () => {
    for (const sourceTitle of [
      'The.Price.Is.Right.2026.09.29.1080p.WEB-DL',
      'The Price Is Right 2026-09-29 1080p WEB-DL',
      'The Price Is Right 2026 09 29 1080p WEB-DL',
    ]) {
      const [release] = parseReleasePage(
        {
          data: [
            row({
              id: 20,
              type: 6,
              title: 'The Price Is Right',
              torrent_name: sourceTitle,
              season: 0,
              episode: 0,
            }),
          ],
          next_cursor: 20,
        },
        { id: 7 }
      ).releases;
      assert.equal(release.explicitSeason, false);
      assert.equal(release.explicitSpecial, false);
      assert.equal(release.seasonNumber, 0);
      assert.equal(release.episodeNumber, 0);
    }
  });

  it('fails closed for malformed ordering and cursor boundaries', () => {
    assert.throws(() =>
      parseReleasePage(
        { data: [row({ id: 20 }), row({ id: 20 })], next_cursor: 20 },
        { id: 7 }
      )
    );
    assert.throws(() =>
      parseReleasePage({ data: [row({ id: 20 })], next_cursor: 19 }, { id: 7 })
    );
    assert.throws(() =>
      parseReleasePage(
        { data: [row({ id: 21 })], next_cursor: 21 },
        { id: 7 },
        20
      )
    );
  });

  it('accepts only unique, positive, browser-safe filter metadata', () => {
    assert.deepEqual(
      parseFilters([{ id: 7, name: ' Fresh ', enabled: true }]),
      [{ id: 7, name: 'Fresh', enabled: true }]
    );
    assert.throws(() =>
      parseFilters([
        { id: 7, name: 'Fresh' },
        { id: 7, name: 'Duplicate' },
      ])
    );
    assert.throws(() =>
      parseFilters([{ id: 7, name: 'https://private.invalid/token' }])
    );
  });
});
