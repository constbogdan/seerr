import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  LibraryMediaType,
  LibraryRemovalSource,
} from '@server/constants/libraryHistory';
import {
  DEFAULT_REMOVAL_SETTINGS,
  RemovalScheduleOrigin,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import { RemovalExecution } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import type { LibraryBulkActionTarget } from '@server/interfaces/api/libraryInterfaces';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import downloadTracker from '@server/lib/downloadtracker';
import {
  LibraryBulkActionService,
  LibraryBulkActionValidationError,
  validateLibraryBulkActionTargets,
} from '@server/lib/libraryBulkActions';
import {
  MediaRemovalError,
  MediaRemovalService,
  type RemovalTarget,
} from '@server/lib/mediaRemoval';
import {
  RemovalScheduleConflictError,
  RemovalScheduler,
} from '@server/lib/removalScheduler';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const now = new Date('2026-10-09T12:00:00.000Z');

const mockScheduledExecutor = (
  remove: (target: RemovalTarget) => Promise<unknown>
) => ({
  recover: async () => ({ released: 0, reconciled: 0 }),
  execute: async (schedule: RemovalSchedule) => {
    const stored = await getRepository(RemovalSchedule).findOneBy({
      id: schedule.id,
      revision: schedule.revision,
    });
    if (
      !stored ||
      ![RemovalScheduleStatus.ACTIVE, RemovalScheduleStatus.DEFERRED].includes(
        stored.status
      )
    ) {
      return 'skipped' as const;
    }
    try {
      await remove({
        canonicalMediaId: schedule.canonicalMediaId,
        targetType: schedule.targetType,
        seasonNumber: schedule.seasonNumber ?? undefined,
        sourceScope: schedule.sourceScope,
        removalSource: LibraryRemovalSource.SCHEDULED,
      });
      const actionable = await getRepository(RemovalSchedule).find({
        where: { canonicalMediaId: schedule.canonicalMediaId },
      });
      for (const candidate of actionable.filter(
        (item) =>
          item.id === schedule.id ||
          (schedule.targetType === RemovalTargetType.SERIES &&
            item.targetType === RemovalTargetType.SEASON)
      )) {
        candidate.status = RemovalScheduleStatus.COMPLETED;
        candidate.activeKey = null;
        candidate.completedAt = now;
        candidate.revision += 1;
        await getRepository(RemovalSchedule).save(candidate);
      }
      return 'completed' as const;
    } catch (error) {
      stored.status = RemovalScheduleStatus.DEFERRED;
      stored.removeAt = new Date(now.getTime() + 15 * 60_000);
      stored.failureCode =
        error instanceof MediaRemovalError ? error.code : 'UNKNOWN';
      stored.failureMessage =
        error instanceof Error ? error.message : 'Removal failed';
      stored.revision += 1;
      await getRepository(RemovalSchedule).save(stored);
      return 'deferred' as const;
    }
  },
});

beforeEach(() => {
  getSettings().removal = structuredClone(DEFAULT_REMOVAL_SETTINGS);
  getSettings().radarr = [
    {
      id: 0,
      name: 'Radarr zero',
      hostname: 'radarr',
      port: 7878,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as RadarrSettings,
    {
      id: 1,
      name: 'Radarr one',
      hostname: 'radarr-one',
      port: 7878,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: false,
    } as RadarrSettings,
  ];
  getSettings().sonarr = [
    {
      id: 0,
      name: 'Sonarr zero',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as SonarrSettings,
  ];
  mock.method(acquisitionMonitor, 'refresh', async () =>
    Promise.resolve({ authoritative: true } as Awaited<
      ReturnType<typeof acquisitionMonitor.refresh>
    >)
  );
  mock.method(downloadTracker, 'getMovieProgress', () => []);
  mock.method(downloadTracker, 'getSeriesProgress', () => []);
});

afterEach(() => mock.reset());

const createMovie = async (options?: {
  current?: boolean;
  secondCurrentSource?: boolean;
}) => {
  const media = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: 'Safety Movie',
    })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: media.id,
      mediaType: LibraryMediaType.MOVIE,
      provider: 'tmdb',
      sourceScope: '',
      value: String(10_000 + media.id),
    })
  );
  const current = options?.current ?? true;
  const presence = await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: media.id,
      sourceSystem: 'radarr',
      sourceScope: 'service:0',
      sourceItemId: `movie:${100 + media.id}`,
      sourceGeneration: 'primary',
      firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
      servarrHasFile: true,
      isCurrent: current,
    })
  );
  await getRepository(LibraryFile).save(
    new LibraryFile({
      libraryPresenceId: presence.id,
      sourceSystem: 'radarr',
      sourceScope: 'service:0',
      sourceFileId: `movie-file:${media.id}`,
      sourceGeneration: 'primary',
      firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
      isCurrent: current,
    })
  );
  if (options?.secondCurrentSource) {
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: media.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:1',
        sourceItemId: `movie:${200 + media.id}`,
        sourceGeneration: 'secondary',
        firstObservedAt: new Date('2025-01-02T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
  }
  return { media, presence };
};

const createSeries = async () => {
  const media = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.SERIES,
      titleSnapshot: 'Safety Series',
    })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: media.id,
      mediaType: LibraryMediaType.SERIES,
      provider: 'tvdb',
      sourceScope: '',
      value: String(20_000 + media.id),
    })
  );
  const presence = await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: media.id,
      sourceSystem: 'sonarr',
      sourceScope: 'service:0',
      sourceItemId: `series:${300 + media.id}`,
      sourceGeneration: 'primary',
      firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
      servarrHasFile: true,
      isCurrent: true,
    })
  );
  for (const seasonNumber of [1, 2]) {
    const season = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: media.id, seasonNumber })
    );
    const episode = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: season.id,
        episodeNumber: 1,
        isSpecial: false,
      })
    );
    const file = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceFileId: `series-file:${media.id}:${seasonNumber}`,
        sourceGeneration: 'primary',
        firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
        isCurrent: true,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: episode.id,
      })
    );
  }
  return { media, presence };
};

const actionableSchedule = async (input: {
  canonicalMediaId: number;
  targetType: RemovalTargetType;
  seasonNumber?: number;
  sourceSystem: 'radarr' | 'sonarr';
  sourceScope?: string;
  leaseToken?: string;
  leaseUntil?: Date;
}) =>
  getRepository(RemovalSchedule).save(
    new RemovalSchedule({
      canonicalMediaId: input.canonicalMediaId,
      targetType: input.targetType,
      seasonNumber: input.seasonNumber ?? null,
      sourceSystem: input.sourceSystem,
      sourceScope: input.sourceScope ?? 'service:0',
      origin: RemovalScheduleOrigin.MANUAL,
      status: RemovalScheduleStatus.ACTIVE,
      activeKey: `${input.canonicalMediaId}:${input.targetType}:${
        input.seasonNumber ?? '-'
      }:${input.sourceScope ?? 'service:0'}`,
      scheduledAt: new Date('2026-10-01T00:00:00.000Z'),
      removeAt: new Date('2026-10-08T00:00:00.000Z'),
      leaseToken: input.leaseToken ?? null,
      leaseUntil: input.leaseUntil ?? null,
    })
  );

const radarrOnlyService = (
  removeMovie: (tmdbId: number) => Promise<'removed' | 'absent'>
) =>
  new MediaRemovalService({
    createRadarr: () => ({ removeMovie }),
    createSonarr: () => {
      throw new Error('Unexpected Sonarr client');
    },
  });

describe('Removal destructive-path safety', () => {
  it('preflights typed canonical identities and Season coordinates before batch mutation', async () => {
    const movie = await createMovie();
    const series = await createSeries();
    await validateLibraryBulkActionTargets([
      { canonicalMediaId: movie.media.id, targetType: 'movie' },
      {
        canonicalMediaId: series.media.id,
        targetType: 'season',
        seasonNumber: 1,
      },
    ]);
    await assert.rejects(
      validateLibraryBulkActionTargets([
        { canonicalMediaId: movie.media.id, targetType: 'series' },
      ]),
      LibraryBulkActionValidationError
    );
    await assert.rejects(
      validateLibraryBulkActionTargets([
        {
          canonicalMediaId: series.media.id,
          targetType: 'season',
          seasonNumber: 99,
        },
      ]),
      LibraryBulkActionValidationError
    );
  });

  it('rejects typed mismatches, archived targets, and ambiguous current sources', async () => {
    const removeMovie = mock.fn(async () => 'removed' as const);
    const service = radarrOnlyService(removeMovie);
    const typed = await createMovie();
    await assert.rejects(
      service.remove({
        canonicalMediaId: typed.media.id,
        targetType: RemovalTargetType.SERIES,
        removalSource: LibraryRemovalSource.MANUAL,
      }),
      (error: unknown) =>
        error instanceof MediaRemovalError && error.code === 'IDENTITY_CONFLICT'
    );

    const archived = await createMovie({ current: false });
    await assert.rejects(
      service.remove({
        canonicalMediaId: archived.media.id,
        targetType: RemovalTargetType.MOVIE,
        removalSource: LibraryRemovalSource.MANUAL,
      }),
      (error: unknown) =>
        error instanceof MediaRemovalError && error.code === 'NOT_CURRENT'
    );

    const ambiguous = await createMovie({ secondCurrentSource: true });
    await assert.rejects(
      service.remove({
        canonicalMediaId: ambiguous.media.id,
        targetType: RemovalTargetType.MOVIE,
        removalSource: LibraryRemovalSource.MANUAL,
      }),
      (error: unknown) =>
        error instanceof MediaRemovalError && error.code === 'AMBIGUOUS_SOURCE'
    );
    assert.equal(removeMovie.mock.callCount(), 0);
  });

  it('atomically supersedes child Seasons and rolls back when a child lease is live', async () => {
    const { media } = await createSeries();
    const scheduler = new RemovalScheduler(undefined, () => now);
    const first = await scheduler.createManual({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 1,
    });
    const second = await scheduler.createManual({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 2,
    });
    const parent = await scheduler.createManual({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.SERIES,
    });
    assert.equal(parent.status, RemovalScheduleStatus.ACTIVE);
    assert.deepEqual(
      (
        await getRepository(RemovalSchedule).findBy({
          id: first.id,
        })
      ).map(({ status }) => status),
      [RemovalScheduleStatus.CANCELLED]
    );
    assert.equal(
      (await getRepository(RemovalSchedule).findOneByOrFail({ id: second.id }))
        .status,
      RemovalScheduleStatus.CANCELLED
    );

    const other = await createSeries();
    const unleased = await scheduler.createManual({
      canonicalMediaId: other.media.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 1,
    });
    const leased = await scheduler.createManual({
      canonicalMediaId: other.media.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 2,
    });
    leased.leaseToken = 'live-child';
    leased.leaseUntil = new Date(now.getTime() + 60_000);
    await getRepository(RemovalSchedule).save(leased);
    await assert.rejects(
      scheduler.createManual({
        canonicalMediaId: other.media.id,
        targetType: RemovalTargetType.SERIES,
      }),
      RemovalScheduleConflictError
    );
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: unleased.id,
        })
      ).status,
      RemovalScheduleStatus.ACTIVE
    );
    assert.equal(
      await getRepository(RemovalSchedule).countBy({
        canonicalMediaId: other.media.id,
        targetType: RemovalTargetType.SERIES,
        status: RemovalScheduleStatus.ACTIVE,
      }),
      0
    );
  });

  it('reports manual idempotency and cancels every exact source-scoped schedule without current presence', async () => {
    const { media, presence } = await createMovie();
    const scheduler = new RemovalScheduler(undefined, () => now);
    const first = await scheduler.createManualWithResult({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
    });
    const duplicate = await scheduler.createManualWithResult({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
    });
    assert.equal(first.created, true);
    assert.equal(first.affectedSchedules, 1);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.affectedSchedules, 0);

    await actionableSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
    });
    presence.isCurrent = false;
    presence.servarrHasFile = false;
    await getRepository(LibraryPresence).save(presence);

    const cancelled = await scheduler.cancelExactTarget({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
    });
    assert.deepEqual(cancelled, {
      affectedSchedules: 2,
      inProgress: false,
    });
  });

  it('does not cancel any exact-target schedule while one source schedule has a live lease', async () => {
    const { media } = await createMovie();
    const scheduler = new RemovalScheduler(undefined, () => now);
    const unleased = await actionableSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
    });
    await actionableSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
      leaseToken: 'live',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    assert.deepEqual(
      await scheduler.cancelExactTarget({
        canonicalMediaId: media.id,
        targetType: RemovalTargetType.MOVIE,
      }),
      { affectedSchedules: 0, inProgress: true }
    );
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: unleased.id,
        })
      ).status,
      RemovalScheduleStatus.ACTIVE
    );
  });

  it('reconciles a successful whole-Series schedule and all child schedules', async () => {
    const { media } = await createSeries();
    const parent = await actionableSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.SERIES,
      sourceSystem: 'sonarr',
    });
    const child = await actionableSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.SEASON,
      seasonNumber: 1,
      sourceSystem: 'sonarr',
    });
    const remove = mock.fn(async () => ({
      targetType: RemovalTargetType.SERIES,
      providerResult: 'removed' as const,
    }));
    const scheduler = new RemovalScheduler(
      { remove },
      () => now,
      mockScheduledExecutor(remove)
    );

    const result = await scheduler.runScheduledRemovalProcessing();

    assert.equal(result.completed, 1);
    assert.equal(remove.mock.callCount(), 1);
    for (const id of [parent.id, child.id]) {
      const stored = await getRepository(RemovalSchedule).findOneByOrFail({
        id,
      });
      assert.equal(stored.status, RemovalScheduleStatus.COMPLETED);
      assert.equal(stored.activeKey, null);
      assert.equal(stored.leaseToken, null);
    }
  });

  it('executes Bulk Remove Now through the hardened service and reconciles schedules in order', async () => {
    const first = await createMovie();
    const second = await createMovie();
    const firstSchedule = await actionableSchedule({
      canonicalMediaId: first.media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
    });
    const secondSchedule = await actionableSchedule({
      canonicalMediaId: second.media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
    });
    const providerOrder: number[] = [];
    const removalService = radarrOnlyService(async (tmdbId) => {
      providerOrder.push(tmdbId);
      return providerOrder.length === 1 ? 'removed' : 'absent';
    });
    const scheduler = new RemovalScheduler(undefined, () => now);
    const bulk = new LibraryBulkActionService({
      scheduler,
      validateTargets: validateLibraryBulkActionTargets,
      resolveTarget: async () => {
        throw new Error('Schedule resolution must not run for Remove Now');
      },
      refreshAcquisitionState: async () => undefined,
      assertAcquisitionInactive: () => undefined,
      acquireExecutionGuard: () => {
        throw new Error('The batch must not acquire a second removal guard');
      },
      removeTarget: (target: LibraryBulkActionTarget) =>
        removalService.remove({
          canonicalMediaId: target.canonicalMediaId,
          targetType: target.targetType as RemovalTargetType,
          seasonNumber: target.seasonNumber,
          removalSource: LibraryRemovalSource.MANUAL,
        }),
    } as never);

    const response = await bulk.execute({
      action: 'remove_now',
      targets: [
        { canonicalMediaId: first.media.id, targetType: 'movie' },
        { canonicalMediaId: second.media.id, targetType: 'movie' },
      ],
    });

    assert.deepEqual(
      response.results.map(({ outcome }) => outcome),
      ['provider_acknowledged', 'provider_absent_reconciled']
    );
    assert.deepEqual(providerOrder, [
      10_000 + first.media.id,
      10_000 + second.media.id,
    ]);
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: firstSchedule.id,
        })
      ).status,
      RemovalScheduleStatus.COMPLETED
    );
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: secondSchedule.id,
        })
      ).status,
      RemovalScheduleStatus.COMPLETED
    );
  });

  it('rejects Season Remove Now while a whole-Series schedule is actionable', async () => {
    const { media } = await createSeries();
    await actionableSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.SERIES,
      sourceSystem: 'sonarr',
    });
    const service = new MediaRemovalService({
      createRadarr: () => {
        throw new Error('Unexpected Radarr client');
      },
      createSonarr: () => {
        throw new Error('Provider must not be called');
      },
    });

    await assert.rejects(
      service.remove({
        canonicalMediaId: media.id,
        targetType: RemovalTargetType.SEASON,
        seasonNumber: 1,
        removalSource: LibraryRemovalSource.MANUAL,
      }),
      (error: unknown) =>
        error instanceof MediaRemovalError && error.code === 'SCHEDULE_CONFLICT'
    );
  });

  it('serializes manual and scheduled execution and respects existing leases', async () => {
    const { media } = await createMovie();
    const schedule = await actionableSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
      leaseToken: 'scheduled-worker',
      leaseUntil: new Date(now.getTime() + 60_000),
    });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let providerStarted!: () => void;
    const providerStart = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const removeMovie = mock.fn(async () => {
      providerStarted();
      await providerRelease;
      return 'removed' as const;
    });
    const service = radarrOnlyService(removeMovie);
    const scheduled = service.remove({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceScope: 'service:0',
      removalSource: LibraryRemovalSource.SCHEDULED,
      executionLeaseToken: schedule.leaseToken ?? undefined,
    });
    await providerStart;
    await assert.rejects(
      service.remove({
        canonicalMediaId: media.id,
        targetType: RemovalTargetType.MOVIE,
        sourceScope: 'service:0',
        removalSource: LibraryRemovalSource.MANUAL,
      }),
      (error: unknown) =>
        error instanceof MediaRemovalError &&
        error.code === 'EXECUTION_CONFLICT'
    );
    releaseProvider();
    await scheduled;
    assert.equal(removeMovie.mock.callCount(), 1);

    const leased = await createMovie();
    await actionableSchedule({
      canonicalMediaId: leased.media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
      leaseToken: 'other-worker',
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await assert.rejects(
      service.remove({
        canonicalMediaId: leased.media.id,
        targetType: RemovalTargetType.MOVIE,
        removalSource: LibraryRemovalSource.MANUAL,
      }),
      (error: unknown) =>
        error instanceof MediaRemovalError &&
        error.code === 'EXECUTION_CONFLICT'
    );
  });

  it('quarantines an ambiguous provider failure without destructive retry', async () => {
    const { media } = await createMovie();
    let attempts = 0;
    const removeMovie = mock.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Provider transport failed');
      return 'removed' as const;
    });
    const service = radarrOnlyService(removeMovie);
    const target = {
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      removalSource: LibraryRemovalSource.MANUAL,
    } as const;

    await assert.rejects(
      service.remove(target),
      (error: unknown) =>
        error instanceof MediaRemovalError &&
        error.code === 'REMOTE_REMOVED_LOCAL_FAILED'
    );
    await assert.rejects(
      service.remove(target),
      (error: unknown) =>
        error instanceof MediaRemovalError &&
        error.code === 'EXECUTION_CONFLICT'
    );
    assert.equal(removeMovie.mock.callCount(), 1);
  });

  it('defers provider-success/local-failure without claiming physical deletion', async () => {
    const { media } = await createMovie();
    await actionableSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
    });
    const removeMovie = mock.fn(async () => 'removed' as const);
    const service = radarrOnlyService(removeMovie);
    mock.method(service, 'reconcileResolvedRemoval', async () => {
      throw new Error('Simulated local reconciliation failure');
    });
    await assert.rejects(
      service.remove({
        canonicalMediaId: media.id,
        targetType: RemovalTargetType.MOVIE,
        removalSource: LibraryRemovalSource.MANUAL,
      }),
      (error: unknown) =>
        error instanceof MediaRemovalError &&
        error.code === 'REMOTE_REMOVED_LOCAL_FAILED'
    );
    const stored = await getRepository(RemovalSchedule).findOneByOrFail({
      canonicalMediaId: media.id,
    });
    const execution = await getRepository(RemovalExecution).findOneByOrFail({
      canonicalMediaId: media.id,
    });

    assert.equal(stored.status, RemovalScheduleStatus.ACTIVE);
    assert.equal(execution.state, 'reconciliation_required');
    assert.equal(execution.failureCode, 'REMOTE_REMOVED_LOCAL_FAILED');
    assert.equal(execution.providerOutcome, 'acknowledged');
    assert.equal(execution.physicalAbsenceConfirmedAt, null);
    assert.equal(removeMovie.mock.callCount(), 1);
  });
});
