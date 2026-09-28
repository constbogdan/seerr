import {
  DEFAULT_DOWNLOAD_QUEUE_SIZE,
  validateDownloadQueueSize,
} from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isEqual, uniqWith } from 'lodash';

interface EpisodeNumberResult {
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number;
  id: number;
}
export interface DownloadingItem {
  mediaType: MediaType;
  externalId: number;
  size: number;
  sizeLeft: number;
  status: string;
  timeLeft: string;
  estimatedCompletionTime: Date;
  title: string;
  downloadId: string;
  episode?: EpisodeNumberResult;
}

export interface DownloadTrackerUpdateOutcome {
  providersAttempted: number;
  providersSucceeded: number;
  providersFailed: number;
  // Counts authoritative queue items once per successfully refreshed physical
  // server, before Seerr alias-specific display caps are applied.
  queueCount: number;
  changed: boolean;
  authoritative: boolean;
}

interface ProviderRefreshOutcome {
  succeeded: boolean;
  queueCount: number;
  changed: boolean;
}

export class DownloadTracker {
  private radarrServers: Record<number, DownloadingItem[]> = {};
  private sonarrServers: Record<number, DownloadingItem[]> = {};
  private updatePromise?: Promise<DownloadTrackerUpdateOutcome>;

  public getMovieProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.radarrServers[serverId]) {
      return [];
    }

    return this.radarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public getSeriesProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.sonarrServers[serverId]) {
      return [];
    }

    return this.sonarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.sonarrServers = {};
  }

  public updateDownloads(): Promise<DownloadTrackerUpdateOutcome> {
    if (!this.updatePromise) {
      this.updatePromise = this.performUpdateDownloads().finally(() => {
        this.updatePromise = undefined;
      });
    }

    return this.updatePromise;
  }

  private async performUpdateDownloads(): Promise<DownloadTrackerUpdateOutcome> {
    const outcomes = (
      await Promise.all([
        this.updateRadarrDownloads(),
        this.updateSonarrDownloads(),
      ])
    ).flat();
    const providersSucceeded = outcomes.filter(
      (outcome) => outcome.succeeded
    ).length;
    const providersFailed = outcomes.length - providersSucceeded;

    return {
      providersAttempted: outcomes.length,
      providersSucceeded,
      providersFailed,
      queueCount: outcomes.reduce(
        (count, outcome) => count + outcome.queueCount,
        0
      ),
      changed: outcomes.some((outcome) => outcome.changed),
      authoritative: providersFailed === 0,
    };
  }

  private async updateRadarrDownloads(): Promise<ProviderRefreshOutcome[]> {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(
      settings.radarr.filter((radarr) => radarr.syncEnabled),
      (radarrA, radarrB) => {
        return (
          radarrA.hostname === radarrB.hostname &&
          radarrA.port === radarrB.port &&
          radarrA.baseUrl === radarrB.baseUrl
        );
      }
    );

    // Load downloads from Radarr servers
    return Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const matchingServers = settings.radarr.filter(
            (rs) =>
              rs.hostname === server.hostname &&
              rs.port === server.port &&
              rs.baseUrl === server.baseUrl &&
              rs.id !== server.id &&
              rs.syncEnabled
          );
          const radarr = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });
          try {
            const physicalServerQueueSize = Math.max(
              ...[server, ...matchingServers].map((rs) =>
                validateDownloadQueueSize(
                  rs.downloadQueueSize ?? DEFAULT_DOWNLOAD_QUEUE_SIZE
                )
              )
            );
            await radarr.refreshMonitoredDownloads();
            const queueItems = await radarr.getQueue(physicalServerQueueSize);

            const serverDownloads = queueItems.map((item) => ({
              externalId: item.movieId,
              estimatedCompletionTime: new Date(item.estimatedCompletionTime),
              mediaType: MediaType.MOVIE,
              size: item.size,
              sizeLeft: item.sizeleft,
              status: item.status,
              timeLeft: item.timeleft,
              title: item.title,
              downloadId: item.downloadId,
            }));

            const downloads = serverDownloads.slice(
              0,
              validateDownloadQueueSize(
                server.downloadQueueSize ?? DEFAULT_DOWNLOAD_QUEUE_SIZE
              )
            );
            let changed = !isEqual(
              this.radarrServers[server.id] ?? [],
              downloads
            );
            this.radarrServers[server.id] = downloads;

            matchingServers.forEach((ms) => {
              const matchingDownloads = serverDownloads.slice(
                0,
                validateDownloadQueueSize(
                  ms.downloadQueueSize ?? DEFAULT_DOWNLOAD_QUEUE_SIZE
                )
              );
              changed =
                !isEqual(this.radarrServers[ms.id] ?? [], matchingDownloads) ||
                changed;
              this.radarrServers[ms.id] = matchingDownloads;
            });

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Radarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
            if (matchingServers.length > 0) {
              logger.debug(
                `Matching download data to ${matchingServers.length} other Radarr server(s)`,
                { label: 'Download Tracker' }
              );
            }

            return {
              succeeded: true,
              queueCount: queueItems.length,
              changed,
            };
          } catch {
            logger.error(
              `Unable to get queue from Radarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
            if (matchingServers.length > 0) {
              logger.debug(
                `Matching download data to ${matchingServers.length} other Radarr server(s)`,
                { label: 'Download Tracker' }
              );
            }

            return {
              succeeded: false,
              queueCount: 0,
              changed: false,
            };
          }
        }

        return {
          succeeded: false,
          queueCount: 0,
          changed: false,
        };
      })
    );
  }

  private async updateSonarrDownloads(): Promise<ProviderRefreshOutcome[]> {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(
      settings.sonarr.filter((sonarr) => sonarr.syncEnabled),
      (sonarrA, sonarrB) => {
        return (
          sonarrA.hostname === sonarrB.hostname &&
          sonarrA.port === sonarrB.port &&
          sonarrA.baseUrl === sonarrB.baseUrl
        );
      }
    );

    // Load downloads from Sonarr servers
    return Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const matchingServers = settings.sonarr.filter(
            (ss) =>
              ss.hostname === server.hostname &&
              ss.port === server.port &&
              ss.baseUrl === server.baseUrl &&
              ss.id !== server.id &&
              ss.syncEnabled
          );
          const sonarr = new SonarrAPI({
            apiKey: server.apiKey,
            url: SonarrAPI.buildUrl(server, '/api/v3'),
          });
          try {
            const physicalServerQueueSize = Math.max(
              ...[server, ...matchingServers].map((ss) =>
                validateDownloadQueueSize(
                  ss.downloadQueueSize ?? DEFAULT_DOWNLOAD_QUEUE_SIZE
                )
              )
            );
            await sonarr.refreshMonitoredDownloads();
            const queueItems = await sonarr.getQueue(physicalServerQueueSize);

            const serverDownloads = queueItems.map((item) => ({
              externalId: item.seriesId,
              estimatedCompletionTime: new Date(item.estimatedCompletionTime),
              mediaType: MediaType.TV,
              size: item.size,
              sizeLeft: item.sizeleft,
              status: item.status,
              timeLeft: item.timeleft,
              title: item.title,
              episode: item.episode,
              downloadId: item.downloadId,
            }));

            const downloads = serverDownloads.slice(
              0,
              validateDownloadQueueSize(
                server.downloadQueueSize ?? DEFAULT_DOWNLOAD_QUEUE_SIZE
              )
            );
            let changed = !isEqual(
              this.sonarrServers[server.id] ?? [],
              downloads
            );
            this.sonarrServers[server.id] = downloads;

            matchingServers.forEach((ms) => {
              const matchingDownloads = serverDownloads.slice(
                0,
                validateDownloadQueueSize(
                  ms.downloadQueueSize ?? DEFAULT_DOWNLOAD_QUEUE_SIZE
                )
              );
              changed =
                !isEqual(this.sonarrServers[ms.id] ?? [], matchingDownloads) ||
                changed;
              this.sonarrServers[ms.id] = matchingDownloads;
            });

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Sonarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
            if (matchingServers.length > 0) {
              logger.debug(
                `Matching download data to ${matchingServers.length} other Sonarr server(s)`,
                { label: 'Download Tracker' }
              );
            }

            return {
              succeeded: true,
              queueCount: queueItems.length,
              changed,
            };
          } catch {
            logger.error(
              `Unable to get queue from Sonarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
            if (matchingServers.length > 0) {
              logger.debug(
                `Matching download data to ${matchingServers.length} other Sonarr server(s)`,
                { label: 'Download Tracker' }
              );
            }

            return {
              succeeded: false,
              queueCount: 0,
              changed: false,
            };
          }
        }

        return {
          succeeded: false,
          queueCount: 0,
          changed: false,
        };
      })
    );
  }
}

const downloadTracker = new DownloadTracker();

export default downloadTracker;
