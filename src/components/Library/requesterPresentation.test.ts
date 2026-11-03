import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type {
  LibraryRequestFact,
  LibraryRequester,
} from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLibraryRequesterDetailRows } from './requesterPresentation';

const request = (
  id: number,
  type: LibraryRequestFact['type'],
  seasons: LibraryRequestFact['seasons'] = []
): LibraryRequestFact => ({
  id,
  type,
  status: MediaRequestStatus.COMPLETED,
  is4k: false,
  isAutoRequest: false,
  createdAt: `2026-09-0${id}T18:10:00.000Z`,
  updatedAt: `2026-09-0${id}T18:10:00.000Z`,
  seasons,
});

const requester = (requests: LibraryRequestFact[]): LibraryRequester => ({
  id: 7,
  displayName: 'Bogdan',
  avatar: null,
  requests,
});

const season = (
  id: number,
  seasonNumber: number,
  status: MediaRequestStatus
): LibraryRequestFact['seasons'][number] => ({
  id,
  seasonNumber,
  status,
  createdAt: `2026-09-0${id}T19:10:00.000Z`,
  updatedAt: `2026-09-0${id}T19:10:00.000Z`,
});

describe('Library requester tooltip rows', () => {
  it('shows only the factual Season row for a single-Season request', () => {
    const rows = getLibraryRequesterDetailRows(
      requester([
        request(1, MediaType.TV, [season(1, 1, MediaRequestStatus.COMPLETED)]),
      ])
    );

    assert.deepEqual(
      rows.map((row) => row.kind),
      ['season']
    );
    assert.equal(rows[0].kind === 'season' && rows[0].season.seasonNumber, 1);
  });

  it('preserves multiple Seasons and their distinct statuses', () => {
    const rows = getLibraryRequesterDetailRows(
      requester([
        request(1, MediaType.TV, [
          season(1, 1, MediaRequestStatus.COMPLETED),
          season(2, 2, MediaRequestStatus.APPROVED),
          season(3, 3, MediaRequestStatus.PENDING),
        ]),
      ])
    );

    assert.deepEqual(
      rows.map((row) =>
        row.kind === 'season'
          ? [row.season.seasonNumber, row.season.status]
          : null
      ),
      [
        [1, MediaRequestStatus.COMPLETED],
        [2, MediaRequestStatus.APPROVED],
        [3, MediaRequestStatus.PENDING],
      ]
    );
  });

  it('keeps a general fallback for Movie and Series requests without Seasons', () => {
    const rows = getLibraryRequesterDetailRows(
      requester([request(1, MediaType.MOVIE), request(2, MediaType.TV)])
    );

    assert.deepEqual(
      rows.map((row) =>
        row.kind === 'request' ? [row.request.type, row.request.id] : null
      ),
      [
        ['movie', 1],
        ['tv', 2],
      ]
    );
  });

  it('preserves multiple requests by one user while suppressing only redundant parents', () => {
    const rows = getLibraryRequesterDetailRows(
      requester([
        request(1, MediaType.TV, [season(1, 1, MediaRequestStatus.COMPLETED)]),
        request(2, MediaType.TV),
      ])
    );

    assert.deepEqual(
      rows.map((row) => [row.kind, row.request.id]),
      [
        ['season', 1],
        ['request', 2],
      ]
    );
  });

  it('retains overlapping Season facts from distinct request records', () => {
    const rows = getLibraryRequesterDetailRows(
      requester([
        request(1, MediaType.TV, [season(1, 2, MediaRequestStatus.COMPLETED)]),
        request(2, MediaType.TV, [season(2, 2, MediaRequestStatus.APPROVED)]),
      ])
    );

    assert.deepEqual(
      rows.map((row) =>
        row.kind === 'season'
          ? [row.request.id, row.season.seasonNumber, row.season.status]
          : null
      ),
      [
        [1, 2, MediaRequestStatus.COMPLETED],
        [2, 2, MediaRequestStatus.APPROVED],
      ]
    );
  });
});
