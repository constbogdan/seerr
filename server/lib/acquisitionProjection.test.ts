import type { ServarrHistoryRecord } from '@server/api/servarr/base';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import {
  DownloadTracker,
  type ConfirmedServarrImport,
  type FinalizingAcquisitionTarget,
} from '@server/lib/downloadtracker';
import { getSettings, type SonarrSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import { getRequestDownloadStatus } from '../../src/utils/refreshIntervalHelper';

type Row = Awaited<ReturnType<SonarrAPI['getQueue']>>[number];
const row = (
  season: number,
  episodeNumber = 1,
  overrides: Partial<Row> = {}
): Row => ({
  id: season * 100 + episodeNumber,
  seriesId: 200,
  episodeId: season * 100 + episodeNumber,
  downloadId: 'shared-pack',
  status: 'downloading',
  trackedDownloadState: 'downloading',
  trackedDownloadStatus: 'ok',
  size: 1000,
  sizeleft: 500,
  timeleft: '00:05:00',
  estimatedCompletionTime: '',
  title: 'Synthetic acquisition',
  protocol: 'torrent',
  downloadClient: 'fixture',
  indexer: 'fixture',
  episode: {
    id: season * 100 + episodeNumber,
    seriesId: 200,
    seasonNumber: season,
    episodeNumber,
    absoluteEpisodeNumber: episodeNumber,
    episodeFileId: 1,
    title: 'Synthetic',
    airDate: '',
    airDateUtc: '',
    overview: '',
    hasFile: false,
    monitored: true,
    unverifiedSceneNumbering: false,
  },
  ...overrides,
});
const importedRow = (season: number, episodeNumber = 1) =>
  row(season, episodeNumber, {
    status: 'completed',
    trackedDownloadState: 'imported',
    sizeleft: 0,
  });
const target = (
  imported: ConfirmedServarrImport,
  is4k = false
): FinalizingAcquisitionTarget => ({
  ...imported,
  serverId: is4k ? 2 : 1,
  is4k,
});

describe('Season-scoped acquisition projection', () => {
  const settings = getSettings();
  let originalSonarr: SonarrSettings[];
  let originalRadarr: typeof settings.radarr;
  beforeEach(() => {
    originalSonarr = settings.sonarr;
    originalRadarr = settings.radarr;
    settings.radarr = [];
    settings.sonarr = [false, true].map(
      (is4k, index) =>
        ({
          id: index + 1,
          hostname: 'fixture',
          port: 8989,
          syncEnabled: true,
          is4k,
          downloadQueueSize: 1000,
        }) as SonarrSettings
    );
  });
  afterEach(() => {
    mock.restoreAll();
    settings.sonarr = originalSonarr;
    settings.radarr = originalRadarr;
  });

  function fixture() {
    let now = Date.parse('2026-01-01T00:00:00Z');
    let rows: Row[] = [];
    let history: ServarrHistoryRecord[] = [];
    mock.method(
      SonarrAPI.prototype,
      'refreshMonitoredDownloads',
      async () => undefined
    );
    const queueRead = mock.method(
      SonarrAPI.prototype,
      'getQueue',
      async () => rows
    );
    const historyRead = mock.method(
      SonarrAPI.prototype,
      'getRecentHistory',
      async () => history
    );
    const tracker = new DownloadTracker({ now: () => now });
    return {
      tracker,
      queueRead,
      historyRead,
      async observe(value: Row[]) {
        rows = value;
        const result = await tracker.updateDownloads();
        now += 1000;
        return result;
      },
      history(episodes: number[]) {
        history = episodes.map((episodeId) => ({
          id: episodeId,
          date: new Date(now).toISOString(),
          eventType: 'downloadFolderImported',
          seriesId: 200,
          episodeId,
          downloadId: 'shared-pack',
        }));
      },
      start(imported: ConfirmedServarrImport, is4k = false) {
        const value = target(imported, is4k);
        tracker.startFinalizing(value, new Date(now).toISOString());
        return value;
      },
    };
  }

  it('preserves Season 1 Finalizing while Season 2 transfers, including a shared pack hash', async () => {
    const f = fixture();
    await f.observe([importedRow(1), row(2)]);
    f.history([101]);
    const imported = (await f.observe([row(2)])).confirmedImports![0];
    f.start(imported);
    const all = f.tracker.getSeriesProgress(1, 200);
    assert.equal(all.length, 2);
    const first = getRequestDownloadStatus(all, [1]);
    const second = getRequestDownloadStatus(all, [2]);
    assert.equal(first.length, 1);
    assert.equal(first[0].acquisitionPhase, AcquisitionPhase.FINALIZING);
    assert.equal(second.length, 1);
    assert.equal(second[0].acquisitionPhase, AcquisitionPhase.DOWNLOADING);
    assert.equal(all[0].downloadId, all[1].downloadId);
  });

  it('retains multiple Finalizing Seasons while another Season is active, without expanding Episode scope', async () => {
    const f = fixture();
    await f.observe([importedRow(1, 2), importedRow(2, 3), row(3)]);
    f.history([102, 203]);
    const imported = (await f.observe([row(3)])).confirmedImports![0];
    f.start(imported);
    assert.deepEqual(
      f.tracker
        .getSeriesProgress(1, 200)
        .map((item) => [
          item.episode?.seasonNumber,
          item.episode?.episodeNumber,
        ])
        .sort(),
      [
        [1, 2],
        [2, 3],
        [3, 1],
      ]
    );
    assert.equal(
      getRequestDownloadStatus(f.tracker.getSeriesProgress(1, 200), [4]).length,
      0
    );
  });

  it('deduplicates live/synthetic rows only for the same scoped generation and preserves exact acknowledgement', async () => {
    const f = fixture();
    await f.observe([importedRow(1, 1), importedRow(1, 2), row(2)]);
    f.history([101, 102]);
    const imported = (await f.observe([importedRow(1, 2), row(2)]))
      .confirmedImports![0];
    const standard = f.start(imported);
    assert.equal(f.tracker.getSeriesProgress(1, 200).length, 3);
    assert.equal(
      f.tracker
        .getSeriesProgress(1, 200)
        .filter((item) => item.episode?.id === 102).length,
      1
    );
    f.tracker.acknowledgeImport(standard);
    f.tracker.clearFinalizing(standard);
    assert.deepEqual(
      f.tracker
        .getSeriesProgress(1, 200)
        .map((item) => item.episode?.seasonNumber),
      [2]
    );
    assert.deepEqual(
      f.tracker
        .getSeriesProgress(2, 200)
        .map((item) => item.episode?.seasonNumber),
      [1, 2]
    );
  });

  it('keeps quality-specific synthetic presentation isolated', async () => {
    const f = fixture();
    await f.observe([importedRow(1), row(2)]);
    f.history([101]);
    const imported = (await f.observe([row(2)])).confirmedImports![0];
    const standard = f.start(imported);
    assert.equal(
      getRequestDownloadStatus(f.tracker.getSeriesProgress(1, 200), [1]).length,
      1
    );
    assert.equal(
      getRequestDownloadStatus(f.tracker.getSeriesProgress(2, 200), [1]).length,
      0
    );
    f.start(imported, true);
    f.tracker.clearFinalizing(standard);
    assert.equal(
      getRequestDownloadStatus(f.tracker.getSeriesProgress(2, 200), [1]).length,
      1
    );
  });

  it('does not let late cleanup/acknowledgement hide a replacement or another Season', async () => {
    const f = fixture();
    await f.observe([importedRow(1), row(2)]);
    f.history([101]);
    const old = f.start((await f.observe([row(2)])).confirmedImports![0]);
    await f.observe([row(1, 1, { id: 999 }), row(2)]);
    assert.equal(f.tracker.isCurrentFinalizingTarget(old), false);
    f.tracker.acknowledgeImport(old);
    f.tracker.clearFinalizing(old);
    assert.deepEqual(
      f.tracker
        .getSeriesProgress(1, 200)
        .map((item) => item.episode?.seasonNumber),
      [1, 2]
    );
  });

  it('uses cached bounded snapshots without provider reads during repeated projection', async () => {
    const f = fixture();
    await f.observe(
      Array.from({ length: 1000 }, (_, index) => row(1, index + 1))
    );
    const queueCalls = f.queueRead.mock.callCount();
    const historyCalls = f.historyRead.mock.callCount();
    for (let index = 0; index < 25; index++)
      assert.equal(f.tracker.getSeriesProgress(1, 200).length, 1000);
    assert.equal(f.queueRead.mock.callCount(), queueCalls);
    assert.equal(f.historyRead.mock.callCount(), historyCalls);
    assert.equal(queueCalls, 1);
  });

  it('leaves Movie projection unchanged when no queue observation exists', () => {
    const f = fixture();
    f.tracker.startFinalizing(
      {
        mediaType: MediaType.MOVIE,
        externalId: 10,
        serverId: 1,
        is4k: false,
        downloadId: 'movie',
        episodes: [],
      },
      new Date().toISOString()
    );
    assert.equal(
      f.tracker.getMovieProgress(1, 10)[0].acquisitionPhase,
      AcquisitionPhase.FINALIZING
    );
    assert.equal(f.tracker.getSeriesProgress(1, 200).length, 0);
  });
});
