import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

import type SonarrAPI from '@server/api/servarr/sonarr';
import type {
  SonarrEpisodeFile,
  SonarrHistoryRecord,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { DEFAULT_OVERFLOW_SETTINGS } from '@server/constants/overflow';
import {
  RemovalExecutionInitiator,
  RemovalTargetType,
} from '@server/constants/removal';
import { SeriesRelocationState } from '@server/constants/seriesRelocation';
import applicationDataSource from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import { SeriesRelocationExecution } from '@server/entity/SeriesRelocationExecution';
import { RemovalExecutionCoordinator } from '@server/lib/removalExecutionCoordinator';
import {
  SeriesRelocationService,
  type SeriesRelocationDependencies,
} from '@server/lib/seriesRelocation';
import Settings, { type SonarrSettings } from '@server/lib/settings';
import type {
  PhysicalVolume,
  StorageDiscoveryResult,
} from '@server/lib/storageSettings';

const fixture = async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'seerr-series-move-'));
  const databasePath = path.join(directory, 'db.sqlite3');
  const migrator = new DataSource({
    type: 'sqlite',
    database: databasePath,
    migrations: ['server/migration/sqlite/*.ts'],
    synchronize: false,
  });
  await migrator.initialize();
  await migrator.runMigrations();
  await migrator.destroy();
  const connection = new DataSource({
    type: 'sqlite',
    database: databasePath,
    entities: applicationDataSource.options.entities,
    synchronize: false,
  });
  await connection.initialize();
  return {
    connection,
    async close() {
      if (connection.isInitialized) await connection.destroy();
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

const dependencies = (
  connection: DataSource,
  changes: Partial<SeriesRelocationDependencies> = {}
): SeriesRelocationDependencies => {
  const settings = new Settings();
  return {
    connection,
    settings: () => settings,
    discover: async () => ({
      locations: [],
      volumes: [],
      instances: [],
      refreshedAt: '2026-10-18T00:00:00.000Z',
    }),
    createSonarr: () => ({}) as SonarrAPI,
    now: () => new Date('2026-10-18T00:00:00.000Z'),
    sleep: async () => undefined,
    pollIntervalMs: 1,
    verificationTimeoutMs: 1,
    ...changes,
  };
};

const previewVolume = (
  id: string,
  name: string,
  locationIds: string[],
  freeSpace = 10_000
): PhysicalVolume => ({
  id,
  name,
  volumeKey: id.replace('physical:', ''),
  locationIds,
  segments: [],
  totalSpace: 20_000,
  usedSpace: 20_000 - freeSpace,
  freeSpace,
  usedPercentage: ((20_000 - freeSpace) / 20_000) * 100,
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
});

const previewDiscovery = (): StorageDiscoveryResult => ({
  locations: [
    {
      id: 'sonarr:2:root:20',
      provider: 'sonarr',
      serviceId: 2,
      serviceName: 'Shows',
      rootFolderId: 20,
      name: 'Shows Internal',
      path: '/volume3/media-shows',
      color: null,
      isAnimation: false,
      diskSpacePath: '/volume3',
      totalSpace: 20_000,
      usedSpace: 10_000,
      freeSpace: 10_000,
      usedPercentage: 50,
      accessible: true,
      routable: true,
    },
    {
      id: 'sonarr:2:root:21',
      provider: 'sonarr',
      serviceId: 2,
      serviceName: 'Shows',
      rootFolderId: 21,
      name: 'Shows External',
      path: '/volume9/media-shows',
      color: null,
      isAnimation: false,
      diskSpacePath: '/volume9',
      totalSpace: 20_000,
      usedSpace: 10_000,
      freeSpace: 10_000,
      usedPercentage: 50,
      accessible: true,
      routable: true,
    },
  ],
  volumes: [
    previewVolume('physical:volume3', 'Volume 3', ['sonarr:2:root:20']),
    previewVolume('physical:volume9', 'Volume 9', ['sonarr:2:root:21']),
  ],
  instances: [
    {
      provider: 'sonarr',
      serviceId: 2,
      serviceName: 'Shows',
      available: true,
      capacityAvailable: true,
    },
  ],
  refreshedAt: '2026-10-18T00:00:00.000Z',
});

const relocationSettings = (): Settings => {
  const settings = new Settings();
  settings.overflow = {
    ...DEFAULT_OVERFLOW_SETTINGS,
    defaultSeriesVolumeId: 'physical:volume3',
    expansionSeriesVolumeId: 'physical:volume9',
    seriesSeasonThreshold: 1,
    torrentRelocationDelayHours: 48,
  };
  settings.sonarr = [
    {
      id: 2,
      name: 'Shows',
      hostname: 'localhost',
      port: 8989,
      apiKey: 'test-only',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'HD',
      activeDirectory: '/volume3/media-shows',
      tags: [],
      is4k: false,
      isDefault: true,
      syncEnabled: true,
      preventSearch: false,
      tagRequests: false,
      overrideRule: [],
      seriesType: 'standard',
      animeSeriesType: 'anime',
      enableSeasonFolders: true,
      monitorNewItems: 'all',
    } as SonarrSettings,
  ];
  return settings;
};

const seedEligibleSeries = async (connection: DataSource) => {
  const root = await connection.getRepository(StorageRoot).save(
    new StorageRoot({
      servarrType: 'sonarr',
      serviceId: 2,
      sourceRootId: 20,
      nameSnapshot: 'Shows Internal',
      pathSnapshot: '/volume3/media-shows',
    })
  );
  const canonical = await connection.getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.SERIES,
      titleSnapshot: 'Eligible Series',
    })
  );
  const presence = await connection.getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: canonical.id,
      sourceSystem: 'sonarr',
      sourceScope: 'sonarr:2',
      sourceItemId: 'series:20',
      sourceGeneration: 'relocation-test',
      storageRootId: root.id,
      pathSnapshot: '/volume3/media-shows/Eligible Series',
      servarrManaged: true,
      servarrHasFile: true,
      isCurrent: true,
    })
  );
  await connection.getRepository(LibraryFile).save(
    new LibraryFile({
      libraryPresenceId: presence.id,
      sourceSystem: 'sonarr',
      sourceScope: 'sonarr:2',
      sourceFileId: 'episode-file:11',
      sourceGeneration: 'relocation-test',
      storageRootId: root.id,
      sizeBytes: '100',
      isCurrent: true,
    })
  );
  return canonical;
};

describe('Series relocation candidate preview', () => {
  it('uses job ordering and eligibility without acquiring or executing a move', async () => {
    const test = await fixture();
    const settings = new Settings();
    settings.overflow = {
      ...DEFAULT_OVERFLOW_SETTINGS,
      defaultSeriesVolumeId: 'physical:volume3',
      expansionSeriesVolumeId: 'physical:volume9',
      seriesSeasonThreshold: 2,
      torrentRelocationDelayHours: 48,
    };
    settings.sonarr = [
      {
        id: 2,
        name: 'Shows',
        externalUrl: 'https://sonarr.example.test/base',
        hostname: 'localhost',
        port: 8989,
        apiKey: 'test-only',
        useSsl: false,
        activeProfileId: 1,
        activeProfileName: 'HD',
        activeDirectory: '/volume3/media-shows',
        tags: [],
        is4k: false,
        isDefault: true,
        syncEnabled: true,
        preventSearch: false,
        tagRequests: false,
        overrideRule: [],
        seriesType: 'standard',
        animeSeriesType: 'anime',
        enableSeasonFolders: true,
        monitorNewItems: 'all',
      } as SonarrSettings,
    ];
    const root = await test.connection.getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'sonarr',
        serviceId: 2,
        sourceRootId: 20,
        nameSnapshot: 'Shows Internal',
        pathSnapshot: '/volume3/media-shows',
      })
    );
    const definitions = [
      {
        sourceId: 101,
        title: 'Below Threshold',
        year: 2019,
        files: [{ id: 1011, seasonNumber: 1, size: 100 }],
      },
      {
        sourceId: 102,
        title: 'Next Eligible',
        year: 2020,
        files: [
          { id: 1021, seasonNumber: 1, size: 100 },
          { id: 1022, seasonNumber: 2, size: 200 },
        ],
      },
    ];
    const canonicalIds: number[] = [];
    for (const definition of definitions) {
      const canonical = await test.connection
        .getRepository(CanonicalMedia)
        .save(
          new CanonicalMedia({
            mediaType: LibraryMediaType.SERIES,
            titleSnapshot: definition.title,
            year: definition.year,
          })
        );
      canonicalIds.push(canonical.id);
      const presence = await test.connection
        .getRepository(LibraryPresence)
        .save(
          new LibraryPresence({
            canonicalMediaId: canonical.id,
            sourceSystem: 'sonarr',
            sourceScope: 'sonarr:2',
            sourceItemId: `series:${definition.sourceId}`,
            sourceGeneration: 'preview-test',
            storageRootId: root.id,
            pathSnapshot: `/volume3/media-shows/${definition.title}`,
            servarrManaged: true,
            servarrHasFile: true,
            isCurrent: true,
          })
        );
      await test.connection.getRepository(LibraryFile).save(
        definition.files.map(
          (file) =>
            new LibraryFile({
              libraryPresenceId: presence.id,
              sourceSystem: 'sonarr',
              sourceScope: 'sonarr:2',
              sourceFileId: `episode-file:${file.id}`,
              sourceGeneration: 'preview-test',
              storageRootId: root.id,
              sizeBytes: String(file.size),
              isCurrent: true,
            })
        )
      );
    }

    let moveCalls = 0;
    const api = {
      getSeriesById: async (seriesId: number) => {
        const definition = definitions.find(
          (candidate) => candidate.sourceId === seriesId
        )!;
        return {
          id: seriesId,
          title: definition.title,
          titleSlug: `series-${seriesId}`,
          year: definition.year,
          path: `/volume3/media-shows/${definition.title}`,
          rootFolderPath: '/volume3/media-shows',
        } as SonarrSeries;
      },
      getEpisodeFiles: async (seriesId: number) => {
        const definition = definitions.find(
          (candidate) => candidate.sourceId === seriesId
        )!;
        return definition.files.map(
          (file) =>
            ({
              ...file,
              seriesId,
              dateAdded: '2026-10-01T00:00:00.000Z',
              path: `/volume3/media-shows/${definition.title}/${file.id}.mkv`,
            }) as SonarrEpisodeFile
        );
      },
      getSeriesQueue: async () => [],
      getSeriesHistory: async (seriesId: number) => {
        const definition = definitions.find(
          (candidate) => candidate.sourceId === seriesId
        )!;
        return definition.files.map(
          (file) =>
            ({
              id: file.id,
              seriesId,
              episodeId: file.id,
              sourceTitle: `release-${file.id}`,
              eventType: 'downloadFolderImported',
              date: '2026-10-01T00:00:00.000Z',
              data: {
                FileId: String(file.id),
                DownloadClient: 'SABnzbd',
              },
            }) as SonarrHistoryRecord
        );
      },
      moveSeries: async () => {
        moveCalls += 1;
      },
    } as unknown as SonarrAPI;
    const service = new SeriesRelocationService(
      dependencies(test.connection, {
        settings: () => settings,
        discover: async () => previewDiscovery(),
        createSonarr: () => api,
      })
    );

    try {
      assert.deepEqual(await service.previewNextCandidate(), {
        status: 'eligible',
        candidate: {
          canonicalMediaId: canonicalIds[1],
          title: 'Next Eligible',
          year: 2020,
          retainedSeasonCount: 2,
          totalBytes: '300',
          sonarrUrl: 'https://sonarr.example.test/base/series/series-102',
        },
        reason: null,
      });
      assert.equal(moveCalls, 0);
      assert.equal(
        await test.connection.getRepository(SeriesRelocationExecution).count(),
        0
      );

      settings.overflow.seriesSeasonThreshold = 3;
      assert.deepEqual(await service.previewNextCandidate(), {
        status: 'none',
        candidate: null,
        reason: null,
      });

      settings.overflow.seriesSeasonThreshold = 2;
      await test.connection.getRepository(LibraryFile).delete({
        sourceFileId: 'episode-file:1022',
      });
      assert.deepEqual(await service.previewNextCandidate(), {
        status: 'unavailable',
        candidate: null,
        reason: 'incomplete-evidence',
      });

      const unavailable = new SeriesRelocationService(
        dependencies(test.connection, {
          settings: () => settings,
          discover: async () => {
            throw new Error('Sonarr unavailable');
          },
        })
      );
      assert.deepEqual(await unavailable.previewNextCandidate(), {
        status: 'unavailable',
        candidate: null,
        reason: 'provider-unavailable',
      });
      assert.equal(moveCalls, 0);
      assert.equal(
        await test.connection.getRepository(SeriesRelocationExecution).count(),
        0
      );
    } finally {
      await test.close();
    }
  });
});

describe('Series relocation operational lifecycle', () => {
  it('persists the claim and provider boundary before Sonarr, then releases only after verification', async () => {
    const test = await fixture();
    const settings = relocationSettings();
    const canonical = await seedEligibleSeries(test.connection);
    let moveCalls = 0;
    let seriesReads = 0;
    let boundaryObserved = false;
    const api = {
      getSeriesById: async () => {
        seriesReads += 1;
        const moved = moveCalls > 0;
        return {
          id: 20,
          title: 'Eligible Series',
          titleSlug: 'eligible-series',
          year: 2020,
          path: moved
            ? '/volume9/media-shows/Eligible Series'
            : '/volume3/media-shows/Eligible Series',
          pendingPath: null,
          rootFolderPath: moved
            ? '/volume9/media-shows'
            : '/volume3/media-shows',
        } as SonarrSeries;
      },
      getEpisodeFiles: async () => [
        {
          id: 11,
          seriesId: 20,
          seasonNumber: 1,
          size: 100,
          dateAdded: '2026-10-01T00:00:00.000Z',
          path:
            moveCalls > 0
              ? '/volume9/media-shows/Eligible Series/S01E01.mkv'
              : '/volume3/media-shows/Eligible Series/S01E01.mkv',
        } as SonarrEpisodeFile,
      ],
      getSeriesQueue: async () => [],
      getSeriesHistory: async () => [
        {
          id: 1,
          seriesId: 20,
          episodeId: 1,
          sourceTitle: 'release',
          eventType: 'downloadFolderImported',
          date: '2026-10-01T00:00:00.000Z',
          data: { FileId: '11', DownloadClient: 'SABnzbd' },
        } as SonarrHistoryRecord,
      ],
      getSeriesMoveCommands: async () => [],
      moveSeries: async () => {
        const claimed = await test.connection
          .getRepository(SeriesRelocationExecution)
          .findOneByOrFail({ canonicalMediaId: canonical.id });
        boundaryObserved =
          claimed.state === SeriesRelocationState.PROVIDER_IN_FLIGHT &&
          claimed.providerStartedAt !== null &&
          claimed.activeKey === `series:${canonical.id}`;
        moveCalls += 1;
      },
    } as unknown as SonarrAPI;
    const service = new SeriesRelocationService(
      dependencies(test.connection, {
        settings: () => settings,
        discover: async () => previewDiscovery(),
        createSonarr: () => api,
      })
    );

    try {
      const result = await service.run(1);
      assert.equal(result.moved, 1);
      assert.equal(moveCalls, 1);
      assert.equal(boundaryObserved, true);
      assert.ok(seriesReads >= 3);
      const execution = await test.connection
        .getRepository(SeriesRelocationExecution)
        .findOneByOrFail({ canonicalMediaId: canonical.id });
      assert.equal(execution.state, SeriesRelocationState.COMPLETED);
      assert.equal(execution.activeKey, null);
      assert.ok(execution.providerStartedAt);
      assert.ok(execution.providerAcceptedAt);
      assert.ok(execution.verifiedAt);
    } finally {
      await test.close();
    }
  });

  it('releases a post-claim capacity failure without invoking Sonarr', async () => {
    const test = await fixture();
    const settings = relocationSettings();
    const canonical = await seedEligibleSeries(test.connection);
    let discoveryCalls = 0;
    let moveCalls = 0;
    const api = {
      getSeriesById: async () =>
        ({
          id: 20,
          title: 'Eligible Series',
          path: '/volume3/media-shows/Eligible Series',
          rootFolderPath: '/volume3/media-shows',
        }) as SonarrSeries,
      getEpisodeFiles: async () => [
        {
          id: 11,
          seriesId: 20,
          seasonNumber: 1,
          size: 100,
          dateAdded: '2026-10-01T00:00:00.000Z',
          path: '/volume3/media-shows/Eligible Series/S01E01.mkv',
        } as SonarrEpisodeFile,
      ],
      getSeriesQueue: async () => [],
      getSeriesHistory: async () => [
        {
          id: 1,
          seriesId: 20,
          episodeId: 1,
          sourceTitle: 'release',
          eventType: 'downloadFolderImported',
          date: '2026-10-01T00:00:00.000Z',
          data: { FileId: '11', DownloadClient: 'SABnzbd' },
        } as SonarrHistoryRecord,
      ],
      moveSeries: async () => {
        moveCalls += 1;
      },
    } as unknown as SonarrAPI;
    const service = new SeriesRelocationService(
      dependencies(test.connection, {
        settings: () => settings,
        discover: async () => {
          discoveryCalls += 1;
          const discovery = previewDiscovery();
          if (discoveryCalls > 1) {
            const destination = discovery.volumes.find(
              (volume) => volume.id === 'physical:volume9'
            )!;
            destination.freeSpace = 0;
            destination.usedSpace = destination.totalSpace;
          }
          return discovery;
        },
        createSonarr: () => api,
      })
    );

    try {
      const result = await service.run(1);
      assert.equal(result.results[0].reason, 'insufficient-capacity');
      assert.equal(moveCalls, 0);
      const execution = await test.connection
        .getRepository(SeriesRelocationExecution)
        .findOneByOrFail({ canonicalMediaId: canonical.id });
      assert.equal(execution.state, SeriesRelocationState.COMPLETED);
      assert.equal(execution.activeKey, null);
      assert.equal(execution.providerStartedAt, null);
      assert.equal(execution.failureCode, 'insufficient-capacity');
    } finally {
      await test.close();
    }
  });

  it('cannot acquire a relocation claim over a durable Removal claim or invoke Sonarr', async () => {
    const test = await fixture();
    const settings = relocationSettings();
    const canonical = await seedEligibleSeries(test.connection);
    let sonarrCreations = 0;
    let moveCalls = 0;
    const api = {
      getSeriesById: async () =>
        ({
          id: 20,
          title: 'Eligible Series',
          path: '/volume3/media-shows/Eligible Series',
          rootFolderPath: '/volume3/media-shows',
        }) as SonarrSeries,
      getEpisodeFiles: async () => [
        {
          id: 11,
          seriesId: 20,
          seasonNumber: 1,
          size: 100,
          dateAdded: '2026-10-01T00:00:00.000Z',
          path: '/volume3/media-shows/Eligible Series/S01E01.mkv',
        } as SonarrEpisodeFile,
      ],
      getSeriesQueue: async () => [],
      getSeriesHistory: async () => [
        {
          id: 1,
          seriesId: 20,
          episodeId: 1,
          sourceTitle: 'release',
          eventType: 'downloadFolderImported',
          date: '2026-10-01T00:00:00.000Z',
          data: { FileId: '11', DownloadClient: 'SABnzbd' },
        } as SonarrHistoryRecord,
      ],
      moveSeries: async () => {
        moveCalls += 1;
      },
    } as unknown as SonarrAPI;
    const service = new SeriesRelocationService(
      dependencies(test.connection, {
        settings: () => settings,
        discover: async () => previewDiscovery(),
        createSonarr: () => {
          sonarrCreations += 1;
          return api;
        },
      })
    );
    const internals = service as unknown as {
      evaluatePresence(
        presence: LibraryPresence,
        currentSettings: Settings,
        discovery: StorageDiscoveryResult
      ): Promise<unknown>;
      executeCandidate(candidate: unknown): Promise<{
        canonicalMediaId: number;
        outcome: string;
        reason: string;
      }>;
    };

    try {
      const presence = await test.connection
        .getRepository(LibraryPresence)
        .findOneByOrFail({ canonicalMediaId: canonical.id, isCurrent: true });
      const candidate = await internals.evaluatePresence(
        presence,
        settings,
        previewDiscovery()
      );

      const removal = new RemovalExecutionCoordinator(test.connection);
      await removal.acquire({
        canonicalMediaId: canonical.id,
        targetType: RemovalTargetType.SERIES,
        initiator: RemovalExecutionInitiator.MANUAL,
      });
      sonarrCreations = 0;

      const result = await internals.executeCandidate(candidate);

      assert.deepEqual(result, {
        canonicalMediaId: canonical.id,
        outcome: 'blocked',
        reason: 'removal-conflict',
      });
      assert.equal(sonarrCreations, 0);
      assert.equal(moveCalls, 0);
      assert.equal(
        await test.connection.getRepository(SeriesRelocationExecution).count(),
        0
      );
    } finally {
      await test.close();
    }
  });

  it('retains the claim and never retries when Sonarr may have accepted a timed-out request', async () => {
    const test = await fixture();
    const settings = relocationSettings();
    const canonical = await seedEligibleSeries(test.connection);
    let moveCalls = 0;
    const api = {
      getSeriesById: async () =>
        ({
          id: 20,
          title: 'Eligible Series',
          titleSlug: 'eligible-series',
          year: 2020,
          path: '/volume3/media-shows/Eligible Series',
          pendingPath: null,
          rootFolderPath: '/volume3/media-shows',
        }) as SonarrSeries,
      getEpisodeFiles: async () => [
        {
          id: 11,
          seriesId: 20,
          seasonNumber: 1,
          size: 100,
          dateAdded: '2026-10-01T00:00:00.000Z',
          path: '/volume3/media-shows/Eligible Series/S01E01.mkv',
        } as SonarrEpisodeFile,
      ],
      getSeriesQueue: async () => [],
      getSeriesHistory: async () => [
        {
          id: 1,
          seriesId: 20,
          episodeId: 1,
          sourceTitle: 'release',
          eventType: 'downloadFolderImported',
          date: '2026-10-01T00:00:00.000Z',
          data: { FileId: '11', DownloadClient: 'SABnzbd' },
        } as SonarrHistoryRecord,
      ],
      getSeriesMoveCommands: async () => [],
      moveSeries: async () => {
        moveCalls += 1;
        throw new Error('request timed out after write');
      },
    } as unknown as SonarrAPI;
    const service = new SeriesRelocationService(
      dependencies(test.connection, {
        settings: () => settings,
        discover: async () => previewDiscovery(),
        createSonarr: () => api,
      })
    );

    try {
      const first = await service.run(1);
      assert.equal(first.results[0].outcome, 'needs_reconciliation');
      assert.equal(first.results[0].reason, 'provider-error');
      assert.equal(moveCalls, 1);
      let execution = await test.connection
        .getRepository(SeriesRelocationExecution)
        .findOneByOrFail({ canonicalMediaId: canonical.id });
      assert.equal(
        execution.state,
        SeriesRelocationState.RECONCILIATION_REQUIRED
      );
      assert.equal(execution.activeKey, `series:${canonical.id}`);
      assert.ok(execution.providerStartedAt);
      assert.equal(execution.providerAcceptedAt, null);

      const second = await service.run(1);
      assert.equal(second.results[0].outcome, 'needs_reconciliation');
      assert.equal(second.results[0].reason, 'verification-failed');
      assert.equal(moveCalls, 1);
      execution = await test.connection
        .getRepository(SeriesRelocationExecution)
        .findOneByOrFail({ canonicalMediaId: canonical.id });
      assert.equal(
        execution.state,
        SeriesRelocationState.RECONCILIATION_REQUIRED
      );
      assert.equal(execution.activeKey, `series:${canonical.id}`);
    } finally {
      await test.close();
    }
  });
});

describe('Series relocation durable recovery', () => {
  it('releases a recovered claim only when provider invocation never began', async () => {
    const test = await fixture();
    try {
      const canonical = await test.connection
        .getRepository(CanonicalMedia)
        .save(
          new CanonicalMedia({
            mediaType: LibraryMediaType.SERIES,
            titleSnapshot: 'Interrupted Series',
          })
        );
      const stored = await test.connection
        .getRepository(SeriesRelocationExecution)
        .save(
          new SeriesRelocationExecution({
            id: '00000000-0000-4000-8000-000000000002',
            canonicalMediaId: canonical.id,
            state: SeriesRelocationState.CLAIMED,
            activeKey: `series:${canonical.id}`,
            serviceId: 1,
            sonarrSeriesId: 20,
            sourceRootFolderId: 3,
            destinationRootFolderId: 9,
            sourceVolumeId: 'physical:volume3',
            destinationVolumeId: 'physical:volume9',
            sourcePath: '/volume3/shows/Series',
            destinationPath: '/volume9/shows/Series',
            expectedEpisodeFileIds: [11],
            expectedFileCount: 1,
            expectedBytes: '100',
          })
        );
      const service = new SeriesRelocationService(
        dependencies(test.connection)
      );
      assert.deepEqual(await service.reconcileOutstanding(), [
        {
          canonicalMediaId: canonical.id,
          executionId: stored.id,
          outcome: 'blocked',
          reason: 'pre-provider-terminated',
        },
      ]);
      const recovered = await test.connection
        .getRepository(SeriesRelocationExecution)
        .findOneByOrFail({ id: stored.id });
      assert.equal(recovered.state, SeriesRelocationState.COMPLETED);
      assert.equal(recovered.activeKey, null);
      assert.equal(recovered.providerStartedAt, null);
      assert.equal(recovered.verifiedAt, null);
      assert.equal(recovered.failureCode, 'pre-provider-terminated');
      assert.deepEqual(await service.reconcileOutstanding(), []);
      assert.equal((await service.reconciliationRequired()).length, 0);
    } finally {
      await test.close();
    }
  });

  it('keeps pending and ambiguous moves locked, then releases a manually repaired destination', async () => {
    const test = await fixture();
    const settings = new Settings();
    settings.sonarr = [{ id: 2 } as SonarrSettings];
    let providerState: 'pending' | 'unavailable' | 'completed' = 'pending';
    let moveCalls = 0;
    const api = {
      getSeriesById: async () => {
        if (providerState === 'unavailable') throw new Error('offline');
        return {
          path:
            providerState === 'completed'
              ? '/volume9/shows/Series'
              : '/volume3/shows/Series',
          pendingPath:
            providerState === 'pending' ? '/volume9/shows/Series' : null,
        } as SonarrSeries;
      },
      getEpisodeFiles: async () => {
        if (providerState === 'unavailable') throw new Error('offline');
        return [
          {
            id: 11,
            size: 100,
            path:
              providerState === 'completed'
                ? '/volume9/shows/Series/S01E01.mkv'
                : '/volume3/shows/Series/S01E01.mkv',
          },
        ] as SonarrEpisodeFile[];
      },
      getSeriesMoveCommands: async () => {
        if (providerState === 'unavailable') throw new Error('offline');
        return providerState === 'pending'
          ? [
              {
                id: 7,
                commandName: 'MoveSeries',
                status: 'started',
                body: {
                  seriesId: 20,
                  destinationPath: '/volume9/shows/Series',
                },
              },
            ]
          : [];
      },
      moveSeries: async () => {
        moveCalls += 1;
      },
    } as unknown as SonarrAPI;
    try {
      const canonical = await test.connection
        .getRepository(CanonicalMedia)
        .save(
          new CanonicalMedia({
            mediaType: LibraryMediaType.SERIES,
            titleSnapshot: 'Recoverable Series',
          })
        );
      const execution = await test.connection
        .getRepository(SeriesRelocationExecution)
        .save(
          new SeriesRelocationExecution({
            id: '00000000-0000-4000-8000-000000000003',
            canonicalMediaId: canonical.id,
            state: SeriesRelocationState.PROVIDER_IN_FLIGHT,
            activeKey: `series:${canonical.id}`,
            serviceId: 2,
            sonarrSeriesId: 20,
            sourceRootFolderId: 3,
            destinationRootFolderId: 9,
            sourceVolumeId: 'physical:volume3',
            destinationVolumeId: 'physical:volume9',
            sourcePath: '/volume3/shows/Series',
            destinationPath: '/volume9/shows/Series',
            expectedEpisodeFileIds: [11],
            expectedFileCount: 1,
            expectedBytes: '100',
            providerStartedAt: new Date('2026-10-17T23:59:00.000Z'),
          })
        );
      const service = new SeriesRelocationService(
        dependencies(test.connection, {
          settings: () => settings,
          createSonarr: () => api,
        })
      );

      assert.equal(
        (await service.reconcileOutstanding())[0].reason,
        'move-pending'
      );
      let stored = await test.connection
        .getRepository(SeriesRelocationExecution)
        .findOneByOrFail({ id: execution.id });
      assert.equal(stored.state, SeriesRelocationState.VERIFYING);
      assert.equal(stored.activeKey, `series:${canonical.id}`);

      providerState = 'unavailable';
      assert.equal(
        (await service.reconcileOutstanding())[0].reason,
        'verification-failed'
      );
      stored = await test.connection
        .getRepository(SeriesRelocationExecution)
        .findOneByOrFail({ id: execution.id });
      assert.equal(stored.state, SeriesRelocationState.RECONCILIATION_REQUIRED);
      assert.equal(stored.activeKey, `series:${canonical.id}`);

      providerState = 'completed';
      assert.equal((await service.reconcileOutstanding())[0].outcome, 'moved');
      stored = await test.connection
        .getRepository(SeriesRelocationExecution)
        .findOneByOrFail({ id: execution.id });
      assert.equal(stored.state, SeriesRelocationState.COMPLETED);
      assert.equal(stored.activeKey, null);
      assert.ok(stored.verifiedAt);
      assert.equal(moveCalls, 0);
      assert.deepEqual(await service.reconcileOutstanding(), []);
    } finally {
      await test.close();
    }
  });

  it('runs independently of Overflow Routing and Series Placement and deduplicates overlapping runs', async () => {
    const test = await fixture();
    let release!: (value: StorageDiscoveryResult) => void;
    const blockedDiscovery = new Promise<StorageDiscoveryResult>((resolve) => {
      release = resolve;
    });
    const settings = new Settings();
    settings.overflow = {
      ...DEFAULT_OVERFLOW_SETTINGS,
      enabled: false,
      automaticSeriesPlacement: false,
      defaultSeriesVolumeId: 'physical:volume3',
      expansionSeriesVolumeId: 'physical:volume9',
      routes: [],
    };
    const service = new SeriesRelocationService(
      dependencies(test.connection, {
        settings: () => settings,
        discover: () => blockedDiscovery,
      })
    );
    try {
      const first = service.run();
      const second = service.run();
      assert.strictEqual(first, second);
      release({ locations: [], volumes: [], instances: [], refreshedAt: '' });
      const result = await first;
      assert.deepEqual(result.results, [
        {
          canonicalMediaId: 0,
          outcome: 'blocked',
          reason: 'configuration-incomplete',
        },
      ]);
      assert.equal(service.running(), false);
    } finally {
      await test.close();
    }
  });

  it('keeps a possibly submitted source-side move locked and never resubmits it', async () => {
    const test = await fixture();
    let timestamp = Date.parse('2026-10-18T00:00:00.000Z');
    const service = new SeriesRelocationService(
      dependencies(test.connection, {
        now: () => new Date(timestamp),
        sleep: async (milliseconds) => {
          timestamp += milliseconds;
        },
        pollIntervalMs: 10,
        verificationTimeoutMs: 10,
      })
    );
    const api = {
      getSeriesById: async () => ({ path: '/volume3/shows/Series' }),
      getEpisodeFiles: async () => [
        {
          id: 11,
          size: 100,
          path: '/volume3/shows/Series/S01E01.mkv',
        },
      ],
      getSeriesMoveCommands: async () => [],
    } as unknown as SonarrAPI;
    try {
      assert.deepEqual(
        await service.waitForReconciliation(
          api,
          new SeriesRelocationExecution({
            sonarrSeriesId: 20,
            destinationPath: '/volume9/shows/Series',
            expectedEpisodeFileIds: [11],
            expectedFileCount: 1,
            expectedBytes: '100',
          })
        ),
        {
          outcome: 'ambiguous',
          reason:
            'Sonarr does not provide conclusive evidence that the possibly submitted move completed or remained safely at its source.',
        }
      );
    } finally {
      await test.close();
    }
  });
});
