import {
  DEFAULT_DOWNLOAD_QUEUE_SIZE,
  validateDownloadQueueSize,
  type QueueItem,
  type ServarrQueueStatus,
  type ServarrTrackedDownloadState,
  type ServarrTrackedDownloadStatus,
} from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import {
  AcquisitionPhase,
  deriveAcquisitionState,
  type AcquisitionHealth,
  type AcquisitionSafeReason,
} from '@server/lib/acquisitionPhase';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isEqual, uniqWith } from 'lodash';

export interface EpisodeNumberResult {
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
  status: ServarrQueueStatus;
  trackedDownloadStatus?: ServarrTrackedDownloadStatus;
  trackedDownloadState?: ServarrTrackedDownloadState;
  trackedStatus?: ServarrTrackedDownloadStatus;
  acquisitionPhase?: AcquisitionPhase;
  acquisitionPhaseStartedAt?: string;
  health?: AcquisitionHealth;
  safeReason?: AcquisitionSafeReason;
  timeLeft: string;
  estimatedCompletionTime?: Date;
  title: string;
  downloadId: string;
  episode?: EpisodeNumberResult;
}

interface InternalDownloadingItem extends DownloadingItem {
  queueRecordId: number;
}

export interface ConfirmedServarrImport {
  mediaType: MediaType;
  externalId: number;
  downloadId: string;
  serverAliases: { id: number; is4k: boolean }[];
  episodes: EpisodeNumberResult[];
}

export interface FinalizingAcquisitionTarget {
  mediaType: MediaType;
  externalId: number;
  downloadId: string;
  serverId: number;
  is4k: boolean;
  episodes: EpisodeNumberResult[];
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
  confirmedImports?: ConfirmedServarrImport[];
}

interface ProviderRefreshOutcome {
  succeeded: boolean;
  queueCount: number;
  changed: boolean;
  confirmedImports: ConfirmedServarrImport[];
}

interface ImportConfirmationResult {
  confirmedImports: ConfirmedServarrImport[];
  historyAuthoritative: boolean;
}

interface DownloadTrackerOptions {
  now?: () => number;
}

export class DownloadTracker {
  private radarrServers: Record<number, InternalDownloadingItem[]> = {};
  private sonarrServers: Record<number, InternalDownloadingItem[]> = {};
  private finalizingRadarrServers: Record<number, InternalDownloadingItem[]> =
    {};
  private finalizingSonarrServers: Record<number, InternalDownloadingItem[]> =
    {};
  private updatePromise?: Promise<DownloadTrackerUpdateOutcome>;
  private radarrPhysicalQueues: Record<string, InternalDownloadingItem[]> = {};
  private sonarrPhysicalQueues: Record<string, InternalDownloadingItem[]> = {};
  private readonly now: () => number;

  constructor(options: DownloadTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  public getMovieProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    return this.getProgress(
      this.radarrServers[serverId],
      this.finalizingRadarrServers[serverId],
      externalServiceId
    );
  }

  public getSeriesProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    return this.getProgress(
      this.sonarrServers[serverId],
      this.finalizingSonarrServers[serverId],
      externalServiceId
    );
  }

  public startFinalizing(
    target: FinalizingAcquisitionTarget,
    phaseStartedAt: string
  ): void {
    const store =
      target.mediaType === MediaType.MOVIE
        ? this.finalizingRadarrServers
        : this.finalizingSonarrServers;
    const retained = (store[target.serverId] ?? []).filter(
      (item) =>
        item.externalId !== target.externalId ||
        item.downloadId !== target.downloadId
    );
    const episodes = target.episodes.length ? target.episodes : [undefined];
    store[target.serverId] = [
      ...retained,
      ...episodes.map((episode, index) => ({
        mediaType: target.mediaType,
        externalId: target.externalId,
        size: 0,
        sizeLeft: 0,
        status: 'completed' as const,
        trackedDownloadStatus: 'ok' as const,
        trackedDownloadState: 'imported' as const,
        trackedStatus: 'ok' as const,
        acquisitionPhase: AcquisitionPhase.FINALIZING,
        acquisitionPhaseStartedAt: phaseStartedAt,
        health: 'ok' as const,
        timeLeft: '',
        title: '',
        downloadId: target.downloadId,
        episode,
        queueRecordId: -(index + 1),
      })),
    ];
  }

  public clearFinalizing(target: FinalizingAcquisitionTarget): void {
    const store =
      target.mediaType === MediaType.MOVIE
        ? this.finalizingRadarrServers
        : this.finalizingSonarrServers;
    store[target.serverId] = (store[target.serverId] ?? []).filter(
      (item) =>
        item.externalId !== target.externalId ||
        item.downloadId !== target.downloadId
    );
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.sonarrServers = {};
    this.radarrPhysicalQueues = {};
    this.sonarrPhysicalQueues = {};
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

    const confirmedImports = outcomes.flatMap(
      (outcome) => outcome.confirmedImports
    );

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
      ...(confirmedImports.length ? { confirmedImports } : {}),
    };
  }

  private readonly toPublicItem = ({
    queueRecordId,
    ...item
  }: InternalDownloadingItem): DownloadingItem => {
    void queueRecordId;
    return item;
  };

  private getProgress(
    activeItems: InternalDownloadingItem[] | undefined,
    finalizingItems: InternalDownloadingItem[] | undefined,
    externalServiceId: number
  ): DownloadingItem[] {
    const active = (activeItems ?? []).filter(
      (item) => item.externalId === externalServiceId
    );
    return (active.length ? active : (finalizingItems ?? []))
      .filter((item) => item.externalId === externalServiceId)
      .map(this.toPublicItem);
  }

  private physicalServerKey(server: {
    hostname: string;
    port: number;
    baseUrl?: string;
    useSsl: boolean;
  }): string {
    return `${server.useSsl ? 'https' : 'http'}://${server.hostname}:${
      server.port
    }${server.baseUrl ?? ''}`;
  }

  private buildDownloadingItem(
    item: QueueItem,
    mediaType: MediaType,
    externalId: number,
    episode: EpisodeNumberResult | undefined,
    previous: InternalDownloadingItem[]
  ): InternalDownloadingItem {
    const derived = deriveAcquisitionState({
      status: item.status,
      trackedDownloadStatus: item.trackedDownloadStatus,
      trackedDownloadState: item.trackedDownloadState,
      sizeLeft: item.sizeleft,
      statusMessages: item.statusMessages,
      errorMessage: item.errorMessage,
    });
    const prior = previous.find(
      (candidate) =>
        candidate.downloadId === item.downloadId &&
        candidate.mediaType === mediaType &&
        candidate.externalId === externalId &&
        candidate.episode?.id === episode?.id
    );
    const acquisitionPhaseStartedAt =
      prior?.acquisitionPhase === derived.acquisitionPhase
        ? prior.acquisitionPhaseStartedAt
        : new Date(this.now()).toISOString();
    const transferring = derived.acquisitionPhase === 'downloading';

    if (prior && prior.acquisitionPhase !== derived.acquisitionPhase) {
      logger.info('Acquisition phase changed', {
        label: 'Download Tracker',
        mediaType,
        externalId,
        previousPhase: prior.acquisitionPhase,
        phase: derived.acquisitionPhase,
        phaseStartedAt: acquisitionPhaseStartedAt,
        health: derived.health,
        safeReason: derived.safeReason,
      });
    }

    return {
      externalId,
      estimatedCompletionTime:
        transferring && item.estimatedCompletionTime
          ? new Date(item.estimatedCompletionTime)
          : undefined,
      mediaType,
      size: item.size,
      sizeLeft: item.sizeleft,
      status: item.status,
      trackedDownloadStatus: item.trackedDownloadStatus,
      trackedDownloadState: item.trackedDownloadState,
      trackedStatus: item.trackedDownloadStatus,
      acquisitionPhase: derived.acquisitionPhase,
      acquisitionPhaseStartedAt,
      health: derived.health,
      safeReason: derived.safeReason,
      timeLeft: transferring ? item.timeleft : '',
      title: item.title,
      episode,
      downloadId: item.downloadId,
      queueRecordId: item.id,
    };
  }

  private async confirmDisappearedImports(
    api: RadarrAPI | SonarrAPI,
    previous: InternalDownloadingItem[],
    current: InternalDownloadingItem[],
    serverAliases: { id: number; is4k: boolean }[]
  ): Promise<ImportConfirmationResult> {
    const currentKeys = new Set(
      current.map((item) => this.downloadGenerationKey(item))
    );
    const disappeared = previous.filter(
      (item) => !currentKeys.has(this.downloadGenerationKey(item))
    );
    if (!disappeared.length) {
      return { confirmedImports: [], historyAuthoritative: true };
    }

    let history;
    try {
      history = await api.getRecentHistory();
    } catch (error) {
      logger.warn('Unable to reconcile disappeared downloads with history', {
        label: 'Download Tracker',
        provider: disappeared[0]?.mediaType,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return { confirmedImports: [], historyAuthoritative: false };
    }

    const importedDownloadIds = new Set(
      history
        .filter(
          (record) =>
            record.eventType.toLowerCase() === 'downloadfolderimported' &&
            record.downloadId
        )
        .map((record) => record.downloadId as string)
    );
    const grouped = new Map<string, ConfirmedServarrImport>();
    for (const item of disappeared) {
      if (!item.downloadId || !importedDownloadIds.has(item.downloadId)) {
        continue;
      }
      const key = `${item.mediaType}:${item.externalId}:${item.downloadId}`;
      const existing = grouped.get(key) ?? {
        mediaType: item.mediaType,
        externalId: item.externalId,
        downloadId: item.downloadId,
        serverAliases,
        episodes: [],
      };
      if (
        item.episode &&
        !existing.episodes.some((episode) => episode.id === item.episode?.id)
      ) {
        existing.episodes.push(item.episode);
      }
      grouped.set(key, existing);
    }
    if (grouped.size) {
      logger.info('Confirmed Servarr imports from bounded history', {
        label: 'Download Tracker',
        mediaType: disappeared[0]?.mediaType,
        disappeared: disappeared.length,
        confirmedImports: grouped.size,
      });
    }
    return {
      confirmedImports: [...grouped.values()],
      historyAuthoritative: true,
    };
  }

  private retainCorrelationState(
    previous: InternalDownloadingItem[],
    current: InternalDownloadingItem[]
  ): InternalDownloadingItem[] {
    const retained = new Map(
      previous.map((item) => [this.downloadGenerationKey(item), item])
    );
    for (const item of current) {
      retained.set(this.downloadGenerationKey(item), item);
    }
    return [...retained.values()];
  }

  private downloadGenerationKey(item: InternalDownloadingItem): string {
    return [
      item.mediaType,
      item.externalId,
      item.downloadId,
      item.episode?.id ?? '',
    ].join(':');
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
            const physicalKey = this.physicalServerKey(server);
            const previous = this.radarrPhysicalQueues[physicalKey] ?? [];
            const serverDownloads = queueItems.map((item) =>
              this.buildDownloadingItem(
                item,
                MediaType.MOVIE,
                item.movieId,
                undefined,
                previous
              )
            );
            const serverAliases = [server, ...matchingServers].map((alias) => ({
              id: alias.id,
              is4k: Boolean(alias.is4k),
            }));
            const importConfirmation = await this.confirmDisappearedImports(
              radarr,
              previous,
              serverDownloads,
              serverAliases
            );
            this.radarrPhysicalQueues[physicalKey] =
              importConfirmation.historyAuthoritative
                ? serverDownloads
                : this.retainCorrelationState(previous, serverDownloads);

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
              confirmedImports: importConfirmation.confirmedImports,
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
              confirmedImports: [],
            };
          }
        }

        return {
          succeeded: false,
          queueCount: 0,
          changed: false,
          confirmedImports: [],
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
            const physicalKey = this.physicalServerKey(server);
            const previous = this.sonarrPhysicalQueues[physicalKey] ?? [];
            const serverDownloads = queueItems.map((item) =>
              this.buildDownloadingItem(
                item,
                MediaType.TV,
                item.seriesId,
                item.episode,
                previous
              )
            );
            const serverAliases = [server, ...matchingServers].map((alias) => ({
              id: alias.id,
              is4k: Boolean(alias.is4k),
            }));
            const importConfirmation = await this.confirmDisappearedImports(
              sonarr,
              previous,
              serverDownloads,
              serverAliases
            );
            this.sonarrPhysicalQueues[physicalKey] =
              importConfirmation.historyAuthoritative
                ? serverDownloads
                : this.retainCorrelationState(previous, serverDownloads);

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
              confirmedImports: importConfirmation.confirmedImports,
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
              confirmedImports: [],
            };
          }
        }

        return {
          succeeded: false,
          queueCount: 0,
          changed: false,
          confirmedImports: [],
        };
      })
    );
  }
}

const downloadTracker = new DownloadTracker();

export default downloadTracker;
