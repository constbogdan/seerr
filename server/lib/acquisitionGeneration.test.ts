import type { QueueItem, ServarrHistoryRecord } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  DownloadTracker,
  type ConfirmedServarrImport,
  type FinalizingAcquisitionTarget,
} from './downloadtracker';
import { JellyfinAvailabilityReconciler } from './jellyfinAvailabilityReconciler';
import BaseScanner from './scanners/baseScanner';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from './settings';

setupTestDb();
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const ready = () => ({
  state: 'ready' as const,
  lookupMethod: 'exact-id' as const,
  lookupDurationMs: 0,
  processingDurationMs: 0,
  jellyfinRequestCount: 1,
});
const base = (
  id: number,
  state: QueueItem['trackedDownloadState'] = 'downloading'
): QueueItem => ({
  id,
  downloadId: 'reused-hash',
  status: state === 'imported' ? 'completed' : 'downloading',
  trackedDownloadState: state,
  trackedDownloadStatus: 'ok',
  size: 100,
  sizeleft: state === 'imported' ? 0 : 50,
  title: 'Synthetic',
  timeleft: '',
  estimatedCompletionTime: '',
  protocol: 'torrent',
  downloadClient: 'fixture',
  indexer: 'fixture',
});
const presentation = (
  imported: ConfirmedServarrImport,
  alias = imported.serverAliases[0]
): FinalizingAcquisitionTarget => ({
  ...imported,
  serverId: alias.id,
  is4k: alias.is4k,
});

function fixture(tv = false) {
  let now = Date.parse('2026-01-01T00:00:00Z');
  let rows: Awaited<ReturnType<RadarrAPI['getQueue']>> = [];
  let tvRows: Awaited<ReturnType<SonarrAPI['getQueue']>> = [];
  let history: ServarrHistoryRecord[] = [];
  let fail = false;
  const settings = getSettings();
  settings.radarr = tv
    ? []
    : [
        {
          id: 1,
          hostname: 'fixture',
          port: 7878,
          syncEnabled: true,
          is4k: false,
          downloadQueueSize: 50,
        } as RadarrSettings,
      ];
  settings.sonarr = tv
    ? [
        {
          id: 1,
          hostname: 'fixture',
          port: 8989,
          syncEnabled: true,
          is4k: false,
          downloadQueueSize: 50,
        } as SonarrSettings,
      ]
    : [];
  for (const Provider of [RadarrAPI, SonarrAPI]) {
    mock.method(
      Provider.prototype,
      'refreshMonitoredDownloads',
      async () => undefined
    );
    mock.method(Provider.prototype, 'getRecentHistory', async () => history);
  }
  const historyRead = mock.method(
    RadarrAPI.prototype,
    'getRecentHistory',
    async () => history
  );
  mock.method(RadarrAPI.prototype, 'getQueue', async () => {
    if (fail) throw new Error('outage');
    return rows;
  });
  mock.method(SonarrAPI.prototype, 'getQueue', async () => {
    if (fail) throw new Error('outage');
    return tvRows;
  });
  const tracker = new DownloadTracker({ now: () => now });
  const episode = (season: number, number: number) => ({
    ...base(season * 100 + number, 'imported'),
    seriesId: 200,
    episodeId: season * 100 + number,
    episode: {
      id: season * 100 + number,
      seriesId: 200,
      seasonNumber: season,
      episodeNumber: number,
      absoluteEpisodeNumber: number,
      episodeFileId: 1,
      title: 'Synthetic',
      airDate: '',
      airDateUtc: '',
      overview: '',
      hasFile: true,
      monitored: true,
      unverifiedSceneNumbering: false,
    },
  });
  const event = (id: number, episodeId?: number): ServarrHistoryRecord => ({
    id,
    eventType: 'downloadFolderImported',
    date: new Date(now).toISOString(),
    downloadId: 'reused-hash',
    movieId: 100,
    seriesId: 200,
    episodeId,
  });
  const cycle = async (id: number) => {
    now += 1000;
    rows = [{ ...base(id), movieId: 100 }];
    await tracker.updateDownloads();
    now += 1000;
    rows = [];
    history = [event(id)];
    return (await tracker.updateDownloads()).confirmedImports![0];
  };
  return {
    tracker,
    cycle,
    event,
    episode,
    historyRead,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    rows: (value: typeof rows) => {
      rows = value;
    },
    tvRows: (value: typeof tvRows) => {
      tvRows = value;
    },
    history: (value: typeof history) => {
      history = value;
    },
    fail: () => {
      fail = true;
    },
  };
}

describe('acquisition generation identity', () => {
  const settings = getSettings();
  const originalRadarr = settings.radarr;
  const originalSonarr = settings.sonarr;
  afterEach(() => {
    mock.restoreAll();
    settings.radarr = originalRadarr;
    settings.sonarr = originalSonarr;
  });

  it('distinguishes two imports with a reused download ID using observed generation and actual history event', async () => {
    const f = fixture();
    const first = await f.cycle(1);
    const second = await f.cycle(2);
    assert.notEqual(
      first.evidence![0].observationId,
      second.evidence![0].observationId
    );
    assert.equal(first.evidence![0].historyEventId, 1);
    assert.equal(second.evidence![0].historyEventId, 2);
    assert.equal(
      f.tracker.isCurrentFinalizingTarget(presentation(first)),
      false
    );
    assert.equal(
      f.tracker.isCurrentFinalizingTarget(presentation(second)),
      true
    );
    assert.equal(f.historyRead.mock.callCount(), 2);
  });

  it('default import resolver reconciles reused IDs independently and deduplicates repeated notifications', async () => {
    const f = fixture();
    await getRepository(Media).save(
      new Media({
        tmdbId: 90001,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 1,
        externalServiceId: 100,
      })
    );
    const timers: { callback: () => void; delay: number }[] = [];
    let calls = 0;
    const r = new JellyfinAvailabilityReconciler({
      presentation: f.tracker,
      now: f.now,
      reconcileTarget: async () => {
        calls++;
        return ready();
      },
      setTimer: (callback, delay) => {
        const t = { callback, delay };
        timers.push(t);
        return t as unknown as NodeJS.Timeout;
      },
      clearTimer: (timer) => {
        const i = timers.indexOf(timer as unknown as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const run = async () => {
      const t = timers.shift()!;
      f.advance(t.delay);
      t.callback();
      await flush();
      await flush();
    };
    const first = await f.cycle(1);
    await r.request([first]);
    await run();
    await r.request([first]);
    assert.equal(calls, 1);
    assert.equal(timers.length, 0);
    const second = await f.cycle(2);
    await r.request([second]);
    await run();
    assert.equal(calls, 2);
  });

  it('late old cleanup cannot hide a replacement or clear its synthetic Finalizing', async () => {
    const f = fixture();
    const old = presentation(await f.cycle(1));
    const replacement = presentation(await f.cycle(2));
    f.tracker.startFinalizing(old, new Date(f.now()).toISOString());
    f.tracker.startFinalizing(replacement, new Date(f.now()).toISOString());
    f.tracker.acknowledgeImport(old);
    f.tracker.clearFinalizing(old);
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 1);
    f.rows([{ ...base(3, 'imported'), movieId: 100 }]);
    await f.tracker.updateDownloads();
    f.tracker.acknowledgeImport(replacement);
    assert.equal(
      f.tracker.getMovieProgress(1, 100)[0].acquisitionPhase,
      'finalizing'
    );
  });

  it('acknowledges only proven pack Episodes using one existing history page, preserving another Season', async () => {
    const f = fixture(true);
    f.tvRows([f.episode(1, 1), f.episode(1, 2), f.episode(2, 1)]);
    await f.tracker.updateDownloads();
    f.advance(1000);
    f.tvRows([f.episode(1, 2), f.episode(2, 1)]);
    f.history([f.event(1, 101), f.event(2, 102)]);
    const imported = (await f.tracker.updateDownloads()).confirmedImports![0];
    assert.deepEqual(
      imported.episodes.map((ep) => ep.seasonNumber),
      [1, 1]
    );
    f.tracker.acknowledgeImport(presentation(imported));
    assert.deepEqual(
      f.tracker
        .getSeriesProgress(1, 200)
        .map((row) => row.episode?.seasonNumber),
      [2]
    );
    f.fail();
    await f.tracker.updateDownloads();
    assert.deepEqual(
      f.tracker
        .getSeriesProgress(1, 200)
        .map((row) => row.episode?.seasonNumber),
      [2]
    );
  });

  it('does not acknowledge ambiguous Episode history without an authoritative Episode ID', async () => {
    const f = fixture(true);
    f.tvRows([f.episode(1, 1), f.episode(1, 2)]);
    await f.tracker.updateDownloads();
    f.advance(1000);
    f.tvRows([f.episode(1, 2)]);
    f.history([f.event(1)]);
    const imported = (await f.tracker.updateDownloads()).confirmedImports![0];
    f.tracker.acknowledgeImport(presentation(imported));
    assert.equal(f.tracker.getSeriesProgress(1, 200).length, 1);
  });

  it('keeps an unscoped pack row visible when both queue and history omit Episode identity', async () => {
    const f = fixture(true);
    // Model an incomplete provider payload, not an authoritative Episode.
    const unscoped = {
      ...base(1, 'imported'),
      seriesId: 200,
    } as Awaited<ReturnType<SonarrAPI['getQueue']>>[number];
    f.tvRows([unscoped, { ...f.episode(1, 2), seriesId: 201 }]);
    await f.tracker.updateDownloads();
    f.advance(1000);
    f.tvRows([unscoped]);
    f.history([f.event(1)]);
    const imported = (await f.tracker.updateDownloads()).confirmedImports![0];
    assert.equal(imported.evidence![0].episodeId, undefined);
    assert.equal(imported.evidence![0].historyEpisodeId, undefined);
    f.tracker.acknowledgeImport(presentation(imported));
    assert.equal(f.tracker.getSeriesProgress(1, 200).length, 1);
  });

  it('isolates aliases and standard/4K acknowledgements and preserves active rows', async () => {
    const f = fixture();
    settings.radarr.push({ ...settings.radarr[0], id: 2, is4k: true });
    f.rows([
      { ...base(1, 'imported'), movieId: 100 },
      { ...base(2, 'imported'), movieId: 101 },
    ]);
    await f.tracker.updateDownloads();
    f.advance(1000);
    f.rows([{ ...base(1, 'imported'), movieId: 100 }]);
    f.history([f.event(1)]);
    const imported = (await f.tracker.updateDownloads()).confirmedImports!.find(
      (entry) => entry.externalId === 100
    )!;
    f.tracker.acknowledgeImport(presentation(imported));
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 0);
    assert.equal(f.tracker.getMovieProgress(2, 100).length, 1);
    f.rows([
      {
        ...base(1, 'imported'),
        movieId: 100,
        trackedDownloadStatus: 'warning',
      },
    ]);
    await f.tracker.updateDownloads();
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 1);
    f.rows([{ ...base(1, 'downloading'), movieId: 100 }]);
    await f.tracker.updateDownloads();
    assert.equal(
      f.tracker.getMovieProgress(1, 100)[0].acquisitionPhase,
      'downloading'
    );
    f.rows([{ ...base(1, 'imported'), movieId: 100 }]);
    await f.tracker.updateDownloads();
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 1);
  });

  it('cannot reuse acknowledgements after restart or provider-instance replacement', async () => {
    const f = fixture();
    const imported = await f.cycle(1);
    const restarted = new DownloadTracker({ now: f.now });
    assert.equal(
      restarted.isCurrentFinalizingTarget(presentation(imported)),
      false
    );
    settings.radarr[0] = {
      ...settings.radarr[0],
      hostname: 'replacement-instance',
    };
    f.rows([{ ...base(1, 'imported'), movieId: 100 }]);
    await f.tracker.updateDownloads();
    f.tracker.acknowledgeImport(presentation(imported));
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 1);
  });

  it('a new provider history event fences old acknowledgement even for a continuously observed row', async () => {
    const f = fixture();
    f.rows([
      { ...base(1, 'imported'), movieId: 100 },
      { ...base(2), movieId: 101 },
    ]);
    await f.tracker.updateDownloads();
    f.advance(1000);
    f.rows([{ ...base(1, 'imported'), movieId: 100 }]);
    f.history([f.event(1)]);
    const first = presentation(
      (await f.tracker.updateDownloads()).confirmedImports![0]
    );
    f.tracker.acknowledgeImport(first);
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 0);
    f.advance(1000);
    f.history([f.event(2)]);
    const second = presentation(
      (await f.tracker.updateDownloads()).confirmedImports![0]
    );
    assert.notEqual(
      first.evidence![0].observationId,
      second.evidence![0].observationId
    );
    assert.equal(f.tracker.isCurrentFinalizingTarget(first), false);
    f.tracker.acknowledgeImport(first);
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 1);
    f.tracker.acknowledgeImport(second);
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 0);
    f.history([{ ...f.event(1), date: first.evidence![0].importedAt }]);
    const replay = presentation(
      (await f.tracker.updateDownloads()).confirmedImports![0]
    );
    assert.equal(replay.evidence![0].ambiguous, true);
    f.tracker.acknowledgeImport(replay);
    assert.equal(f.tracker.getMovieProgress(1, 100).length, 1);
  });

  it('canonical scanner save is fenced after targeted work becomes stale', async () => {
    class GuardedScanner extends BaseScanner<unknown> {
      constructor() {
        super('targeted fixture');
      }
      async scan() {
        this.processingGuard = () => {
          throw new Error('stale target');
        };
        await this.processMovie(90002);
      }
    }
    await assert.rejects(new GuardedScanner().scan(), /stale target/);
    assert.equal(await getRepository(Media).findOneBy({ tmdbId: 90002 }), null);
  });
});
