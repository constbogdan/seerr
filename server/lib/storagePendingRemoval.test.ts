import { LibraryMediaType } from '@server/constants/libraryHistory';
import {
  RemovalExecutionInitiator,
  RemovalExecutionState,
  RemovalScheduleOrigin,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import { RemovalExecution } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import {
  loadStorageUsageProjection,
  projectStorageUsage,
  type PendingRemovalScheduleFact,
  type StorageFileFactRow,
} from '@server/lib/storageSettings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

setupTestDb();

const row = (
  fileId: number,
  canonicalMediaId: number,
  sizeBytes: string | null,
  sourceRootId: number | null,
  seasonNumber: number | null = null,
  provider: 'radarr' | 'sonarr' = 'sonarr'
): StorageFileFactRow => ({
  fileId,
  sizeBytes,
  provider: sourceRootId === null ? null : provider,
  serviceId: sourceRootId === null ? null : provider === 'radarr' ? 1 : 2,
  sourceRootId,
  canonicalMediaId,
  sourceSystem: provider,
  sourceScope: `service:${provider === 'radarr' ? 1 : 2}`,
  servarrHasFile: true,
  seasonNumber,
});

const schedule = (
  id: number,
  canonicalMediaId: number,
  targetType: RemovalTargetType,
  seasonNumber: number | null = null,
  sourceSystem: 'radarr' | 'sonarr' = 'sonarr'
): PendingRemovalScheduleFact => ({
  id,
  canonicalMediaId,
  targetType,
  seasonNumber,
  sourceSystem,
  sourceScope: `service:${sourceSystem === 'radarr' ? 1 : 2}`,
});

describe('Storage pending-removal projection', () => {
  it('deduplicates whole-media, Season, duplicate-schedule, and shared-Episode files', () => {
    const projection = projectStorageUsage({
      fileRows: [
        row(1, 10, '100', 10, null, 'radarr'),
        row(2, 20, '200', 20, 1),
        row(2, 20, '200', 20, 1),
        row(3, 20, '300', 21, 2),
      ],
      schedules: [
        schedule(1, 10, RemovalTargetType.MOVIE, null, 'radarr'),
        schedule(2, 20, RemovalTargetType.SERIES),
        schedule(3, 20, RemovalTargetType.SEASON, 1),
        schedule(4, 20, RemovalTargetType.SEASON, 1),
      ],
    });

    assert.deepEqual(projection, {
      roots: [
        {
          provider: 'radarr',
          serviceId: 1,
          sourceRootId: 10,
          sizeBytes: '100',
          pendingRemovalBytes: '100',
        },
        {
          provider: 'sonarr',
          serviceId: 2,
          sourceRootId: 20,
          sizeBytes: '200',
          pendingRemovalBytes: '200',
        },
        {
          provider: 'sonarr',
          serviceId: 2,
          sourceRootId: 21,
          sizeBytes: '300',
          pendingRemovalBytes: '300',
        },
      ],
      pendingRemovalAvailable: true,
      pendingRemovalComplete: true,
      omittedScheduleCount: 0,
    });
  });

  it('omits ambiguous cross-Season, unknown-size, unrooted, and uncertain files', () => {
    const projection = projectStorageUsage({
      fileRows: [
        row(1, 20, '200', 20, 1),
        row(2, 20, '50', 20, 1),
        row(2, 20, '50', 20, 2),
        row(3, 20, null, 20, 1),
        row(4, 20, '75', null, 1),
        row(5, 30, '80', 21, null),
      ],
      schedules: [
        schedule(1, 20, RemovalTargetType.SEASON, 1),
        schedule(2, 30, RemovalTargetType.SERIES),
      ],
      ambiguousCanonicalMediaIds: [30],
    });

    assert.equal(
      projection.roots.find(({ sourceRootId }) => sourceRootId === 20)
        ?.pendingRemovalBytes,
      '200'
    );
    assert.equal(
      projection.roots.find(({ sourceRootId }) => sourceRootId === 21)
        ?.pendingRemovalBytes,
      '0'
    );
    assert.equal(projection.pendingRemovalComplete, false);
    assert.equal(projection.omittedScheduleCount, 2);
  });

  it('represents an unavailable removal projection with null pending bytes', () => {
    const projection = projectStorageUsage({
      fileRows: [row(1, 10, '100', 10, null, 'radarr')],
      schedules: [],
      pendingRemovalAvailable: false,
    });
    assert.equal(projection.roots[0].sizeBytes, '100');
    assert.equal(projection.roots[0].pendingRemovalBytes, null);
    assert.equal(projection.pendingRemovalAvailable, false);
    assert.equal(projection.pendingRemovalComplete, false);
  });

  it('uses only actionable persisted schedules and rejects uncertain provider-boundary executions', async () => {
    const radarrRoot = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 1,
        sourceRootId: 10,
        pathSnapshot: '/volume1/media-movies',
      })
    );
    const sonarrRoot = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'sonarr',
        serviceId: 2,
        sourceRootId: 20,
        pathSnapshot: '/volume3/media-shows',
      })
    );
    const movie = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Scheduled Movie',
      })
    );
    const uncertainMovie = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Uncertain Movie',
      })
    );
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Scheduled Series',
      })
    );
    const noFileMovie = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'No Current File',
      })
    );

    const savePresenceAndFile = async ({
      canonicalMediaId,
      provider,
      serviceId,
      root,
      fileId,
      sizeBytes,
    }: {
      canonicalMediaId: number;
      provider: 'radarr' | 'sonarr';
      serviceId: number;
      root: StorageRoot;
      fileId: string;
      sizeBytes: string;
    }) => {
      const presence = await getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId,
          sourceSystem: provider,
          sourceScope: `service:${serviceId}`,
          sourceItemId: `${provider}:${canonicalMediaId}`,
          sourceGeneration: 'current',
          storageRootId: root.id,
          servarrHasFile: true,
          isCurrent: true,
        })
      );
      const file = await getRepository(LibraryFile).save(
        new LibraryFile({
          libraryPresenceId: presence.id,
          sourceSystem: provider,
          sourceScope: `service:${serviceId}`,
          sourceFileId: fileId,
          sourceGeneration: 'current',
          storageRootId: root.id,
          sizeBytes,
          isCurrent: true,
        })
      );
      return { presence, file };
    };

    await savePresenceAndFile({
      canonicalMediaId: movie.id,
      provider: 'radarr',
      serviceId: 1,
      root: radarrRoot,
      fileId: 'movie-file',
      sizeBytes: '100',
    });
    const uncertain = await savePresenceAndFile({
      canonicalMediaId: uncertainMovie.id,
      provider: 'radarr',
      serviceId: 1,
      root: radarrRoot,
      fileId: 'uncertain-file',
      sizeBytes: '80',
    });
    const seasonOneFile = await savePresenceAndFile({
      canonicalMediaId: series.id,
      provider: 'sonarr',
      serviceId: 2,
      root: sonarrRoot,
      fileId: 'season-one-file',
      sizeBytes: '200',
    });
    const crossSeasonFile = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: seasonOneFile.presence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:2',
        sourceFileId: 'cross-season-file',
        sourceGeneration: 'current',
        storageRootId: sonarrRoot.id,
        sizeBytes: '50',
        isCurrent: true,
      })
    );

    const seasons = await getRepository(CanonicalSeason).save([
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 }),
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 2 }),
    ]);
    const episodes = await getRepository(CanonicalEpisode).save([
      new CanonicalEpisode({ seasonId: seasons[0].id, episodeNumber: 1 }),
      new CanonicalEpisode({ seasonId: seasons[0].id, episodeNumber: 2 }),
      new CanonicalEpisode({ seasonId: seasons[1].id, episodeNumber: 1 }),
    ]);
    await getRepository(LibraryFileEpisode).save([
      new LibraryFileEpisode({
        libraryFileId: seasonOneFile.file.id,
        canonicalEpisodeId: episodes[0].id,
      }),
      new LibraryFileEpisode({
        libraryFileId: seasonOneFile.file.id,
        canonicalEpisodeId: episodes[1].id,
      }),
      new LibraryFileEpisode({
        libraryFileId: crossSeasonFile.id,
        canonicalEpisodeId: episodes[0].id,
      }),
      new LibraryFileEpisode({
        libraryFileId: crossSeasonFile.id,
        canonicalEpisodeId: episodes[2].id,
      }),
    ]);

    const saveSchedule = (init: Partial<RemovalSchedule>) =>
      getRepository(RemovalSchedule).save(
        new RemovalSchedule({
          canonicalMediaId: movie.id,
          targetType: RemovalTargetType.MOVIE,
          seasonNumber: null,
          sourceSystem: 'radarr',
          sourceScope: 'service:1',
          origin: RemovalScheduleOrigin.MANUAL,
          status: RemovalScheduleStatus.ACTIVE,
          activeKey: null,
          scheduledAt: new Date('2026-10-01T00:00:00Z'),
          removeAt: new Date('2026-12-01T00:00:00Z'),
          ...init,
        })
      );
    await saveSchedule({});
    await saveSchedule({ canonicalMediaId: noFileMovie.id });
    await saveSchedule({
      canonicalMediaId: series.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 1,
      sourceSystem: 'sonarr',
      sourceScope: 'service:2',
      status: RemovalScheduleStatus.DEFERRED,
    });
    for (const status of [
      RemovalScheduleStatus.CANCELLED,
      RemovalScheduleStatus.COMPLETED,
      RemovalScheduleStatus.FAILED,
    ]) {
      await saveSchedule({ status });
    }
    const uncertainSchedule = await saveSchedule({
      canonicalMediaId: uncertainMovie.id,
    });
    await getRepository(RemovalExecution).save(
      new RemovalExecution({
        id: randomUUID(),
        canonicalMediaId: uncertainMovie.id,
        targetType: RemovalTargetType.MOVIE,
        seasonNumber: null,
        initiator: RemovalExecutionInitiator.SCHEDULED,
        state: RemovalExecutionState.UNCERTAIN,
        fence: 1,
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        sourceItemId: `radarr:${uncertainMovie.id}`,
        sourceGeneration: 'current',
        libraryPresenceId: uncertain.presence.id,
        scheduleId: uncertainSchedule.id,
        scheduleRevision: uncertainSchedule.revision,
      })
    );

    const projection = await loadStorageUsageProjection();
    assert.deepEqual(
      projection.roots.map((root) => ({
        provider: root.provider,
        root: root.sourceRootId,
        indexed: root.sizeBytes,
        pending: root.pendingRemovalBytes,
      })),
      [
        { provider: 'radarr', root: 10, indexed: '180', pending: '100' },
        { provider: 'sonarr', root: 20, indexed: '250', pending: '200' },
      ]
    );
    assert.equal(projection.pendingRemovalAvailable, true);
    assert.equal(projection.pendingRemovalComplete, false);
    assert.equal(projection.omittedScheduleCount, 2);
  });
});
