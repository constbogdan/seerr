import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import blocklistedTagsProcessor from '@server/job/blocklistedTagsProcessor';
import nextSeason, {
  nextSeasonJobEnabled,
  runNextSeason,
  runNextSeasonDryRun,
  setNextSeasonJobEnabled,
} from '@server/job/nextSeasonJob';
import {
  removalJobEnabled,
  startRemovalProcessing,
  startRemovalScan,
} from '@server/job/removalJobs';
import seriesRelocation, {
  runSeriesRelocation,
  seriesRelocationJobEnabled,
  setSeriesRelocationJobEnabled,
} from '@server/job/seriesRelocationJob';
import { synchronizationPolicy } from '@server/job/synchronizationPolicy';
import {
  runMovieWatchlistRoulette,
  runSeriesWatchlistRoulette,
  setWatchlistRouletteJobEnabled,
  watchlistRouletteJobEnabled,
  watchlistRouletteJobResult,
  watchlistRouletteJobRunning,
} from '@server/job/watchlistRouletteJobs';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import availabilitySync from '@server/lib/availabilitySync';
import currentJellyfinViewing from '@server/lib/currentJellyfinViewing';
import freshService from '@server/lib/fresh/service';
import ImageProxy from '@server/lib/imageproxy';
import jellyfinRecentScanCoordinator from '@server/lib/jellyfinRecentScanCoordinator';
import libraryHistoryHydration from '@server/lib/libraryHistoryHydration';
import refreshToken from '@server/lib/refreshToken';
import removalScheduler from '@server/lib/removalScheduler';
import {
  jellyfinFullScanner,
  jellyfinRecentScanner,
} from '@server/lib/scanners/jellyfin';
import { plexFullScanner, plexRecentScanner } from '@server/lib/scanners/plex';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { JobId } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import watchlistMetadataBackfill from '@server/lib/watchlistMetadata';
import watchlistPlayStateSync from '@server/lib/watchlistPlayState';
import watchlistSync from '@server/lib/watchlistsync';
import logger from '@server/logger';
import schedule from 'node-schedule';

export interface ScheduledJob {
  id: JobId;
  job: schedule.Job;
  name: string;
  type: 'process' | 'command';
  interval: 'seconds' | 'minutes' | 'hours' | 'days' | 'fixed';
  cronSchedule: string;
  running?: () => boolean;
  enabled?: () => boolean;
  configurableEnabled?: boolean;
  setEnabled?: (enabled: boolean) => Promise<void>;
  result?: () => unknown;
  cancelFn?: () => void;
  commissioningRun?: () => Promise<unknown>;
  dryRun?: () => Promise<unknown>;
  showDryRunAction?: boolean;
}

export const scheduledJobs: ScheduledJob[] = [];

export const isDryRunActionAvailable = (
  job: Pick<ScheduledJob, 'dryRun' | 'showDryRunAction'>
): boolean => Boolean(job.dryRun) && job.showDryRunAction !== false;

export const runDownloadSync = () => acquisitionMonitor.refresh('background');

export const resetDownloadSync = () => acquisitionMonitor.resetAndReconcile();

const scheduleGuardedJob = (
  id: JobId,
  cronSchedule: string,
  callback: () => void | Promise<unknown>
): schedule.Job =>
  schedule.scheduleJob(cronSchedule, () =>
    synchronizationPolicy.executeScheduled(id, callback)
  );

interface NextSeasonScheduledJobDependencies {
  schedule: typeof scheduleGuardedJob;
  run: typeof runNextSeason;
  running: () => boolean;
  enabled: typeof nextSeasonJobEnabled;
  setEnabled: typeof setNextSeasonJobEnabled;
  result: () => unknown;
  cancel: () => void;
  dryRun: typeof runNextSeasonDryRun;
}

export const createNextSeasonScheduledJob = (
  cronSchedule: string,
  dependencies: NextSeasonScheduledJobDependencies = {
    schedule: scheduleGuardedJob,
    run: runNextSeason,
    running: () => nextSeason.running(),
    enabled: nextSeasonJobEnabled,
    setEnabled: setNextSeasonJobEnabled,
    result: () => nextSeason.status(),
    cancel: () => nextSeason.cancel(),
    dryRun: runNextSeasonDryRun,
  }
): ScheduledJob => ({
  id: 'next-season',
  name: 'Next Season',
  type: 'process',
  interval: 'minutes',
  cronSchedule,
  job: dependencies.schedule('next-season', cronSchedule, dependencies.run),
  running: dependencies.running,
  enabled: dependencies.enabled,
  configurableEnabled: true,
  setEnabled: dependencies.setEnabled,
  result: dependencies.result,
  cancelFn: dependencies.cancel,
  dryRun: dependencies.dryRun,
  showDryRunAction: false,
});

export const startJobs = async (): Promise<void> => {
  const jobs = getSettings().jobs;
  const mediaServerType = getSettings().main.mediaServerType;

  if (synchronizationPolicy.startupCatchUpsAllowed) {
    await currentJellyfinViewing.recoverAbandonedRuns();
    await seriesRelocation.reconcileOutstanding();
  }

  if (mediaServerType === MediaServerType.PLEX) {
    // Run recently added plex scan every 5 minutes
    scheduledJobs.push({
      id: 'plex-recently-added-scan',
      name: 'Plex Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['plex-recently-added-scan'].schedule,
      job: scheduleGuardedJob(
        'plex-recently-added-scan',
        jobs['plex-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Plex Recently Added Scan', {
            label: 'Jobs',
          });
          plexRecentScanner.run();
        }
      ),
      running: () => plexRecentScanner.status().running,
      cancelFn: () => plexRecentScanner.cancel(),
    });

    // Run full plex scan every 24 hours
    scheduledJobs.push({
      id: 'plex-full-scan',
      name: 'Plex Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['plex-full-scan'].schedule,
      job: scheduleGuardedJob(
        'plex-full-scan',
        jobs['plex-full-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Plex Full Library Scan', {
            label: 'Jobs',
          });
          plexFullScanner.run();
        }
      ),
      running: () => plexFullScanner.status().running,
      cancelFn: () => plexFullScanner.cancel(),
    });

    scheduledJobs.push({
      id: 'plex-refresh-token',
      name: 'Plex Refresh Token',
      type: 'process',
      interval: 'fixed',
      cronSchedule: jobs['plex-refresh-token'].schedule,
      job: scheduleGuardedJob(
        'plex-refresh-token',
        jobs['plex-refresh-token'].schedule,
        () => {
          logger.info('Starting scheduled job: Plex Refresh Token', {
            label: 'Jobs',
          });
          refreshToken.run();
        }
      ),
    });

    // Watchlist Sync
    scheduledJobs.push({
      id: 'plex-watchlist-sync',
      name: 'Plex Watchlist Sync',
      type: 'process',
      interval: 'seconds',
      cronSchedule: jobs['plex-watchlist-sync'].schedule,
      job: scheduleGuardedJob(
        'plex-watchlist-sync',
        jobs['plex-watchlist-sync'].schedule,
        () => {
          logger.info('Starting scheduled job: Plex Watchlist Sync', {
            label: 'Jobs',
          });
          watchlistSync.syncWatchlist().catch((e) => {
            logger.error('Failed to sync watchlists', {
              label: 'Plex Watchlist Sync',
              errorMessage: e.message,
            });
          });
        }
      ),
    });
  } else if (
    mediaServerType === MediaServerType.JELLYFIN ||
    mediaServerType === MediaServerType.EMBY
  ) {
    // Run recently added jellyfin sync every 5 minutes
    scheduledJobs.push({
      id: 'jellyfin-recently-added-scan',
      name: 'Jellyfin Recently Added Scan',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['jellyfin-recently-added-scan'].schedule,
      job: scheduleGuardedJob(
        'jellyfin-recently-added-scan',
        jobs['jellyfin-recently-added-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Jellyfin Recently Added Scan', {
            label: 'Jobs',
          });
          void jellyfinRecentScanCoordinator.run();
        }
      ),
      running: () => jellyfinRecentScanCoordinator.isRunning(),
      cancelFn: () => jellyfinRecentScanner.cancel(),
    });

    // Run full jellyfin sync every 24 hours
    scheduledJobs.push({
      id: 'jellyfin-full-scan',
      name: 'Jellyfin Full Library Scan',
      type: 'process',
      interval: 'hours',
      cronSchedule: jobs['jellyfin-full-scan'].schedule,
      job: scheduleGuardedJob(
        'jellyfin-full-scan',
        jobs['jellyfin-full-scan'].schedule,
        () => {
          logger.info('Starting scheduled job: Jellyfin Full Scan', {
            label: 'Jobs',
          });
          jellyfinFullScanner.run();
        }
      ),
      running: () => jellyfinFullScanner.status().running,
      cancelFn: () => jellyfinFullScanner.cancel(),
    });

    scheduledJobs.push({
      id: 'watchlist-play-state-sync',
      name: 'Watchlist Play State Sync',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['watchlist-play-state-sync'].schedule,
      job: scheduleGuardedJob(
        'watchlist-play-state-sync',
        jobs['watchlist-play-state-sync'].schedule,
        () => {
          logger.info('Starting scheduled job: Watchlist Play State Sync', {
            label: 'Jobs',
          });
          void watchlistPlayStateSync.run().catch((error) => {
            logger.error('Watchlist play-state scheduled sync failed', {
              label: 'Watchlist Play State',
              errorMessage:
                error instanceof Error ? error.message : 'Unknown sync error',
            });
          });
        }
      ),
      running: () => watchlistPlayStateSync.running(),
      cancelFn: () => watchlistPlayStateSync.cancel(),
      commissioningRun: () => watchlistPlayStateSync.run(true),
    });

    scheduledJobs.push({
      id: 'current-jellyfin-viewing-sync',
      name: 'Current Jellyfin Viewing Sync',
      type: 'process',
      interval: 'minutes',
      cronSchedule: jobs['current-jellyfin-viewing-sync'].schedule,
      job: scheduleGuardedJob(
        'current-jellyfin-viewing-sync',
        jobs['current-jellyfin-viewing-sync'].schedule,
        () => {
          logger.info('Starting scheduled job: Current Jellyfin Viewing Sync', {
            label: 'Jobs',
          });
          void currentJellyfinViewing.run().catch((error) => {
            logger.error('Current Jellyfin viewing scheduled sync failed', {
              label: 'Current Jellyfin Viewing',
              errorType:
                error instanceof Error ? error.name : 'UnknownSyncError',
            });
          });
        }
      ),
      running: () => currentJellyfinViewing.running(),
      cancelFn: () => currentJellyfinViewing.cancel(),
      commissioningRun: async () => {
        const result = await currentJellyfinViewing.run();
        if (!result.complete) {
          throw new Error('current_jellyfin_viewing_incomplete');
        }
      },
    });
  }

  // Run full radarr scan every 24 hours
  scheduledJobs.push({
    id: 'radarr-scan',
    name: 'Radarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['radarr-scan'].schedule,
    job: scheduleGuardedJob('radarr-scan', jobs['radarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Radarr Scan', { label: 'Jobs' });
      radarrScanner.run();
    }),
    running: () => radarrScanner.status().running,
    cancelFn: () => radarrScanner.cancel(),
  });

  // Run full sonarr scan every 24 hours
  scheduledJobs.push({
    id: 'sonarr-scan',
    name: 'Sonarr Scan',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['sonarr-scan'].schedule,
    job: scheduleGuardedJob('sonarr-scan', jobs['sonarr-scan'].schedule, () => {
      logger.info('Starting scheduled job: Sonarr Scan', { label: 'Jobs' });
      sonarrScanner.run();
    }),
    running: () => sonarrScanner.status().running,
    cancelFn: () => sonarrScanner.cancel(),
  });

  // Checks if media is still available in plex/sonarr/radarr libs
  scheduledJobs.push({
    id: 'availability-sync',
    name: 'Media Availability Sync',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['availability-sync'].schedule,
    job: scheduleGuardedJob(
      'availability-sync',
      jobs['availability-sync'].schedule,
      () => {
        logger.info('Starting scheduled job: Media Availability Sync', {
          label: 'Jobs',
        });
        availabilitySync.run();
      }
    ),
    running: () => availabilitySync.running,
    cancelFn: () => availabilitySync.cancel(),
  });

  // Run download sync every minute
  scheduledJobs.push({
    id: 'download-sync',
    name: 'Download Sync',
    type: 'command',
    interval: 'seconds',
    cronSchedule: jobs['download-sync'].schedule,
    job: scheduleGuardedJob(
      'download-sync',
      jobs['download-sync'].schedule,
      () => {
        logger.debug('Starting scheduled job: Download Sync', {
          label: 'Jobs',
        });
        runDownloadSync().catch((e) => {
          logger.error(`Failed to update download tracker: ${e.message}`, {
            label: 'Jobs',
          });
        });
      }
    ),
    running: () => acquisitionMonitor.getStatus().refreshing,
  });

  // Reset download sync everyday at 01:00 am
  scheduledJobs.push({
    id: 'download-sync-reset',
    name: 'Download Sync Reset',
    type: 'command',
    interval: 'hours',
    cronSchedule: jobs['download-sync-reset'].schedule,
    job: scheduleGuardedJob(
      'download-sync-reset',
      jobs['download-sync-reset'].schedule,
      () => {
        logger.info('Starting scheduled job: Download Sync Reset', {
          label: 'Jobs',
        });
        resetDownloadSync().catch((e) => {
          logger.error(`Failed to reset download tracker: ${e.message}`, {
            label: 'Jobs',
          });
        });
      }
    ),
    running: () => acquisitionMonitor.getStatus().refreshing,
  });

  // Run image cache cleanup every 24 hours
  scheduledJobs.push({
    id: 'image-cache-cleanup',
    name: 'Image Cache Cleanup',
    type: 'process',
    interval: 'hours',
    cronSchedule: jobs['image-cache-cleanup'].schedule,
    job: scheduleGuardedJob(
      'image-cache-cleanup',
      jobs['image-cache-cleanup'].schedule,
      () => {
        logger.info('Starting scheduled job: Image Cache Cleanup', {
          label: 'Jobs',
        });
        // Clean TMDB image cache
        ImageProxy.clearCache('tmdb');

        // Clean users avatar image cache
        ImageProxy.clearCache('avatar');
      }
    ),
  });

  scheduledJobs.push({
    id: 'process-blocklisted-tags',
    name: 'Process Blocklisted Tags',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['process-blocklisted-tags'].schedule,
    job: scheduleGuardedJob(
      'process-blocklisted-tags',
      jobs['process-blocklisted-tags'].schedule,
      () => {
        logger.info('Starting scheduled job: Process Blocklisted Tags', {
          label: 'Jobs',
        });
        blocklistedTagsProcessor.run();
      }
    ),
    running: () => blocklistedTagsProcessor.status().running,
    cancelFn: () => blocklistedTagsProcessor.cancel(),
  });

  scheduledJobs.push({
    id: 'watchlist-metadata-backfill',
    name: 'Watchlist Metadata Backfill',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['watchlist-metadata-backfill'].schedule,
    job: scheduleGuardedJob(
      'watchlist-metadata-backfill',
      jobs['watchlist-metadata-backfill'].schedule,
      () => {
        logger.info('Starting scheduled job: Watchlist Metadata Backfill', {
          label: 'Jobs',
        });
        void watchlistMetadataBackfill.run();
      }
    ),
    running: () => watchlistMetadataBackfill.running(),
    cancelFn: () => watchlistMetadataBackfill.cancel(),
  });

  scheduledJobs.push({
    id: 'library-history-hydration',
    name: 'Current Library Hydration',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['library-history-hydration'].schedule,
    job: scheduleGuardedJob(
      'library-history-hydration',
      jobs['library-history-hydration'].schedule,
      () => {
        logger.info('Starting scheduled job: Current Library Hydration', {
          label: 'Jobs',
        });
        void libraryHistoryHydration.run();
      }
    ),
    running: () => libraryHistoryHydration.running(),
    commissioningRun: async () => {
      const result = await libraryHistoryHydration.run();
      if (!result.complete) throw new Error('library_hydration_incomplete');
    },
  });

  scheduledJobs.push({
    id: 'removal-candidate-selection',
    name: 'Removal Scan',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['removal-candidate-selection'].schedule,
    job: scheduleGuardedJob(
      'removal-candidate-selection',
      jobs['removal-candidate-selection'].schedule,
      () => {
        startRemovalScan();
      }
    ),
    running: () => removalScheduler.isCandidateSelectionRunning(),
    enabled: () => removalJobEnabled('scan'),
  });

  scheduledJobs.push({
    id: 'scheduled-removal-processing',
    name: 'Removal Processing',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['scheduled-removal-processing'].schedule,
    job: scheduleGuardedJob(
      'scheduled-removal-processing',
      jobs['scheduled-removal-processing'].schedule,
      () => {
        startRemovalProcessing();
      }
    ),
    running: () => removalScheduler.isScheduledRemovalProcessingRunning(),
    enabled: () => removalJobEnabled('processing'),
  });

  scheduledJobs.push({
    id: 'fresh-sync',
    name: 'Fresh Sync',
    type: 'process',
    interval: 'minutes',
    cronSchedule: jobs['fresh-sync'].schedule,
    job: scheduleGuardedJob('fresh-sync', jobs['fresh-sync'].schedule, () => {
      logger.info('Starting scheduled job: Fresh Sync', { label: 'Jobs' });
      void freshService.sync();
    }),
    running: () => freshService.running(),
    cancelFn: () => freshService.cancel(),
    commissioningRun: () => freshService.sync(false, true),
  });

  scheduledJobs.push({
    id: 'fresh-reconciliation',
    name: 'Fresh Reconciliation',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['fresh-reconciliation'].schedule,
    job: scheduleGuardedJob(
      'fresh-reconciliation',
      jobs['fresh-reconciliation'].schedule,
      () => {
        logger.info('Starting scheduled job: Fresh Reconciliation', {
          label: 'Jobs',
        });
        void freshService.reconcile();
      }
    ),
    running: () => freshService.running(),
    cancelFn: () => freshService.cancel(),
  });

  scheduledJobs.push(
    createNextSeasonScheduledJob(jobs['next-season'].schedule)
  );

  scheduledJobs.push({
    id: 'series-relocation',
    name: 'Series Relocation',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['series-relocation'].schedule,
    job: scheduleGuardedJob(
      'series-relocation',
      jobs['series-relocation'].schedule,
      runSeriesRelocation
    ),
    running: () => seriesRelocation.running(),
    enabled: seriesRelocationJobEnabled,
    configurableEnabled: true,
    setEnabled: setSeriesRelocationJobEnabled,
    result: () => seriesRelocation.status(),
  });

  scheduledJobs.push({
    id: 'watchlist-roulette-movies',
    name: 'Watchlist Roulette Movies',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['watchlist-roulette-movies'].schedule,
    job: scheduleGuardedJob(
      'watchlist-roulette-movies',
      jobs['watchlist-roulette-movies'].schedule,
      runMovieWatchlistRoulette
    ),
    running: () => watchlistRouletteJobRunning(MediaType.MOVIE),
    enabled: () => watchlistRouletteJobEnabled('watchlist-roulette-movies'),
    configurableEnabled: true,
    setEnabled: (enabled) =>
      setWatchlistRouletteJobEnabled('watchlist-roulette-movies', enabled),
    result: () => watchlistRouletteJobResult(MediaType.MOVIE),
  });

  scheduledJobs.push({
    id: 'watchlist-roulette-series',
    name: 'Watchlist Roulette Series',
    type: 'process',
    interval: 'days',
    cronSchedule: jobs['watchlist-roulette-series'].schedule,
    job: scheduleGuardedJob(
      'watchlist-roulette-series',
      jobs['watchlist-roulette-series'].schedule,
      runSeriesWatchlistRoulette
    ),
    running: () => watchlistRouletteJobRunning(MediaType.TV),
    enabled: () => watchlistRouletteJobEnabled('watchlist-roulette-series'),
    configurableEnabled: true,
    setEnabled: (enabled) =>
      setWatchlistRouletteJobEnabled('watchlist-roulette-series', enabled),
    result: () => watchlistRouletteJobResult(MediaType.TV),
  });

  logger.info('Scheduled jobs loaded', { label: 'Jobs' });
  if (synchronizationPolicy.startupCatchUpsAllowed) {
    watchlistPlayStateSync.startCatchUp();
    currentJellyfinViewing.startCatchUp();
    libraryHistoryHydration.startCatchUp();
    freshService.startCatchUp();
  }
};
