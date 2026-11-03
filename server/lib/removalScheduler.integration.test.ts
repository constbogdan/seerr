import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

import {
  LibraryMediaType,
  LibraryRemovalSource,
  ViewingCompletionClassification,
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
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import downloadTracker from '@server/lib/downloadtracker';
import { LibraryService } from '@server/lib/library';
import {
  MediaRemovalError,
  type RemovalTarget,
} from '@server/lib/mediaRemoval';
import { RemovalScheduler } from '@server/lib/removalScheduler';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const now = new Date('2026-10-06T12:00:00.000Z');
let media: CanonicalMedia;

beforeEach(async () => {
  getSettings().removal = structuredClone(DEFAULT_REMOVAL_SETTINGS);
  media = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: 'Removal Fixture',
      year: 2020,
    })
  );
  await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: media.id,
      sourceSystem: 'radarr',
      sourceScope: 'service:0',
      sourceItemId: '42',
      addedAt: new Date('2025-01-01T00:00:00.000Z'),
      firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
      servarrHasFile: true,
      isCurrent: true,
    })
  );
});

const dueSchedule = async () =>
  getRepository(RemovalSchedule).save(
    new RemovalSchedule({
      canonicalMediaId: media.id,
      targetType: RemovalTargetType.MOVIE,
      sourceSystem: 'radarr',
      sourceScope: 'service:0',
      origin: RemovalScheduleOrigin.MANUAL,
      status: RemovalScheduleStatus.ACTIVE,
      activeKey: `service:0:${media.id}:movie:-`,
      scheduledAt: new Date('2026-10-01T00:00:00.000Z'),
      removeAt: new Date('2026-10-05T00:00:00.000Z'),
    })
  );

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

describe('RemovalScheduler due execution', () => {
  it('creates a fresh per-run batch while previous batches remain active', async () => {
    mock.method(downloadTracker, 'getMovieProgress', () => []);
    mock.method(acquisitionMonitor, 'refresh', async () =>
      Promise.resolve({
        authoritative: true,
      } as Awaited<ReturnType<typeof acquisitionMonitor.refresh>>)
    );
    for (let index = 0; index < 4; index += 1) {
      const extra = await getRepository(CanonicalMedia).save(
        new CanonicalMedia({
          mediaType: LibraryMediaType.MOVIE,
          titleSnapshot: `Batch Fixture ${index}`,
          year: 2020,
        })
      );
      await getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId: extra.id,
          sourceSystem: 'radarr',
          sourceScope: 'service:0',
          sourceItemId: `movie:${100 + index}`,
          addedAt: new Date(`2025-01-0${index + 2}T00:00:00.000Z`),
          firstObservedAt: new Date(`2025-01-0${index + 2}T00:00:00.000Z`),
          servarrHasFile: true,
          isCurrent: true,
        })
      );
    }
    getSettings().removal = {
      ...structuredClone(DEFAULT_REMOVAL_SETTINGS),
      removalScanEnabled: true,
      movie: {
        ...DEFAULT_REMOVAL_SETTINGS.movie,
        enabled: true,
        minimumAgeMonths: 0,
        inactivityMonths: 0,
        itemsPerRun: 2,
      },
    };
    const scheduler = new RemovalScheduler(undefined, () => now);
    const twoItemPreview = await scheduler.preview(getSettings().removal);
    const fourItemPreview = await scheduler.preview({
      ...getSettings().removal,
      movie: { ...getSettings().removal.movie, itemsPerRun: 4 },
    });

    assert.equal(twoItemPreview.movie.candidates.length, 2);
    assert.equal(fourItemPreview.movie.candidates.length, 4);
    assert.deepEqual(
      fourItemPreview.movie.candidates
        .slice(0, 2)
        .map((candidate) => candidate.canonicalMediaId),
      twoItemPreview.movie.candidates.map(
        (candidate) => candidate.canonicalMediaId
      )
    );

    const first = await scheduler.runCandidateSelection();
    const second = await scheduler.runCandidateSelection();
    const active = await scheduler.leavingSoon();
    const activePreview = await scheduler.preview(getSettings().removal);

    assert.equal(first.movie.eligibleUnscheduled, 5);
    assert.equal(first.movie.selectedCandidates.length, 2);
    assert.equal(second.movie.eligibleUnscheduled, 3);
    assert.equal(second.movie.selectedCandidates.length, 2);
    assert.equal(active.length, 4);
    assert.equal(activePreview.actionableScheduleCount, 4);
    assert.equal(
      new Set(active.map((schedule) => schedule.canonicalMediaId)).size,
      4
    );
    assert.ok(
      active.every(
        (schedule) =>
          schedule.removeAt.getTime() - schedule.scheduledAt.getTime() ===
          60 * 86_400_000
      )
    );
  });

  it('claims and completes a due schedule exactly once', async () => {
    const schedule = await dueSchedule();
    const remove = mock.fn(async (target: RemovalTarget) => {
      assert.equal(target.removalSource, LibraryRemovalSource.SCHEDULED);
      return {
        targetType: RemovalTargetType.MOVIE,
        providerResult: 'removed' as const,
      };
    });
    const scheduler = new RemovalScheduler(
      { remove },
      () => now,
      mockScheduledExecutor(remove)
    );

    const first = await scheduler.runScheduledRemovalProcessing();
    const second = await scheduler.runScheduledRemovalProcessing();

    assert.equal(first.completed, 1);
    assert.equal(second.completed, 0);
    assert.equal(remove.mock.callCount(), 1);
    const stored = await getRepository(RemovalSchedule).findOneByOrFail({
      id: schedule.id,
    });
    assert.equal(stored.status, RemovalScheduleStatus.COMPLETED);
    assert.equal(stored.activeKey, null);
    assert.equal(stored.leaseToken, null);
  });

  it('defers acquisition and transient failures without destructive retry overlap', async () => {
    const schedule = await dueSchedule();
    const remove = mock.fn(async () => {
      throw new MediaRemovalError(
        'ACTIVE_ACQUISITION',
        'Acquisition is active'
      );
    });
    const scheduler = new RemovalScheduler(
      { remove },
      () => now,
      mockScheduledExecutor(remove)
    );

    const result = await scheduler.runScheduledRemovalProcessing();
    const stored = await getRepository(RemovalSchedule).findOneByOrFail({
      id: schedule.id,
    });
    assert.equal(result.deferred, 1);
    assert.equal(stored.status, RemovalScheduleStatus.DEFERRED);
    assert.ok(stored.removeAt > now);
    assert.equal(stored.activeKey, `service:0:${media.id}:movie:-`);
  });

  it('clears all actionable schedules without invoking media removal', async () => {
    await dueSchedule();
    const secondMedia = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Deferred Fixture',
      })
    );
    await getRepository(RemovalSchedule).save(
      new RemovalSchedule({
        canonicalMediaId: secondMedia.id,
        targetType: RemovalTargetType.MOVIE,
        sourceSystem: 'radarr',
        sourceScope: 'service:0',
        origin: RemovalScheduleOrigin.AUTOMATIC,
        status: RemovalScheduleStatus.DEFERRED,
        activeKey: `service:0:${secondMedia.id}:movie:-`,
        scheduledAt: new Date('2026-10-01T00:00:00.000Z'),
        removeAt: new Date('2026-10-07T00:00:00.000Z'),
      })
    );
    const remove = mock.fn(async () => ({
      targetType: RemovalTargetType.MOVIE,
      providerResult: 'removed' as const,
    }));
    const scheduler = new RemovalScheduler(
      { remove },
      () => now,
      mockScheduledExecutor(remove)
    );

    const result = await scheduler.clearAllScheduledRemovals();

    assert.equal(result.cancelled, 2);
    assert.equal((await scheduler.leavingSoon()).length, 0);
    assert.equal(remove.mock.callCount(), 0);
    assert.deepEqual(
      (await getRepository(RemovalSchedule).find({ order: { id: 'ASC' } })).map(
        (schedule) => schedule.status
      ),
      [RemovalScheduleStatus.CANCELLED, RemovalScheduleStatus.CANCELLED]
    );
  });

  it('cancels for factual activity after scheduling and never calls removal', async () => {
    const schedule = await dueSchedule();
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'historical-manual-activity',
        sourceActivityId: 'new-activity',
        canonicalMediaId: media.id,
        observedAt: new Date('2026-10-02T00:00:00.000Z'),
      })
    );
    const remove = mock.fn(async () => ({
      targetType: RemovalTargetType.MOVIE,
      providerResult: 'removed' as const,
    }));
    const scheduler = new RemovalScheduler(
      { remove },
      () => now,
      mockScheduledExecutor(remove)
    );

    const result = await scheduler.runScheduledRemovalProcessing();
    const stored = await getRepository(RemovalSchedule).findOneByOrFail({
      id: schedule.id,
    });
    assert.equal(result.cancelledForActivity, 1);
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(stored.status, RemovalScheduleStatus.CANCELLED);
    assert.equal(stored.activeKey, null);
  });

  it('cancels a Season only for activity in that Season', async () => {
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Season Fixture',
        year: 2020,
      })
    );
    const seriesPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceItemId: '84',
        addedAt: new Date('2025-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const seasonOne = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
    );
    const seasonTwo = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 2 })
    );
    const episodeOne = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: seasonOne.id, episodeNumber: 1 })
    );
    const episodeTwo = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: seasonTwo.id, episodeNumber: 1 })
    );
    for (const [index, episode] of [episodeOne, episodeTwo].entries()) {
      const file = await getRepository(LibraryFile).save(
        new LibraryFile({
          libraryPresenceId: seriesPresence.id,
          sourceSystem: 'sonarr',
          sourceScope: 'service:0',
          sourceFileId: `season-scope-file-${index}`,
          importedAt: new Date('2025-01-01T00:00:00.000Z'),
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
    const schedule = await getRepository(RemovalSchedule).save(
      new RemovalSchedule({
        canonicalMediaId: series.id,
        targetType: RemovalTargetType.SEASON,
        seasonNumber: 1,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        origin: RemovalScheduleOrigin.MANUAL,
        status: RemovalScheduleStatus.ACTIVE,
        activeKey: `service:0:${series.id}:season:1`,
        scheduledAt: new Date('2026-10-01T00:00:00.000Z'),
        removeAt: new Date('2026-10-10T00:00:00.000Z'),
      })
    );
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'historical-manual-activity',
        sourceActivityId: 'other-season-activity',
        canonicalMediaId: series.id,
        canonicalEpisodeId: episodeTwo.id,
        observedAt: new Date('2026-10-02T00:00:00.000Z'),
      })
    );
    const remove = mock.fn(async () => ({
      targetType: RemovalTargetType.SEASON,
      providerResult: 'removed' as const,
    }));
    const scheduler = new RemovalScheduler(
      { remove },
      () => now,
      mockScheduledExecutor(remove)
    );

    await scheduler.runScheduledRemovalProcessing();
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: schedule.id,
        })
      ).status,
      RemovalScheduleStatus.ACTIVE
    );

    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'historical-manual-activity',
        sourceActivityId: 'target-season-activity',
        canonicalMediaId: series.id,
        canonicalEpisodeId: episodeOne.id,
        observedAt: new Date('2026-10-03T00:00:00.000Z'),
      })
    );
    const result = await scheduler.runScheduledRemovalProcessing();

    assert.equal(result.cancelledForActivity, 1);
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: schedule.id,
        })
      ).status,
      RemovalScheduleStatus.CANCELLED
    );
    assert.equal(remove.mock.callCount(), 0);
  });

  it('previews disabled eligibility and selection without mutating schedules', async () => {
    mock.method(downloadTracker, 'getMovieProgress', () => []);
    const scheduler = new RemovalScheduler(undefined, () => now);
    const before = await getRepository(RemovalSchedule).count();
    const disabledPreview = await scheduler.preview({
      ...DEFAULT_REMOVAL_SETTINGS,
      movie: {
        ...DEFAULT_REMOVAL_SETTINGS.movie,
        enabled: false,
        minimumAgeMonths: 0,
        inactivityMonths: 0,
        itemsPerRun: 10,
      },
    });
    const enabledPreview = await scheduler.preview({
      ...DEFAULT_REMOVAL_SETTINGS,
      movie: {
        ...DEFAULT_REMOVAL_SETTINGS.movie,
        enabled: true,
        minimumAgeMonths: 0,
        inactivityMonths: 0,
        itemsPerRun: 10,
      },
      removalScanEnabled: true,
    });

    assert.equal(disabledPreview.movie.eligibleUnscheduled, 1);
    assert.equal(disabledPreview.movie.candidates.length, 1);
    assert.equal(disabledPreview.actionableScheduleCount, 0);
    assert.equal(enabledPreview.movie.candidates.length, 1);
    assert.equal(await getRepository(RemovalSchedule).count(), before);
  });

  it('uses the same factual Movie activity as Library without substituting observation time', async () => {
    mock.method(downloadTracker, 'getMovieProgress', () => []);
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceUserId: 'viewer',
      })
    );
    const jellyfinId = '0123456789abcdef0123456789abcdef';
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: media.id,
        sourceSystem: 'jellyfin',
        sourceScope: 'jf',
        sourceItemId: `movie:${jellyfinId}`,
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    await getRepository(CurrentViewingState).save(
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: 'jf',
        sourceItemId: jellyfinId,
        mediaType: 'movie',
        canonicalMediaId: media.id,
        played: false,
        progressBasisPoints: 0,
        lastPlayedAt: null,
        observedAt: now,
      })
    );
    const factualActivity = new Date('2026-02-14T17:35:59.694Z');
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'history',
        sourceActivityId: 'factual-movie-activity',
        canonicalMediaId: media.id,
        observedAt: factualActivity,
        progressBasisPoints: 5000,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      })
    );
    const scheduler = new RemovalScheduler(undefined, () => now);
    const preview = await scheduler.preview({
      ...DEFAULT_REMOVAL_SETTINGS,
      movie: {
        ...DEFAULT_REMOVAL_SETTINGS.movie,
        enabled: false,
        minimumAgeMonths: 0,
        inactivityMonths: 0,
      },
    });
    const library = await new LibraryService().query({
      take: 25,
      skip: 0,
      scope: 'current',
      mediaType: 'movie',
      watchlist: 'any',
      watched: 'any',
      sort: 'title',
      sortDirection: 'asc',
      scheduled: 'any',
    });

    assert.equal(
      preview.movie.candidates[0].lastActiveAt,
      factualActivity.toISOString()
    );
    assert.equal(
      preview.movie.candidates[0].lastActiveAt,
      library.results[0].lastActiveAt
    );
    assert.equal(
      preview.movie.candidates[0].addedAt,
      library.results[0].addedAt
    );
    assert.notEqual(
      preview.movie.candidates[0].lastActiveAt,
      now.toISOString()
    );
  });

  it('keeps never-active activity null and falls back to factual Added', async () => {
    mock.method(downloadTracker, 'getMovieProgress', () => []);
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'history',
        sourceActivityId: 'non-qualifying-observation',
        canonicalMediaId: media.id,
        observedAt: now,
        completionClassification: ViewingCompletionClassification.UNKNOWN,
      })
    );
    const preview = await new RemovalScheduler(undefined, () => now).preview({
      ...DEFAULT_REMOVAL_SETTINGS,
      movie: {
        ...DEFAULT_REMOVAL_SETTINGS.movie,
        enabled: false,
        minimumAgeMonths: 0,
        inactivityMonths: 0,
      },
    });
    const candidate = preview.movie.candidates[0];

    assert.equal(candidate.lastActiveAt, null);
    assert.equal(candidate.lastActiveAt, null);
    assert.notEqual(candidate.addedAt, now.toISOString());
  });

  it('uses the latest qualifying available Episode activity for Series', async () => {
    mock.method(downloadTracker, 'getSeriesProgress', () => []);
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Series Activity Fixture',
        year: 2020,
      })
    );
    const presence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:0',
        sourceItemId: 'series:84',
        addedAt: new Date('2025-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const season = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
    );
    const episodeOne = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: season.id, episodeNumber: 1 })
    );
    const episodeTwo = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: season.id, episodeNumber: 2 })
    );
    for (const [index, episode] of [episodeOne, episodeTwo].entries()) {
      const file = await getRepository(LibraryFile).save(
        new LibraryFile({
          libraryPresenceId: presence.id,
          sourceSystem: 'sonarr',
          sourceScope: 'service:0',
          sourceFileId: `file-${index}`,
          importedAt: new Date('2025-01-01T00:00:00.000Z'),
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
    const activities = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-03-01T00:00:00.000Z'),
    ];
    for (const [index, episode] of [episodeOne, episodeTwo].entries()) {
      await getRepository(ViewingEvidence).save(
        new ViewingEvidence({
          source: 'jellyfin',
          sourceScope: 'jf',
          sourceClass: 'history',
          sourceActivityId: `series-activity-${index}`,
          canonicalMediaId: series.id,
          canonicalEpisodeId: episode.id,
          observedAt: activities[index],
          progressBasisPoints: 5000,
          completionClassification: ViewingCompletionClassification.PARTIAL,
        })
      );
    }
    const preview = await new RemovalScheduler(undefined, () => now).preview({
      ...DEFAULT_REMOVAL_SETTINGS,
      series: {
        ...DEFAULT_REMOVAL_SETTINGS.series,
        enabled: false,
        minimumAgeMonths: 0,
        inactivityMonths: 0,
      },
    });
    const candidate = preview.series.candidates.find(
      (item) => item.canonicalMediaId === series.id
    );

    assert.equal(candidate?.lastActiveAt, activities[1].toISOString());
  });
});
