import {
  DEFAULT_DOWNLOAD_QUEUE_SIZE,
  MAX_DOWNLOAD_QUEUE_SIZE,
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
import { randomUUID } from 'crypto';
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
  historyImportedAt?: string;
  ambiguousHistory?: boolean;
  historyEventId?: number;
  observationId?: string;
  providerKey?: string;
  queueRecordId: number;
  firstObservedAt: number;
  disappearedAt?: number;
}

// Process-local observation identity is a fence, not proof of import. Only a
// provider history event supplies import authority. Never expose this on cards.
export interface ServarrImportEvidence {
  ambiguous?: boolean;
  observationId: string;
  providerKey: string;
  queueRecordId: number;
  historyEventId: number;
  importedAt: string;
  episodeId?: number;
  historyEpisodeId?: number;
}

export const importEvidenceKey = (evidence: ServarrImportEvidence): string =>
  JSON.stringify([
    evidence.providerKey,
    evidence.observationId,
    evidence.queueRecordId,
    evidence.historyEventId,
    evidence.importedAt,
    evidence.episodeId,
    evidence.historyEpisodeId,
  ]);

export interface ConfirmedServarrImport {
  evidence?: ServarrImportEvidence[];
  mediaType: MediaType;
  externalId: number;
  downloadId: string;
  serverAliases: { id: number; is4k: boolean }[];
  episodes: EpisodeNumberResult[];
}

export interface FinalizingAcquisitionTarget {
  evidence?: ServarrImportEvidence[];
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
  retainedUnmatched: InternalDownloadingItem[];
}

interface DownloadTrackerOptions {
  now?: () => number;
}

// Recent-history records can trail queue removal briefly. Keep only the
// correlation facts needed to confirm that disappearance, and expire them so
// an old download can never be mistaken for a later import.
export const IMPORT_CONFIRMATION_WINDOW_MS = 2 * 60_000;
export const MAX_IMPORT_CONFIRMATION_BACKLOG = MAX_DOWNLOAD_QUEUE_SIZE;

export class DownloadTracker {
  private readonly latestObservations = new Map<
    string,
    { observationId: string; historyEventId?: number }
  >();
  private readonly acknowledgedImports = new Set<string>();
  private radarrServers: Record<number, InternalDownloadingItem[]> = {};
  private sonarrServers: Record<number, InternalDownloadingItem[]> = {};
  private finalizingRadarrServers: Record<number, InternalDownloadingItem[]> =
    {};
  private finalizingSonarrServers: Record<number, InternalDownloadingItem[]> =
    {};
  private updatePromise?: Promise<DownloadTrackerUpdateOutcome>;
  private radarrPhysicalQueues: Record<string, InternalDownloadingItem[]> = {};
  private sonarrPhysicalQueues: Record<string, InternalDownloadingItem[]> = {};
  private radarrImportBacklogs: Record<string, InternalDownloadingItem[]> = {};
  private sonarrImportBacklogs: Record<string, InternalDownloadingItem[]> = {};
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
      externalServiceId,
      serverId,
      Boolean(
        getSettings().radarr.find((server) => server.id === serverId)?.is4k
      )
    );
  }

  public getSeriesProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    return this.getProgress(
      this.sonarrServers[serverId],
      this.finalizingSonarrServers[serverId],
      externalServiceId,
      serverId,
      Boolean(
        getSettings().sonarr.find((server) => server.id === serverId)?.is4k
      )
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
        item.downloadId !== target.downloadId ||
        (!!target.evidence?.length &&
          !target.evidence.some(
            (proof) => proof.observationId === item.observationId
          ))
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
        observationId: target.evidence?.find(
          (proof) => proof.episodeId === episode?.id
        )?.observationId,
        historyEventId: target.evidence?.find(
          (proof) => proof.episodeId === episode?.id
        )?.historyEventId,
        queueRecordId: -(index + 1),
        firstObservedAt: this.now(),
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
        item.downloadId !== target.downloadId ||
        (!!target.evidence?.length &&
          !target.evidence.some(
            (proof) => proof.observationId === item.observationId
          ))
    );
  }

  public isCurrentFinalizingTarget(
    target: FinalizingAcquisitionTarget
  ): boolean {
    return (
      !target.evidence?.length ||
      target.evidence.every(
        (proof) =>
          !proof.ambiguous &&
          this.latestObservations.get(
            this.observationScope(
              proof.providerKey,
              target.mediaType,
              target.externalId,
              proof.episodeId
            )
          )?.observationId === proof.observationId &&
          this.latestObservations.get(
            this.observationScope(
              proof.providerKey,
              target.mediaType,
              target.externalId,
              proof.episodeId
            )
          )?.historyEventId === proof.historyEventId
      )
    );
  }

  public acknowledgeImport(target: FinalizingAcquisitionTarget): void {
    if (!target.evidence?.length || !this.isCurrentFinalizingTarget(target))
      return;
    for (const proof of target.evidence) {
      if (
        !Number.isSafeInteger(proof.historyEventId) ||
        proof.historyEventId < 1 ||
        !Number.isFinite(Date.parse(proof.importedAt))
      )
        continue;
      if (
        target.mediaType === MediaType.TV &&
        (!Number.isSafeInteger(proof.episodeId) ||
          (proof.episodeId ?? 0) < 1 ||
          proof.historyEpisodeId !== proof.episodeId)
      )
        continue;
      this.acknowledgedImports.add(
        JSON.stringify([
          target.serverId,
          target.is4k,
          proof.observationId,
          proof.historyEventId,
        ])
      );
    }
    while (this.acknowledgedImports.size > MAX_IMPORT_CONFIRMATION_BACKLOG) {
      const oldest = this.acknowledgedImports.values().next().value;
      if (oldest) this.acknowledgedImports.delete(oldest);
    }
  }

  private observationScope(
    provider: string,
    type: MediaType,
    externalId: number,
    episodeId?: number
  ): string {
    return JSON.stringify([provider, type, externalId, episodeId]);
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.sonarrServers = {};
    this.radarrPhysicalQueues = {};
    this.sonarrPhysicalQueues = {};
    this.radarrImportBacklogs = {};
    this.sonarrImportBacklogs = {};
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
    historyImportedAt,
    ambiguousHistory,
    historyEventId,
    observationId,
    providerKey,
    queueRecordId,
    firstObservedAt,
    disappearedAt,
    ...item
  }: InternalDownloadingItem): DownloadingItem => {
    void queueRecordId;
    void firstObservedAt;
    void disappearedAt;
    void observationId;
    void providerKey;
    void historyEventId;
    void historyImportedAt;
    void ambiguousHistory;
    return item;
  };

  private getProgress(
    activeItems: InternalDownloadingItem[] | undefined,
    finalizingItems: InternalDownloadingItem[] | undefined,
    externalServiceId: number,
    serverId: number,
    is4k: boolean
  ): DownloadingItem[] {
    const active = (activeItems ?? []).filter(
      (item) => item.externalId === externalServiceId
    );
    return (active.length ? active : (finalizingItems ?? []))
      .filter((item) => item.externalId === externalServiceId)
      .filter(
        (item) =>
          !item.observationId ||
          item.acquisitionPhase !== AcquisitionPhase.FINALIZING ||
          item.trackedDownloadState !== 'imported' ||
          item.trackedDownloadStatus !== 'ok' ||
          item.status !== 'completed' ||
          item.health !== 'ok' ||
          !this.acknowledgedImports.has(
            JSON.stringify([
              serverId,
              is4k,
              item.observationId,
              item.historyEventId,
            ])
          )
      )
      .map(this.toPublicItem);
  }

  private hasPresentationChanged(
    previous: InternalDownloadingItem[],
    current: InternalDownloadingItem[]
  ): boolean {
    return !isEqual(
      previous.map(this.toPublicItem),
      current.map(this.toPublicItem)
    );
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
    previous: InternalDownloadingItem[],
    providerKey: string
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
        candidate.disappearedAt === undefined &&
        candidate.downloadId === item.downloadId &&
        candidate.queueRecordId === item.id &&
        candidate.mediaType === mediaType &&
        candidate.externalId === externalId &&
        candidate.episode?.id === episode?.id
    );
    const acquisitionPhaseStartedAt =
      prior?.acquisitionPhase === derived.acquisitionPhase
        ? prior.acquisitionPhaseStartedAt
        : new Date(this.now()).toISOString();
    const transferring = derived.acquisitionPhase === 'downloading';
    const observationId =
      prior?.trackedDownloadState === 'imported' &&
      item.trackedDownloadState !== 'imported'
        ? randomUUID()
        : (prior?.observationId ?? randomUUID());
    const scope = this.observationScope(
      providerKey,
      mediaType,
      externalId,
      episode?.id
    );
    this.latestObservations.delete(scope);
    const historyEventId =
      prior?.observationId === observationId ? prior.historyEventId : undefined;
    this.latestObservations.set(scope, { observationId, historyEventId });
    while (this.latestObservations.size > MAX_IMPORT_CONFIRMATION_BACKLOG) {
      const oldest = this.latestObservations.keys().next().value;
      if (oldest) this.latestObservations.delete(oldest);
    }

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
      observationId,
      providerKey,
      historyEventId,
      historyImportedAt:
        prior?.observationId === observationId
          ? prior.historyImportedAt
          : undefined,
      ambiguousHistory:
        prior?.observationId === observationId
          ? prior.ambiguousHistory
          : undefined,
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
      firstObservedAt:
        prior?.observationId === observationId
          ? prior.firstObservedAt
          : this.now(),
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
      return {
        confirmedImports: [],
        retainedUnmatched: [],
      };
    }

    const observedAt = this.now();
    const confirmable = disappeared.flatMap((item) => {
      const disappearedAt = item.disappearedAt ?? observedAt;
      return observedAt - disappearedAt < IMPORT_CONFIRMATION_WINDOW_MS
        ? [{ ...item, disappearedAt }]
        : [];
    });
    if (!confirmable.length) {
      return {
        confirmedImports: [],
        retainedUnmatched: [],
      };
    }

    let history;
    try {
      history = await api.getRecentHistory();
    } catch (error) {
      logger.warn('Unable to reconcile disappeared downloads with history', {
        label: 'Download Tracker',
        provider: confirmable[0]?.mediaType,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      return {
        confirmedImports: [],
        retainedUnmatched: confirmable,
      };
    }

    const imported = history.filter(
      (record) =>
        record.eventType.toLowerCase() === 'downloadfolderimported' &&
        record.downloadId
    );
    const grouped = new Map<string, ConfirmedServarrImport>();
    const retainedUnmatched: InternalDownloadingItem[] = [];
    // Reuse this already-required history page for imported pack rows still in
    // the queue. Do not introduce history reads when nothing disappeared.
    const candidates = [
      ...confirmable,
      ...current.filter(
        (item) => item.acquisitionPhase === AcquisitionPhase.FINALIZING
      ),
    ];
    for (const item of candidates) {
      const matchingRecord = imported.find((record) => {
        if (record.downloadId !== item.downloadId) return false;
        const providerMediaId =
          item.mediaType === MediaType.MOVIE ? record.movieId : record.seriesId;
        if (providerMediaId !== item.externalId) return false;
        if (
          item.episode &&
          record.episodeId !== undefined &&
          record.episodeId !== item.episode.id
        )
          return false;
        const importedAt = Date.parse(record.date);
        return (
          Number.isFinite(importedAt) &&
          importedAt >= item.firstObservedAt &&
          importedAt <= observedAt
        );
      });
      if (!item.downloadId || !matchingRecord) {
        retainedUnmatched.push(item);
        continue;
      }
      const key = `${item.mediaType}:${item.externalId}:${item.downloadId}`;
      const existing = grouped.get(key) ?? {
        mediaType: item.mediaType,
        externalId: item.externalId,
        downloadId: item.downloadId,
        serverAliases,
        episodes: [],
        evidence: [],
      };
      if (item.observationId && item.providerKey) {
        const previousObservation = item.observationId;
        if (
          item.historyEventId !== undefined &&
          item.historyEventId !== matchingRecord.id
        ) {
          // A different provider event fences all old completions. Reordered
          // or equal-time conflicting history is ambiguous, never authority.
          item.ambiguousHistory = !(
            Date.parse(matchingRecord.date) >
            Date.parse(item.historyImportedAt ?? '')
          );
          item.observationId = randomUUID();
        }
        item.historyEventId = matchingRecord.id;
        item.historyImportedAt = matchingRecord.date;
        const current = this.latestObservations.get(
          this.observationScope(
            item.providerKey,
            item.mediaType,
            item.externalId,
            item.episode?.id
          )
        );
        if (current?.observationId === previousObservation) {
          current.observationId = item.observationId;
          current.historyEventId = matchingRecord.id;
        }
        const proof: ServarrImportEvidence = {
          observationId: item.observationId,
          providerKey: item.providerKey,
          queueRecordId: item.queueRecordId,
          historyEventId: matchingRecord.id,
          importedAt: matchingRecord.date,
          episodeId: item.episode?.id,
          historyEpisodeId: matchingRecord.episodeId,
          ...(item.ambiguousHistory && { ambiguous: true }),
        };
        const evidence = (existing.evidence ??= []);
        if (
          !evidence.some(
            (entry) => importEvidenceKey(entry) === importEvidenceKey(proof)
          )
        )
          evidence.push(proof);
      }
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
      retainedUnmatched,
    };
  }

  private downloadGenerationKey(item: InternalDownloadingItem): string {
    return [
      item.mediaType,
      item.externalId,
      item.downloadId,
      item.episode?.id ?? '',
    ].join(':');
  }

  private boundImportBacklog(
    items: InternalDownloadingItem[]
  ): InternalDownloadingItem[] {
    const unique = new Map<string, InternalDownloadingItem>();
    for (const item of items)
      unique.set(this.downloadGenerationKey(item), item);
    return [...unique.values()]
      .sort(
        (left, right) => (right.disappearedAt ?? 0) - (left.disappearedAt ?? 0)
      )
      .slice(0, MAX_IMPORT_CONFIRMATION_BACKLOG);
  }

  private async updateRadarrDownloads(): Promise<ProviderRefreshOutcome[]> {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(
      settings.radarr.filter((radarr) => radarr.syncEnabled),
      (radarrA, radarrB) => {
        return (
          this.physicalServerKey(radarrA) === this.physicalServerKey(radarrB)
        );
      }
    );

    // Load downloads from Radarr servers
    return Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const matchingServers = settings.radarr.filter(
            (rs) =>
              this.physicalServerKey(rs) === this.physicalServerKey(server) &&
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
            const previousActive = this.radarrPhysicalQueues[physicalKey] ?? [];
            const previous = [
              ...previousActive,
              ...(this.radarrImportBacklogs[physicalKey] ?? []),
            ];
            const serverDownloads = queueItems.map((item) =>
              this.buildDownloadingItem(
                item,
                MediaType.MOVIE,
                item.movieId,
                undefined,
                previousActive,
                physicalKey
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
            this.radarrPhysicalQueues[physicalKey] = serverDownloads;
            this.radarrImportBacklogs[physicalKey] = this.boundImportBacklog(
              importConfirmation.retainedUnmatched
            );

            const downloads = serverDownloads.slice(
              0,
              validateDownloadQueueSize(
                server.downloadQueueSize ?? DEFAULT_DOWNLOAD_QUEUE_SIZE
              )
            );
            let changed = this.hasPresentationChanged(
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
                this.hasPresentationChanged(
                  this.radarrServers[ms.id] ?? [],
                  matchingDownloads
                ) || changed;
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
          this.physicalServerKey(sonarrA) === this.physicalServerKey(sonarrB)
        );
      }
    );

    // Load downloads from Sonarr servers
    return Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const matchingServers = settings.sonarr.filter(
            (ss) =>
              this.physicalServerKey(ss) === this.physicalServerKey(server) &&
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
            const previousActive = this.sonarrPhysicalQueues[physicalKey] ?? [];
            const previous = [
              ...previousActive,
              ...(this.sonarrImportBacklogs[physicalKey] ?? []),
            ];
            const serverDownloads = queueItems.map((item) =>
              this.buildDownloadingItem(
                item,
                MediaType.TV,
                item.seriesId,
                item.episode,
                previousActive,
                physicalKey
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
            this.sonarrPhysicalQueues[physicalKey] = serverDownloads;
            this.sonarrImportBacklogs[physicalKey] = this.boundImportBacklog(
              importConfirmation.retainedUnmatched
            );

            const downloads = serverDownloads.slice(
              0,
              validateDownloadQueueSize(
                server.downloadQueueSize ?? DEFAULT_DOWNLOAD_QUEUE_SIZE
              )
            );
            let changed = this.hasPresentationChanged(
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
                this.hasPresentationChanged(
                  this.sonarrServers[ms.id] ?? [],
                  matchingDownloads
                ) || changed;
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
