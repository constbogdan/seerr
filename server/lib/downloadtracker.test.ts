import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import {
  DownloadTracker,
  type DownloadingItem,
  type DownloadTrackerUpdateOutcome,
  type FinalizingAcquisitionTarget,
} from '@server/lib/downloadtracker';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';

const buildRadarrSettings = ({
  id,
  hostname = 'radarr',
  syncEnabled = true,
  downloadQueueSize,
}: {
  id: number;
  hostname?: string;
  syncEnabled?: boolean;
  downloadQueueSize?: number;
}): RadarrSettings =>
  ({
    id,
    name: `Radarr ${id}`,
    hostname,
    port: 7878,
    syncEnabled,
    downloadQueueSize,
  }) as RadarrSettings;

const buildRadarrQueue = (
  count: number
): Awaited<ReturnType<RadarrAPI['getQueue']>> =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    movieId: 100,
    size: 100,
    title: `Movie ${index + 1}`,
    sizeleft: 50,
    timeleft: '00:10:00',
    estimatedCompletionTime: '2026-01-01T00:00:00Z',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    downloadId: `download-${index + 1}`,
    protocol: 'torrent',
    downloadClient: 'client',
    indexer: 'indexer',
  }));

const buildSonarrQueue = (
  count: number
): Awaited<ReturnType<SonarrAPI['getQueue']>> =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    seriesId: 200,
    episodeId: index + 1,
    size: 100,
    title: `Episode ${index + 1}`,
    sizeleft: 50,
    timeleft: '00:10:00',
    estimatedCompletionTime: '2026-01-01T00:00:00Z',
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    downloadId: `episode-${index + 1}`,
    protocol: 'torrent',
    downloadClient: 'client',
    indexer: 'indexer',
    episode: {
      seriesId: 200,
      episodeFileId: index + 1,
      seasonNumber: 1,
      episodeNumber: index + 1,
      title: `Episode ${index + 1}`,
      airDate: '2026-01-01',
      airDateUtc: '2026-01-01T00:00:00Z',
      overview: '',
      hasFile: false,
      monitored: true,
      absoluteEpisodeNumber: index + 1,
      unverifiedSceneNumbering: false,
      id: index + 1,
    },
  }));

const buildTrackedDownloads = (count: number): DownloadingItem[] =>
  Array.from({ length: count }, (_, index) => ({
    externalId: 100,
    estimatedCompletionTime: new Date('2026-01-01T00:00:00Z'),
    mediaType: MediaType.MOVIE,
    size: 100,
    sizeLeft: 50,
    status: 'downloading',
    trackedDownloadStatus: 'ok',
    trackedDownloadState: 'downloading',
    trackedStatus: 'ok',
    acquisitionPhase: AcquisitionPhase.DOWNLOADING,
    acquisitionPhaseStartedAt: '2026-01-01T00:00:00.000Z',
    health: 'ok',
    timeLeft: '00:10:00',
    title: `Movie ${index + 1}`,
    downloadId: `download-${index + 1}`,
  }));

const buildFinalizingTarget = (
  overrides: Partial<FinalizingAcquisitionTarget> = {}
): FinalizingAcquisitionTarget => ({
  mediaType: MediaType.MOVIE,
  externalId: 100,
  downloadId: 'download-1',
  serverId: 1,
  is4k: false,
  episodes: [],
  ...overrides,
});

describe('DownloadTracker updateDownloads', () => {
  const settings = getSettings();
  const originalRadarr = settings.radarr;
  const originalSonarr = settings.sonarr;

  afterEach(() => {
    settings.radarr = originalRadarr;
    settings.sonarr = originalSonarr;
    mock.restoreAll();
  });

  it('shares one active refresh between concurrent callers', async () => {
    const tracker = new DownloadTracker();
    let resolveRefresh:
      | ((outcome: DownloadTrackerUpdateOutcome) => void)
      | undefined;
    const refresh = mock.fn(
      () =>
        new Promise<DownloadTrackerUpdateOutcome>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    (
      tracker as unknown as {
        performUpdateDownloads: () => Promise<DownloadTrackerUpdateOutcome>;
      }
    ).performUpdateDownloads = refresh;

    const first = tracker.updateDownloads();
    const second = tracker.updateDownloads();

    assert.strictEqual(first, second);
    assert.strictEqual(refresh.mock.callCount(), 1);

    resolveRefresh?.({
      providersAttempted: 0,
      providersSucceeded: 0,
      providersFailed: 0,
      queueCount: 0,
      changed: false,
      authoritative: true,
    });
    await first;

    const third = tracker.updateDownloads();
    assert.notStrictEqual(third, first);
    assert.strictEqual(refresh.mock.callCount(), 2);
    resolveRefresh?.({
      providersAttempted: 0,
      providersSucceeded: 0,
      providersFailed: 0,
      queueCount: 0,
      changed: false,
      authoritative: true,
    });
    await third;
  });

  it('passes configured queue limits and defaults missing values to 10', async () => {
    settings.radarr = [
      {
        id: 1,
        name: 'Radarr',
        hostname: 'radarr',
        port: 7878,
        syncEnabled: true,
        downloadQueueSize: 25,
      } as RadarrSettings,
    ];
    settings.sonarr = [
      {
        id: 2,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        syncEnabled: true,
      } as SonarrSettings,
    ];
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(SonarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    const radarrQueue = mock.method(
      RadarrAPI.prototype,
      'getQueue',
      async () => []
    );
    const sonarrQueue = mock.method(
      SonarrAPI.prototype,
      'getQueue',
      async () => []
    );

    const outcome = await new DownloadTracker().updateDownloads();

    assert.strictEqual(radarrQueue.mock.calls[0].arguments[0], 25);
    assert.strictEqual(sonarrQueue.mock.calls[0].arguments[0], 10);
    assert.deepStrictEqual(outcome, {
      providersAttempted: 2,
      providersSucceeded: 2,
      providersFailed: 0,
      queueCount: 0,
      changed: false,
      authoritative: true,
    });
  });

  it('starts Radarr and Sonarr updates in parallel', async () => {
    settings.radarr = [buildRadarrSettings({ id: 1 })];
    settings.sonarr = [
      {
        id: 2,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        syncEnabled: true,
      } as SonarrSettings,
    ];
    let releaseRadarr: (() => void) | undefined;
    mock.method(
      RadarrAPI.prototype,
      'refreshMonitoredDownloads',
      () =>
        new Promise<void>((resolve) => {
          releaseRadarr = resolve;
        })
    );
    const sonarrRefresh = mock.method(
      SonarrAPI.prototype,
      'refreshMonitoredDownloads',
      async () => Promise.resolve()
    );
    mock.method(RadarrAPI.prototype, 'getQueue', async () => []);
    mock.method(SonarrAPI.prototype, 'getQueue', async () => []);

    const update = new DownloadTracker().updateDownloads();
    assert.strictEqual(sonarrRefresh.mock.callCount(), 1);
    releaseRadarr?.();
    await update;
  });

  it('fetches duplicate aliases once at the maximum and slices each snapshot', async () => {
    settings.radarr = [
      buildRadarrSettings({ id: 1, downloadQueueSize: 10 }),
      buildRadarrSettings({ id: 2, downloadQueueSize: 25 }),
    ];
    settings.sonarr = [];
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    const getQueue = mock.method(RadarrAPI.prototype, 'getQueue', async () =>
      buildRadarrQueue(25)
    );
    const tracker = new DownloadTracker();

    const firstOutcome = await tracker.updateDownloads();
    const secondOutcome = await tracker.updateDownloads();

    assert.strictEqual(getQueue.mock.callCount(), 2);
    assert.strictEqual(getQueue.mock.calls[0].arguments[0], 25);
    assert.strictEqual(tracker.getMovieProgress(1, 100).length, 10);
    assert.strictEqual(tracker.getMovieProgress(2, 100).length, 25);
    assert.deepStrictEqual(firstOutcome, {
      providersAttempted: 1,
      providersSucceeded: 1,
      providersFailed: 0,
      queueCount: 25,
      changed: true,
      authoritative: true,
    });
    assert.strictEqual(secondOutcome.changed, false);
  });

  it('retains each duplicate alias snapshot independently after failure', async () => {
    settings.radarr = [
      buildRadarrSettings({ id: 1, downloadQueueSize: 10 }),
      buildRadarrSettings({ id: 2, downloadQueueSize: 25 }),
    ];
    settings.sonarr = [];
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () => {
      throw new Error('refresh failed');
    });
    const tracker = new DownloadTracker();
    (
      tracker as unknown as {
        radarrServers: Record<number, DownloadingItem[]>;
      }
    ).radarrServers = {
      1: buildTrackedDownloads(10),
      2: buildTrackedDownloads(25),
    };

    const outcome = await tracker.updateDownloads();

    assert.strictEqual(tracker.getMovieProgress(1, 100).length, 10);
    assert.strictEqual(tracker.getMovieProgress(2, 100).length, 25);
    assert.deepStrictEqual(outcome, {
      providersAttempted: 1,
      providersSucceeded: 0,
      providersFailed: 1,
      queueCount: 0,
      changed: false,
      authoritative: false,
    });
  });

  it('reports partial provider failure without treating retained data as observed', async () => {
    settings.radarr = [buildRadarrSettings({ id: 1 })];
    settings.sonarr = [
      {
        id: 2,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        syncEnabled: true,
      } as SonarrSettings,
    ];
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(RadarrAPI.prototype, 'getQueue', async () =>
      buildRadarrQueue(2)
    );
    mock.method(SonarrAPI.prototype, 'refreshMonitoredDownloads', async () => {
      throw new Error('refresh failed');
    });
    const tracker = new DownloadTracker();
    (
      tracker as unknown as {
        sonarrServers: Record<number, DownloadingItem[]>;
      }
    ).sonarrServers = {
      2: [
        {
          ...buildTrackedDownloads(1)[0],
          mediaType: MediaType.TV,
          externalId: 200,
        },
      ],
    };

    const outcome = await tracker.updateDownloads();

    assert.deepStrictEqual(outcome, {
      providersAttempted: 2,
      providersSucceeded: 1,
      providersFailed: 1,
      queueCount: 2,
      changed: true,
      authoritative: false,
    });
    assert.strictEqual(tracker.getSeriesProgress(2, 200).length, 1);
  });

  it('isolates Radarr failure while Sonarr succeeds with episode metadata', async () => {
    settings.radarr = [buildRadarrSettings({ id: 1 })];
    settings.sonarr = [
      {
        id: 2,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        syncEnabled: true,
      } as SonarrSettings,
    ];
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () => {
      throw new Error('refresh failed');
    });
    mock.method(SonarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(SonarrAPI.prototype, 'getQueue', async () =>
      buildSonarrQueue(2)
    );
    const tracker = new DownloadTracker();
    (
      tracker as unknown as {
        radarrServers: Record<number, DownloadingItem[]>;
      }
    ).radarrServers = { 1: buildTrackedDownloads(1) };

    const outcome = await tracker.updateDownloads();

    assert.deepStrictEqual(outcome, {
      providersAttempted: 2,
      providersSucceeded: 1,
      providersFailed: 1,
      queueCount: 2,
      changed: true,
      authoritative: false,
    });
    assert.strictEqual(tracker.getMovieProgress(1, 100).length, 1);
    assert.deepStrictEqual(
      tracker.getSeriesProgress(2, 200)[1].episode,
      buildSonarrQueue(2)[1].episode
    );
  });

  it('reports total failure across Radarr and Sonarr as non-authoritative', async () => {
    settings.radarr = [buildRadarrSettings({ id: 1 })];
    settings.sonarr = [
      {
        id: 2,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        syncEnabled: true,
      } as SonarrSettings,
    ];
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () => {
      throw new Error('radarr failed');
    });
    mock.method(SonarrAPI.prototype, 'refreshMonitoredDownloads', async () => {
      throw new Error('sonarr failed');
    });

    const outcome = await new DownloadTracker().updateDownloads();

    assert.deepStrictEqual(outcome, {
      providersAttempted: 2,
      providersSucceeded: 0,
      providersFailed: 2,
      queueCount: 0,
      changed: false,
      authoritative: false,
    });
  });

  it('uses an enabled alias when the first duplicate is disabled', async () => {
    settings.radarr = [
      buildRadarrSettings({
        id: 1,
        syncEnabled: false,
        downloadQueueSize: 1000,
      }),
      buildRadarrSettings({ id: 2, downloadQueueSize: 15 }),
    ];
    settings.sonarr = [];
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    const getQueue = mock.method(RadarrAPI.prototype, 'getQueue', async () =>
      buildRadarrQueue(15)
    );
    const tracker = new DownloadTracker();

    await tracker.updateDownloads();

    assert.strictEqual(getQueue.mock.callCount(), 1);
    assert.strictEqual(getQueue.mock.calls[0].arguments[0], 15);
    assert.strictEqual(tracker.getMovieProgress(1, 100).length, 0);
    assert.strictEqual(tracker.getMovieProgress(2, 100).length, 15);
  });

  it('preserves phase timing across progress updates and resets it on a phase change', async () => {
    settings.radarr = [buildRadarrSettings({ id: 1 })];
    settings.sonarr = [];
    let now = 1_000;
    let queue = buildRadarrQueue(1);
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(RadarrAPI.prototype, 'getQueue', async () => queue);
    const tracker = new DownloadTracker({ now: () => now });

    await tracker.updateDownloads();
    const initial = tracker.getMovieProgress(1, 100)[0];
    assert.equal(initial.trackedDownloadStatus, 'ok');
    assert.equal(initial.trackedDownloadState, 'downloading');
    assert.equal(initial.trackedStatus, 'ok');
    now = 2_000;
    queue = [
      {
        ...queue[0],
        sizeleft: 25,
        estimatedCompletionTime: '2026-01-01T00:05:00Z',
      },
    ];
    await tracker.updateDownloads();
    const progressed = tracker.getMovieProgress(1, 100)[0];

    assert.equal(progressed.acquisitionPhase, AcquisitionPhase.DOWNLOADING);
    assert.equal(
      progressed.acquisitionPhaseStartedAt,
      initial.acquisitionPhaseStartedAt
    );

    now = 3_000;
    queue = [{ ...queue[0], id: 999, sizeleft: 0 }];
    await tracker.updateDownloads();
    const processing = tracker.getMovieProgress(1, 100)[0];
    assert.equal(processing.acquisitionPhase, AcquisitionPhase.PROCESSING);
    assert.equal(
      processing.acquisitionPhaseStartedAt,
      new Date(now).toISOString()
    );
    assert.equal(processing.timeLeft, '');
    assert.equal(processing.estimatedCompletionTime, undefined);
  });

  it('exposes a stable Finalizing phase after import until reconciliation clears it', () => {
    const tracker = new DownloadTracker();
    const target = buildFinalizingTarget();
    const phaseStartedAt = '2026-01-01T00:05:00.000Z';

    tracker.startFinalizing(target, phaseStartedAt);
    tracker.startFinalizing(target, phaseStartedAt);

    assert.deepEqual(tracker.getMovieProgress(1, 100), [
      {
        mediaType: MediaType.MOVIE,
        externalId: 100,
        size: 0,
        sizeLeft: 0,
        status: 'completed',
        trackedDownloadStatus: 'ok',
        trackedDownloadState: 'imported',
        trackedStatus: 'ok',
        acquisitionPhase: AcquisitionPhase.FINALIZING,
        acquisitionPhaseStartedAt: phaseStartedAt,
        health: 'ok',
        timeLeft: '',
        title: '',
        downloadId: 'download-1',
        episode: undefined,
      },
    ]);

    tracker.clearFinalizing(target);
    assert.deepEqual(tracker.getMovieProgress(1, 100), []);
  });

  it('preserves reconciler-owned Finalizing state across queue resets', async () => {
    const tracker = new DownloadTracker();
    const target = buildFinalizingTarget();
    const phaseStartedAt = '2026-01-01T00:05:00.000Z';
    tracker.startFinalizing(target, phaseStartedAt);

    await tracker.resetDownloadTracker();

    assert.equal(
      tracker.getMovieProgress(1, 100)[0].acquisitionPhaseStartedAt,
      phaseStartedAt
    );
    tracker.clearFinalizing(target);
  });

  it('keeps active Servarr queue state authoritative over Finalizing presentation', async () => {
    settings.radarr = [buildRadarrSettings({ id: 1 })];
    settings.sonarr = [];
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(RadarrAPI.prototype, 'getQueue', async () =>
      buildRadarrQueue(1)
    );
    const tracker = new DownloadTracker();
    tracker.startFinalizing(
      buildFinalizingTarget(),
      '2026-01-01T00:05:00.000Z'
    );

    await tracker.updateDownloads();

    assert.equal(
      tracker.getMovieProgress(1, 100)[0].acquisitionPhase,
      AcquisitionPhase.DOWNLOADING
    );
  });

  it('resets phase timing for a regrab and for a disappeared generation that reappears', async () => {
    settings.radarr = [buildRadarrSettings({ id: 1 })];
    settings.sonarr = [];
    let now = 1_000;
    let queue = buildRadarrQueue(1);
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(RadarrAPI.prototype, 'getQueue', async () => queue);
    mock.method(RadarrAPI.prototype, 'getRecentHistory', async () => []);
    const tracker = new DownloadTracker({ now: () => now });

    await tracker.updateDownloads();
    const initial = tracker.getMovieProgress(1, 100)[0];
    now = 2_000;
    queue = [{ ...queue[0], downloadId: 'replacement-download' }];
    await tracker.updateDownloads();
    assert.notEqual(
      tracker.getMovieProgress(1, 100)[0].acquisitionPhaseStartedAt,
      initial.acquisitionPhaseStartedAt
    );

    queue = [];
    await tracker.updateDownloads();
    now = 3_000;
    queue = buildRadarrQueue(1);
    await tracker.updateDownloads();
    assert.equal(
      tracker.getMovieProgress(1, 100)[0].acquisitionPhaseStartedAt,
      new Date(now).toISOString()
    );
  });

  it('confirms disappeared imports from one bounded exact-download history lookup', async () => {
    settings.radarr = [
      buildRadarrSettings({ id: 1 }),
      buildRadarrSettings({ id: 2 }),
    ];
    settings.sonarr = [];
    let queue = buildRadarrQueue(2);
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(RadarrAPI.prototype, 'getQueue', async () => queue);
    const history = mock.method(
      RadarrAPI.prototype,
      'getRecentHistory',
      async () => [
        {
          id: 1,
          eventType: 'downloadFolderImported',
          date: '2026-01-01T00:00:00Z',
          downloadId: 'download-1',
          movieId: 100,
        },
        {
          id: 2,
          eventType: 'downloadFolderImported',
          date: '2026-01-01T00:00:00Z',
          downloadId: 'different-generation',
          movieId: 100,
        },
      ]
    );
    const tracker = new DownloadTracker();
    await tracker.updateDownloads();
    queue = [];

    const outcome = await tracker.updateDownloads();

    assert.equal(history.mock.callCount(), 1);
    assert.deepEqual(outcome.confirmedImports, [
      {
        mediaType: MediaType.MOVIE,
        externalId: 100,
        downloadId: 'download-1',
        serverAliases: [
          { id: 1, is4k: false },
          { id: 2, is4k: false },
        ],
        episodes: [],
      },
    ]);
  });

  it('does not fabricate import success when bounded history fails', async () => {
    settings.radarr = [buildRadarrSettings({ id: 1 })];
    settings.sonarr = [];
    let queue = buildRadarrQueue(1);
    mock.method(RadarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(RadarrAPI.prototype, 'getQueue', async () => queue);
    let historyAvailable = false;
    mock.method(RadarrAPI.prototype, 'getRecentHistory', async () => {
      if (!historyAvailable) throw new Error('provider unavailable');
      return [
        {
          id: 1,
          eventType: 'downloadFolderImported',
          date: '2026-01-01T00:00:00Z',
          downloadId: 'download-1',
          movieId: 100,
        },
      ];
    });
    const tracker = new DownloadTracker();
    await tracker.updateDownloads();
    queue = [];

    const outcome = await tracker.updateDownloads();
    assert.equal(outcome.confirmedImports, undefined);
    assert.equal(outcome.authoritative, true);

    historyAvailable = true;
    const retry = await tracker.updateDownloads();
    assert.equal(retry.confirmedImports?.[0].downloadId, 'download-1');
  });

  it('groups a Sonarr season download into one confirmed target with all episodes', async () => {
    settings.radarr = [];
    settings.sonarr = [
      {
        id: 3,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        syncEnabled: true,
      } as SonarrSettings,
    ];
    let queue = buildSonarrQueue(2).map((item) => ({
      ...item,
      downloadId: 'season-pack',
    }));
    mock.method(SonarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(SonarrAPI.prototype, 'getQueue', async () => queue);
    mock.method(SonarrAPI.prototype, 'getRecentHistory', async () => [
      {
        id: 9,
        eventType: 'downloadFolderImported',
        date: '2026-01-01T00:00:00Z',
        downloadId: 'season-pack',
        seriesId: 200,
      },
    ]);
    const tracker = new DownloadTracker();
    await tracker.updateDownloads();
    queue = [];

    const outcome = await tracker.updateDownloads();
    assert.equal(outcome.confirmedImports?.length, 1);
    assert.deepEqual(
      outcome.confirmedImports?.[0].episodes.map((episode) => episode.id),
      [1, 2]
    );
  });

  it('does not treat an existing Sonarr file as proof that this upgrade imported', async () => {
    settings.radarr = [];
    settings.sonarr = [
      {
        id: 3,
        name: 'Sonarr',
        hostname: 'sonarr',
        port: 8989,
        syncEnabled: true,
      } as SonarrSettings,
    ];
    let queue = buildSonarrQueue(1).map((item) => ({
      ...item,
      episodeHasFile: true,
      episode: { ...item.episode, hasFile: true },
    }));
    mock.method(SonarrAPI.prototype, 'refreshMonitoredDownloads', async () =>
      Promise.resolve()
    );
    mock.method(SonarrAPI.prototype, 'getQueue', async () => queue);
    mock.method(SonarrAPI.prototype, 'getRecentHistory', async () => []);
    const tracker = new DownloadTracker();
    await tracker.updateDownloads();
    queue = [];

    const outcome = await tracker.updateDownloads();
    assert.equal(outcome.confirmedImports, undefined);
  });

  for (const invalidLimit of ['10', true, false]) {
    it(`rejects malformed runtime queue limit ${String(invalidLimit)}`, async () => {
      settings.radarr = [
        buildRadarrSettings({
          id: 1,
          downloadQueueSize: invalidLimit as unknown as number,
        }),
      ];
      settings.sonarr = [];
      const refresh = mock.method(
        RadarrAPI.prototype,
        'refreshMonitoredDownloads',
        async () => Promise.resolve()
      );
      const getQueue = mock.method(
        RadarrAPI.prototype,
        'getQueue',
        async () => []
      );

      await new DownloadTracker().updateDownloads();

      assert.strictEqual(refresh.mock.callCount(), 0);
      assert.strictEqual(getQueue.mock.callCount(), 0);
    });
  }
});
