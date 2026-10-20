import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  SonarrEpisodeFile,
  SonarrHistoryRecord,
  SonarrSeries,
  SonarrSeriesMoveCommand,
} from '@server/api/servarr/sonarr';
import {
  evaluateSeriesRelocationFacts,
  reconcileSeriesMoveSnapshot,
  resolveCurrentSeriesImports,
  resolveSonarrSeriesUrl,
  verifySeriesMoveSnapshot,
  type SeriesRelocationFacts,
} from '@server/lib/seriesRelocation';
import type { SonarrSettings } from '@server/lib/settings';
import type { PhysicalVolume } from '@server/lib/storageSettings';

const now = new Date('2026-10-18T12:00:00.000Z');

const file = (id: number, seasonNumber: number): SonarrEpisodeFile => ({
  id,
  seriesId: 20,
  seasonNumber,
  size: 100,
  dateAdded: '2026-10-01T00:00:00.000Z',
  path: `/volume3/shows/Series/Season ${seasonNumber}/${id}.mkv`,
});

const imported = (
  episodeFileId: number,
  client: string,
  date = '2026-10-01T00:00:00.000Z'
): SonarrHistoryRecord =>
  ({
    id: episodeFileId,
    seriesId: 20,
    episodeId: episodeFileId,
    sourceTitle: `release-${episodeFileId}`,
    eventType: 'downloadFolderImported',
    date,
    data: { FileId: String(episodeFileId), DownloadClient: client },
  }) as SonarrHistoryRecord;

const volume: PhysicalVolume = {
  id: 'physical:volume9',
  name: 'Volume 9',
  volumeKey: 'volume9',
  locationIds: [],
  segments: [],
  totalSpace: 10_000,
  usedSpace: 1_000,
  freeSpace: 9_000,
  usedPercentage: 10,
  knownLibraryUsageBytes: '0',
  pendingRemovalBytes: '0',
  pendingRemovalPercentage: null,
  pendingRemovalAvailable: true,
  pendingRemovalComplete: true,
  omittedRemovalScheduleCount: 0,
  unaccountedUsageBytes: '0',
  provisionedSpaceBytes: null,
  usageExceedsPhysical: false,
  capacityReadingsDiffer: false,
  accessible: true,
};

const baseFacts = (): SeriesRelocationFacts => {
  const files = [file(11, 1), file(12, 2), file(13, 3)];
  return {
    now,
    threshold: 3,
    torrentDelayHours: 48,
    files,
    foundationFiles: files.map((item) => ({
      sourceFileId: `episode-file:${item.id}`,
      sizeBytes: String(item.size),
    })),
    queue: [],
    history: files.map((item) => imported(item.id, 'SABnzbd')),
    pendingRequest: false,
    removalConflict: false,
    activeRelocation: false,
    destinationVolume: volume,
  };
};

describe('Series relocation preview Sonarr link', () => {
  const server = {
    hostname: 'sonarr.internal',
    port: 8989,
    useSsl: false,
    baseUrl: '/sonarr',
    externalUrl: 'https://shows.example.test/sonarr/',
  } as SonarrSettings;

  it('uses the resolved instance external URL and Sonarr title slug', () => {
    assert.equal(
      resolveSonarrSeriesUrl(server, {
        titleSlug: 'the-expanse',
      } as SonarrSeries),
      'https://shows.example.test/sonarr/series/the-expanse'
    );
  });

  it('uses the existing internal service URL convention when no external URL is configured', () => {
    assert.equal(
      resolveSonarrSeriesUrl({ ...server, externalUrl: undefined }, {
        titleSlug: 'dark',
      } as SonarrSeries),
      'http://sonarr.internal:8989/sonarr/series/dark'
    );
  });

  it('fails closed for missing identity, invalid protocols, or embedded credentials', () => {
    assert.equal(
      resolveSonarrSeriesUrl(server, { titleSlug: '' } as SonarrSeries),
      null
    );
    assert.equal(
      resolveSonarrSeriesUrl(
        { ...server, externalUrl: 'javascript:alert(1)' },
        { titleSlug: 'series' } as SonarrSeries
      ),
      null
    );
    assert.equal(
      resolveSonarrSeriesUrl(
        { ...server, externalUrl: 'https://user:secret@example.test' },
        { titleSlug: 'series' } as SonarrSeries
      ),
      null
    );
  });
});

describe('Series relocation eligibility', () => {
  it('counts retained physical regular Seasons and excludes Specials', () => {
    const facts = baseFacts();
    facts.files = [file(10, 0), file(11, 1), file(12, 1), file(13, 3)];
    facts.foundationFiles = facts.files.map((item) => ({
      sourceFileId: `episode-file:${item.id}`,
      sizeBytes: String(item.size),
    }));
    facts.history = facts.files.map((item) => imported(item.id, 'SABnzbd'));
    assert.deepEqual(evaluateSeriesRelocationFacts(facts), {
      eligible: false,
      reason: 'below-season-threshold',
      retainedSeasons: [1, 3],
      totalBytes: '0',
      latestTorrentImportAt: null,
    });
  });

  it('requires exact current Foundation EpisodeFile identities and sizes', () => {
    const facts = baseFacts();
    facts.foundationFiles[0].sizeBytes = '99';
    assert.equal(
      evaluateSeriesRelocationFacts(facts).reason,
      'foundation-mismatch'
    );
  });

  it('blocks active acquisitions, pending requests, removals, and duplicate moves', () => {
    for (const [change, reason] of [
      [{ queue: [{ id: 1 }] }, 'active-acquisition'],
      [{ pendingRequest: true }, 'pending-request'],
      [{ removalConflict: true }, 'removal-conflict'],
      [{ activeRelocation: true }, 'already-relocating'],
    ] as const) {
      const facts = Object.assign(baseFacts(), change) as SeriesRelocationFacts;
      assert.equal(evaluateSeriesRelocationFacts(facts).reason, reason);
    }
  });

  it('allows SAB-only imports immediately but enforces the latest qBittorrent import delay', () => {
    assert.equal(evaluateSeriesRelocationFacts(baseFacts()).eligible, true);

    const mixed = baseFacts();
    mixed.history = [
      imported(11, 'SABnzbd'),
      imported(12, 'qBittorrent', '2026-10-18T00:00:01.000Z'),
      imported(13, 'SABnzbd'),
    ];
    assert.equal(
      evaluateSeriesRelocationFacts(mixed).reason,
      'torrent-cooldown'
    );

    mixed.history[1] = imported(12, 'qBittorrent', '2026-10-16T11:59:59.000Z');
    assert.equal(evaluateSeriesRelocationFacts(mixed).eligible, true);
  });

  it('fails closed for missing or unknown import history', () => {
    const facts = baseFacts();
    facts.history.pop();
    assert.equal(
      evaluateSeriesRelocationFacts(facts).reason,
      'incomplete-history'
    );
    facts.history = facts.files.map((item) => imported(item.id, 'Other'));
    assert.equal(
      evaluateSeriesRelocationFacts(facts).reason,
      'unknown-download-client'
    );
  });

  it('requires fresh valid destination capacity for the complete Series', () => {
    const exact = baseFacts();
    exact.destinationVolume = { ...volume, freeSpace: 300 };
    assert.equal(evaluateSeriesRelocationFacts(exact).eligible, true);
    exact.destinationVolume = { ...volume, freeSpace: 299 };
    assert.equal(
      evaluateSeriesRelocationFacts(exact).reason,
      'insufficient-capacity'
    );
    exact.destinationVolume = {
      ...volume,
      freeSpace: null,
      accessible: false,
    };
    assert.equal(
      evaluateSeriesRelocationFacts(exact).reason,
      'destination-capacity-unavailable'
    );
  });
});

describe('Series import resolution', () => {
  it('uses the latest import associated with each current EpisodeFile ID', () => {
    const files = [file(11, 1)];
    const result = resolveCurrentSeriesImports(files, [
      imported(11, 'SABnzbd', '2026-10-01T00:00:00.000Z'),
      imported(11, 'qBittorrent', '2026-10-02T00:00:00.000Z'),
    ]);
    assert.equal(result.complete, true);
    if (result.complete) assert.equal(result.imports[0].origin, 'qbittorrent');
  });
});

describe('whole-Series move verification', () => {
  const snapshot = {
    destinationPath: '/volume9/shows/Example',
    expectedEpisodeFileIds: [11, 12],
    expectedFileCount: 2,
    expectedBytes: '200',
  };
  const movedFiles = [
    { id: 11, size: 100, path: '/volume9/shows/Example/S01E01.mkv' },
    { id: 12, size: 100, path: '/volume9/shows/Example/S02E01.mkv' },
  ];

  it('requires root, paths, identities, count, and bytes before completion', () => {
    assert.equal(
      verifySeriesMoveSnapshot(
        { path: '/volume9/shows/Example' },
        movedFiles,
        snapshot
      ),
      true
    );
    assert.equal(
      verifySeriesMoveSnapshot(
        { path: '/volume9/shows/Example' },
        movedFiles.slice(0, 1),
        snapshot
      ),
      false
    );
    assert.equal(
      verifySeriesMoveSnapshot(
        { path: '/volume9/shows/Example' },
        [movedFiles[0], { ...movedFiles[1], path: '/volume3/shows/Example/x' }],
        snapshot
      ),
      false
    );
    assert.equal(
      verifySeriesMoveSnapshot(
        {
          path: '/volume9/shows/Example',
          pendingPath: '/volume9/shows/Example',
        },
        movedFiles,
        snapshot
      ),
      false
    );
    assert.equal(
      verifySeriesMoveSnapshot(
        { path: '/volume3/shows/Example' },
        movedFiles,
        snapshot
      ),
      false
    );
  });

  it('distinguishes completed, pending, and ambiguous Sonarr state', () => {
    const command = (
      status: SonarrSeriesMoveCommand['status'],
      destinationPath = snapshot.destinationPath
    ): SonarrSeriesMoveCommand => ({
      id: 9,
      commandName: 'MoveSeries',
      status,
      body: { seriesId: 20, destinationPath },
    });

    assert.equal(
      reconcileSeriesMoveSnapshot(
        { path: snapshot.destinationPath, pendingPath: null },
        movedFiles,
        [],
        snapshot
      ).outcome,
      'completed'
    );
    assert.equal(
      reconcileSeriesMoveSnapshot(
        {
          path: '/volume3/shows/Example',
          pendingPath: snapshot.destinationPath,
        },
        movedFiles,
        [],
        snapshot
      ).outcome,
      'pending'
    );
    assert.equal(
      reconcileSeriesMoveSnapshot(
        { path: '/volume3/shows/Example', pendingPath: null },
        movedFiles,
        [command('started')],
        snapshot
      ).outcome,
      'pending'
    );
    for (const observation of [
      reconcileSeriesMoveSnapshot(
        { path: '/volume3/shows/Example', pendingPath: null },
        movedFiles,
        [],
        snapshot
      ),
      reconcileSeriesMoveSnapshot(
        { path: snapshot.destinationPath, pendingPath: null },
        movedFiles.slice(0, 1),
        [],
        snapshot
      ),
      reconcileSeriesMoveSnapshot(
        {
          path: '/volume3/shows/Example',
          pendingPath: '/volume4/shows/Example',
        },
        movedFiles,
        [],
        snapshot
      ),
      reconcileSeriesMoveSnapshot(
        { path: '/volume3/shows/Example', pendingPath: null },
        movedFiles,
        [command('orphaned')],
        snapshot
      ),
      reconcileSeriesMoveSnapshot(
        { path: snapshot.destinationPath, pendingPath: null },
        movedFiles,
        [command('started', '/volume4/shows/Example')],
        snapshot
      ),
    ]) {
      assert.equal(observation.outcome, 'ambiguous');
    }
  });
});
