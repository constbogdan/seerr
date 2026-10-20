import SonarrAPI, {
  seriesDestinationPath,
  type SonarrEpisodeFile,
  type SonarrHistoryRecord,
  type SonarrQueueItem,
  type SonarrSeries,
  type SonarrSeriesMoveCommand,
} from '@server/api/servarr/sonarr';
import { MediaRequestStatus } from '@server/constants/media';
import { resolveOverflowRoot } from '@server/constants/overflow';
import { RemovalScheduleStatus } from '@server/constants/removal';
import {
  ACTIVE_SERIES_RELOCATION_STATES,
  SeriesRelocationState,
  type SeriesRelocationOutcome,
  type SeriesRelocationReason,
} from '@server/constants/seriesRelocation';
import dataSource from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RemovalExecutionClaim } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import { SeriesRelocationExecution } from '@server/entity/SeriesRelocationExecution';
import {
  getSettings,
  type AllSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import {
  discoverStorageLocations,
  validateSeriesPlacementVolumes,
  type PhysicalVolume,
  type StorageDiscoveryResult,
  type StorageLocation,
} from '@server/lib/storageSettings';
import logger from '@server/logger';
import { randomUUID } from 'crypto';
import { In, IsNull, Not, type DataSource, type EntityManager } from 'typeorm';

const ACTIVE_REQUEST_STATUSES = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
];
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 2 * 60 * 60_000;

const normalizedPath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const validDate = (value: string | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const historyValue = (
  data: Record<string, string | undefined>,
  name: string
): string | undefined => {
  const entry = Object.entries(data).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return entry?.[1];
};

export type SeriesDownloadOrigin = 'qbittorrent' | 'sabnzbd';

export interface SeriesFileImportFact {
  episodeFileId: number;
  origin: SeriesDownloadOrigin;
  importedAt: Date;
}

export type SeriesImportResolution =
  | { complete: true; imports: SeriesFileImportFact[] }
  | {
      complete: false;
      reason: 'incomplete-history' | 'unknown-download-client';
    };

export const resolveCurrentSeriesImports = (
  files: Pick<SonarrEpisodeFile, 'id'>[],
  history: SonarrHistoryRecord[]
): SeriesImportResolution => {
  const imported = history
    .filter(
      (record) => record.eventType.toLowerCase() === 'downloadfolderimported'
    )
    .sort(
      (left, right) =>
        (validDate(right.date)?.getTime() ?? 0) -
        (validDate(left.date)?.getTime() ?? 0)
    );
  const imports: SeriesFileImportFact[] = [];
  for (const file of files) {
    const record = imported.find(
      (candidate) => Number(historyValue(candidate.data, 'FileId')) === file.id
    );
    const importedAt = validDate(record?.date);
    if (!record || !importedAt) {
      return { complete: false, reason: 'incomplete-history' };
    }
    const client = historyValue(record.data, 'DownloadClient')
      ?.trim()
      .toLowerCase();
    const origin = client?.includes('qbittorrent')
      ? 'qbittorrent'
      : client?.includes('sabnzbd')
        ? 'sabnzbd'
        : null;
    if (!origin) {
      return { complete: false, reason: 'unknown-download-client' };
    }
    imports.push({ episodeFileId: file.id, origin, importedAt });
  }
  return { complete: true, imports };
};

export interface SeriesRelocationFacts {
  now: Date;
  threshold: number;
  torrentDelayHours: number;
  files: SonarrEpisodeFile[];
  foundationFiles: {
    sourceFileId: string;
    sizeBytes?: string | null;
  }[];
  queue: SonarrQueueItem[];
  history: SonarrHistoryRecord[];
  pendingRequest: boolean;
  removalConflict: boolean;
  activeRelocation: boolean;
  destinationVolume: PhysicalVolume | null;
}

export interface SeriesRelocationEligibility {
  eligible: boolean;
  reason: SeriesRelocationReason;
  retainedSeasons: number[];
  totalBytes: string;
  latestTorrentImportAt: Date | null;
}

const ineligible = (
  reason: SeriesRelocationReason,
  retainedSeasons: number[] = [],
  totalBytes = '0',
  latestTorrentImportAt: Date | null = null
): SeriesRelocationEligibility => ({
  eligible: false,
  reason,
  retainedSeasons,
  totalBytes,
  latestTorrentImportAt,
});

export const evaluateSeriesRelocationFacts = (
  facts: SeriesRelocationFacts
): SeriesRelocationEligibility => {
  const retainedSeasons = [
    ...new Set(
      facts.files
        .map((file) => file.seasonNumber)
        .filter((season) => Number.isSafeInteger(season) && season > 0)
    ),
  ].sort((left, right) => left - right);
  if (retainedSeasons.length < facts.threshold) {
    return ineligible('below-season-threshold', retainedSeasons);
  }
  if (facts.activeRelocation) {
    return ineligible('already-relocating', retainedSeasons);
  }
  if (facts.queue.length > 0) {
    return ineligible('active-acquisition', retainedSeasons);
  }
  if (facts.pendingRequest) {
    return ineligible('pending-request', retainedSeasons);
  }
  if (facts.removalConflict) {
    return ineligible('removal-conflict', retainedSeasons);
  }
  const validFiles = facts.files.every(
    (file) =>
      Number.isSafeInteger(file.id) &&
      file.id > 0 &&
      Number.isSafeInteger(file.size) &&
      file.size >= 0 &&
      Number.isSafeInteger(file.seasonNumber)
  );
  if (!validFiles || facts.files.length === 0) {
    return ineligible('foundation-mismatch', retainedSeasons);
  }
  const live = new Map(
    facts.files.map((file) => [`episode-file:${file.id}`, BigInt(file.size)])
  );
  const foundation = new Map(
    facts.foundationFiles.map((file) => [
      file.sourceFileId,
      file.sizeBytes == null ? null : BigInt(file.sizeBytes),
    ])
  );
  const foundationMatches =
    live.size === foundation.size &&
    [...live].every(
      ([id, size]) => foundation.has(id) && foundation.get(id) === size
    );
  if (!foundationMatches) {
    return ineligible('foundation-mismatch', retainedSeasons);
  }
  const totalBytes = [...live.values()]
    .reduce((total, size) => total + size, 0n)
    .toString();
  const imports = resolveCurrentSeriesImports(facts.files, facts.history);
  if (!imports.complete) {
    return ineligible(imports.reason, retainedSeasons, totalBytes);
  }
  const torrentImports = imports.imports.filter(
    (item) => item.origin === 'qbittorrent'
  );
  const latestTorrentImportAt = torrentImports.length
    ? new Date(
        Math.max(...torrentImports.map((item) => item.importedAt.getTime()))
      )
    : null;
  if (
    latestTorrentImportAt &&
    facts.now.getTime() - latestTorrentImportAt.getTime() <
      facts.torrentDelayHours * 60 * 60_000
  ) {
    return ineligible(
      'torrent-cooldown',
      retainedSeasons,
      totalBytes,
      latestTorrentImportAt
    );
  }
  const destination = facts.destinationVolume;
  if (
    !destination ||
    !destination.accessible ||
    destination.capacityReadingsDiffer ||
    destination.totalSpace === null ||
    destination.freeSpace === null
  ) {
    return ineligible(
      'destination-capacity-unavailable',
      retainedSeasons,
      totalBytes,
      latestTorrentImportAt
    );
  }
  if (BigInt(destination.freeSpace) < BigInt(totalBytes)) {
    return ineligible(
      'insufficient-capacity',
      retainedSeasons,
      totalBytes,
      latestTorrentImportAt
    );
  }
  return {
    eligible: true,
    reason: 'eligible',
    retainedSeasons,
    totalBytes,
    latestTorrentImportAt,
  };
};

interface RelocationCandidate {
  canonicalMediaId: number;
  presence: LibraryPresence;
  sourceRoot: StorageRoot;
  sourceLocation: StorageLocation;
  destinationLocation: StorageLocation;
  destinationVolume: PhysicalVolume;
  server: SonarrSettings;
  series: SonarrSeries;
  files: SonarrEpisodeFile[];
  eligibility: SeriesRelocationEligibility;
}

export interface SeriesRelocationPreviewCandidate {
  canonicalMediaId: number;
  title: string;
  year: number | null;
  retainedSeasonCount: number;
  totalBytes: string;
  sonarrUrl: string | null;
}

export type SeriesRelocationPreviewUnavailableReason =
  | 'configuration-incomplete'
  | 'provider-unavailable'
  | 'incomplete-evidence';

export interface SeriesRelocationPreviewResult {
  status: 'eligible' | 'none' | 'unavailable';
  candidate: SeriesRelocationPreviewCandidate | null;
  reason: SeriesRelocationPreviewUnavailableReason | null;
}

const INDETERMINATE_PREVIEW_REASONS = new Set<SeriesRelocationReason>([
  'provider-error',
  'destination-capacity-unavailable',
  'root-resolution-failed',
  'foundation-mismatch',
  'incomplete-history',
  'unknown-download-client',
]);

export const resolveSonarrSeriesUrl = (
  server: SonarrSettings,
  series: Pick<SonarrSeries, 'titleSlug'>
): string | null => {
  const titleSlug = series.titleSlug?.trim();
  if (!titleSlug) return null;

  try {
    const baseUrl =
      server.externalUrl?.trim() || SonarrAPI.buildUrl(server, '');
    const url = new URL(baseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/series/${encodeURIComponent(
      titleSlug
    )}`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

export interface SeriesRelocationResult {
  canonicalMediaId: number;
  outcome: SeriesRelocationOutcome;
  reason: SeriesRelocationReason;
  executionId?: string;
}

export interface SeriesRelocationRunResult {
  startedAt: string;
  completedAt: string;
  eligible: number;
  moved: number;
  skipped: number;
  blocked: number;
  failed: number;
  needsReconciliation: number;
  results: SeriesRelocationResult[];
}

export type SeriesMoveSnapshot = Pick<
  SeriesRelocationExecution,
  | 'destinationPath'
  | 'expectedEpisodeFileIds'
  | 'expectedFileCount'
  | 'expectedBytes'
>;

export const verifySeriesMoveSnapshot = (
  series: Pick<SonarrSeries, 'path' | 'pendingPath'>,
  files: Pick<SonarrEpisodeFile, 'id' | 'path' | 'size'>[],
  snapshot: SeriesMoveSnapshot
): boolean => {
  const fileIds = files
    .map((file) => file.id)
    .sort((left, right) => left - right);
  const bytes = files.reduce((total, file) => total + BigInt(file.size), 0n);
  const destination = normalizedPath(snapshot.destinationPath);
  const destinationPrefix = `${destination}/`;
  const pathsVerified = files.every(
    (file) =>
      Boolean(file.path) &&
      (normalizedPath(file.path!).startsWith(destinationPrefix) ||
        normalizedPath(file.path!) === destination)
  );
  return (
    normalizedPath(series.path) === destination &&
    !series.pendingPath?.trim() &&
    fileIds.length === snapshot.expectedFileCount &&
    fileIds.every(
      (id, index) => id === snapshot.expectedEpisodeFileIds[index]
    ) &&
    bytes === BigInt(snapshot.expectedBytes) &&
    pathsVerified
  );
};

export type SeriesMoveReconciliationOutcome =
  | 'completed'
  | 'pending'
  | 'ambiguous';

export interface SeriesMoveReconciliation {
  outcome: SeriesMoveReconciliationOutcome;
  reason: string;
}

const ACTIVE_MOVE_COMMAND_STATES = new Set(['queued', 'started']);

export const reconcileSeriesMoveSnapshot = (
  series: Pick<SonarrSeries, 'path' | 'pendingPath'>,
  files: Pick<SonarrEpisodeFile, 'id' | 'path' | 'size'>[],
  commands: SonarrSeriesMoveCommand[],
  snapshot: SeriesMoveSnapshot
): SeriesMoveReconciliation => {
  const destination = normalizedPath(snapshot.destinationPath);
  const activeCommands = commands.filter((command) =>
    ACTIVE_MOVE_COMMAND_STATES.has(command.status)
  );
  const destinationFor = (command: SonarrSeriesMoveCommand) => {
    const path = command.body?.destinationPath;
    return typeof path === 'string' && path.trim()
      ? normalizedPath(path)
      : null;
  };
  const matchingActive = activeCommands.some(
    (command) => destinationFor(command) === destination
  );
  const conflictingActive = activeCommands.some(
    (command) => destinationFor(command) !== destination
  );
  const pendingPath = series.pendingPath?.trim()
    ? normalizedPath(series.pendingPath)
    : null;

  if (!conflictingActive && verifySeriesMoveSnapshot(series, files, snapshot)) {
    return {
      outcome: 'completed',
      reason:
        'Sonarr reports the expected destination and EpisodeFile fingerprint.',
    };
  }
  if (!conflictingActive && (matchingActive || pendingPath === destination)) {
    return {
      outcome: 'pending',
      reason: matchingActive
        ? 'Sonarr reports the matching Series move as queued or running.'
        : 'Sonarr reports the expected destination as pending.',
    };
  }
  if (conflictingActive) {
    return {
      outcome: 'ambiguous',
      reason: 'Sonarr reports a conflicting active Series move.',
    };
  }
  if (pendingPath && pendingPath !== destination) {
    return {
      outcome: 'ambiguous',
      reason: 'Sonarr reports a conflicting pending Series path.',
    };
  }
  if (
    commands.some(
      (command) =>
        command.status === 'orphaned' && destinationFor(command) === destination
    )
  ) {
    return {
      outcome: 'ambiguous',
      reason: 'Sonarr reports the matching Series move command as orphaned.',
    };
  }
  return {
    outcome: 'ambiguous',
    reason:
      'Sonarr does not provide conclusive evidence that the possibly submitted move completed or remained safely at its source.',
  };
};

export interface SeriesRelocationDependencies {
  connection: DataSource;
  settings: () => AllSettings;
  discover: (settings: AllSettings) => Promise<StorageDiscoveryResult>;
  createSonarr: (server: SonarrSettings) => SonarrAPI;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
  verificationTimeoutMs: number;
}

const defaultDependencies: SeriesRelocationDependencies = {
  connection: dataSource,
  settings: getSettings,
  discover: discoverStorageLocations,
  createSonarr: (server) =>
    new SonarrAPI({
      url: SonarrAPI.buildUrl(server, '/api/v3'),
      apiKey: server.apiKey,
    }),
  now: () => new Date(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  verificationTimeoutMs: DEFAULT_VERIFICATION_TIMEOUT_MS,
};

export class SeriesRelocationService {
  private runPromise?: Promise<SeriesRelocationRunResult>;
  private lastResult?: SeriesRelocationRunResult;

  constructor(
    private readonly dependencies: SeriesRelocationDependencies = defaultDependencies
  ) {}

  public running(): boolean {
    return Boolean(this.runPromise);
  }

  public status(): SeriesRelocationRunResult | undefined {
    return this.lastResult;
  }

  public run(limit = 1): Promise<SeriesRelocationRunResult> {
    if (this.runPromise) return this.runPromise;
    const promise = this.executeRun(Math.min(1, Math.max(0, limit))).finally(
      () => {
        if (this.runPromise === promise) this.runPromise = undefined;
      }
    );
    this.runPromise = promise;
    return promise;
  }

  public async previewNextCandidate(): Promise<SeriesRelocationPreviewResult> {
    const settings = this.dependencies.settings();
    if (
      !settings.overflow.defaultSeriesVolumeId ||
      !settings.overflow.expansionSeriesVolumeId ||
      settings.overflow.defaultSeriesVolumeId ===
        settings.overflow.expansionSeriesVolumeId
    ) {
      return {
        status: 'unavailable',
        candidate: null,
        reason: 'configuration-incomplete',
      };
    }

    let discovery: StorageDiscoveryResult;
    try {
      discovery = await this.dependencies.discover(settings);
    } catch {
      return {
        status: 'unavailable',
        candidate: null,
        reason: 'provider-unavailable',
      };
    }
    const configuration = validateSeriesPlacementVolumes(
      settings.overflow,
      discovery,
      true
    );
    if (!configuration.valid) {
      return {
        status: 'unavailable',
        candidate: null,
        reason:
          configuration.status === 503
            ? 'provider-unavailable'
            : 'configuration-incomplete',
      };
    }

    let incompleteEvidence = false;
    try {
      const presences = await this.loadDefaultVolumePresences(
        settings,
        discovery
      );
      for (const presence of presences) {
        let candidate: RelocationCandidate;
        try {
          candidate = await this.evaluatePresence(
            presence,
            settings,
            discovery
          );
        } catch (error) {
          incompleteEvidence = true;
          logger.warn('Series relocation preview evaluation failed closed', {
            label: 'Series Relocation',
            canonicalMediaId: presence.canonicalMediaId,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        if (candidate.eligibility.eligible) {
          const title = candidate.series.title?.trim();
          if (!title) {
            incompleteEvidence = true;
            continue;
          }
          return {
            status: 'eligible',
            candidate: {
              canonicalMediaId: candidate.canonicalMediaId,
              title,
              year: Number.isSafeInteger(candidate.series.year)
                ? candidate.series.year
                : null,
              retainedSeasonCount: candidate.eligibility.retainedSeasons.length,
              totalBytes: candidate.eligibility.totalBytes,
              sonarrUrl: resolveSonarrSeriesUrl(
                candidate.server,
                candidate.series
              ),
            },
            reason: null,
          };
        }
        if (INDETERMINATE_PREVIEW_REASONS.has(candidate.eligibility.reason)) {
          incompleteEvidence = true;
        }
      }
    } catch (error) {
      logger.warn('Series relocation preview scan failed closed', {
        label: 'Series Relocation',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'unavailable',
        candidate: null,
        reason: 'incomplete-evidence',
      };
    }

    return incompleteEvidence
      ? {
          status: 'unavailable',
          candidate: null,
          reason: 'incomplete-evidence',
        }
      : { status: 'none', candidate: null, reason: null };
  }

  private async executeRun(limit: number): Promise<SeriesRelocationRunResult> {
    const startedAt = this.dependencies.now();
    const settings = this.dependencies.settings();
    const results = await this.reconcileOutstanding();
    if (limit === 0) {
      const result = this.summarize(startedAt, results);
      this.lastResult = result;
      return result;
    }
    if (results.some((result) => result.outcome === 'needs_reconciliation')) {
      const result = this.summarize(startedAt, results);
      this.lastResult = result;
      return result;
    }
    if (
      !settings.overflow.defaultSeriesVolumeId ||
      !settings.overflow.expansionSeriesVolumeId ||
      settings.overflow.defaultSeriesVolumeId ===
        settings.overflow.expansionSeriesVolumeId
    ) {
      results.push({
        canonicalMediaId: 0,
        outcome: 'blocked',
        reason: 'configuration-incomplete',
      });
      const result = this.summarize(startedAt, results);
      this.lastResult = result;
      return result;
    }
    let discovery: StorageDiscoveryResult;
    try {
      discovery = await this.dependencies.discover(settings);
    } catch {
      results.push({
        canonicalMediaId: 0,
        outcome: 'blocked',
        reason: 'provider-error',
      });
      const result = this.summarize(startedAt, results);
      this.lastResult = result;
      return result;
    }
    const configuration = validateSeriesPlacementVolumes(
      settings.overflow,
      discovery,
      true
    );
    if (!configuration.valid) {
      results.push({
        canonicalMediaId: 0,
        outcome: 'blocked',
        reason: 'configuration-incomplete',
      });
      const result = this.summarize(startedAt, results);
      this.lastResult = result;
      return result;
    }
    const presences = await this.loadDefaultVolumePresences(
      settings,
      discovery
    );
    let moved = results.filter((result) => result.outcome === 'moved').length;
    for (const presence of presences) {
      let candidate: RelocationCandidate | null = null;
      try {
        candidate = await this.evaluatePresence(presence, settings, discovery);
      } catch (error) {
        logger.warn('Series relocation eligibility evaluation failed closed', {
          label: 'Series Relocation',
          canonicalMediaId: presence.canonicalMediaId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        results.push({
          canonicalMediaId: presence.canonicalMediaId,
          outcome: 'blocked',
          reason: 'provider-error',
        });
        continue;
      }
      if (!candidate.eligibility.eligible) {
        results.push({
          canonicalMediaId: presence.canonicalMediaId,
          outcome: this.blockingOutcome(candidate.eligibility.reason),
          reason: candidate.eligibility.reason,
        });
        continue;
      }
      if (moved >= limit) {
        results.push({
          canonicalMediaId: presence.canonicalMediaId,
          outcome: 'skipped',
          reason: 'eligible',
        });
        continue;
      }
      const result = await this.executeCandidate(candidate);
      results.push(result);
      if (result.outcome === 'moved') moved += 1;
      if (result.outcome === 'needs_reconciliation') break;
    }
    const result = this.summarize(startedAt, results);
    this.lastResult = result;
    return result;
  }

  private blockingOutcome(
    reason: SeriesRelocationReason
  ): SeriesRelocationOutcome {
    return ['below-season-threshold', 'not-default-volume'].includes(reason)
      ? 'skipped'
      : 'blocked';
  }

  private summarize(
    startedAt: Date,
    results: SeriesRelocationResult[]
  ): SeriesRelocationRunResult {
    const count = (outcome: SeriesRelocationOutcome) =>
      results.filter((result) => result.outcome === outcome).length;
    return {
      startedAt: startedAt.toISOString(),
      completedAt: this.dependencies.now().toISOString(),
      eligible: results.filter((result) => result.reason === 'eligible').length,
      moved: count('moved'),
      skipped: count('skipped'),
      blocked: count('blocked'),
      failed: count('failed'),
      needsReconciliation: count('needs_reconciliation'),
      results,
    };
  }

  private async loadDefaultVolumePresences(
    settings: AllSettings,
    discovery: StorageDiscoveryResult
  ): Promise<LibraryPresence[]> {
    const defaultId = settings.overflow.defaultSeriesVolumeId;
    if (!defaultId || !settings.overflow.expansionSeriesVolumeId) return [];
    const volume = discovery.volumes.find((item) => item.id === defaultId);
    if (!volume) return [];
    const locations = new Map(
      discovery.locations.map((location) => [location.id, location])
    );
    const roots = volume.locationIds
      .map((id) => locations.get(id))
      .filter(
        (location): location is StorageLocation =>
          location?.provider === 'sonarr' && location.rootFolderId !== null
      );
    const stored = await this.dependencies.connection
      .getRepository(StorageRoot)
      .find({
        where: roots.map((root) => ({
          servarrType: 'sonarr' as const,
          serviceId: root.serviceId,
          sourceRootId: root.rootFolderId!,
        })),
      });
    if (!stored.length) return [];
    return this.dependencies.connection.getRepository(LibraryPresence).find({
      where: {
        sourceSystem: 'sonarr',
        isCurrent: true,
        servarrHasFile: true,
        storageRootId: In(stored.map((root) => root.id)),
      },
      order: { canonicalMediaId: 'ASC' },
    });
  }

  private async evaluatePresence(
    presence: LibraryPresence,
    settings: AllSettings,
    discovery: StorageDiscoveryResult,
    ignoreExecutionId?: string
  ): Promise<RelocationCandidate> {
    const sourceRoot = await this.dependencies.connection
      .getRepository(StorageRoot)
      .findOneByOrFail({
        id: presence.storageRootId!,
      });
    const locations = new Map(
      discovery.locations.map((location) => [location.id, location])
    );
    const sourceLocation = discovery.locations.find(
      (location) =>
        location.provider === 'sonarr' &&
        location.serviceId === sourceRoot.serviceId &&
        location.rootFolderId === sourceRoot.sourceRootId
    );
    const destinationVolume = discovery.volumes.find(
      (volume) => volume.id === settings.overflow.expansionSeriesVolumeId
    );
    const destinationLocations = (destinationVolume?.locationIds ?? [])
      .map((id) => locations.get(id))
      .filter((location): location is StorageLocation => Boolean(location));
    const rootResolution = sourceLocation
      ? resolveOverflowRoot(sourceLocation, destinationLocations)
      : { status: 'destination-root-missing' as const };
    if (
      !sourceLocation ||
      !destinationVolume ||
      rootResolution.status !== 'resolved' ||
      rootResolution.location.rootFolderId === null
    ) {
      return this.incompleteCandidate(
        presence,
        sourceRoot,
        sourceLocation,
        destinationVolume,
        settings,
        'root-resolution-failed'
      );
    }
    const server = settings.sonarr.find(
      (candidate) => candidate.id === sourceRoot.serviceId
    );
    const sourceId = Number(presence.sourceItemId.replace(/^series:/, ''));
    if (!server || !Number.isSafeInteger(sourceId) || sourceId <= 0) {
      return this.incompleteCandidate(
        presence,
        sourceRoot,
        sourceLocation,
        destinationVolume,
        settings,
        'foundation-mismatch'
      );
    }
    const api = this.dependencies.createSonarr(server);
    const [series, files, queue, history, foundationFiles] = await Promise.all([
      api.getSeriesById(sourceId),
      api.getEpisodeFiles(sourceId),
      api.getSeriesQueue(sourceId),
      api.getSeriesHistory(sourceId),
      this.dependencies.connection.getRepository(LibraryFile).find({
        where: { libraryPresenceId: presence.id, isCurrent: true },
        select: { sourceFileId: true, sizeBytes: true },
      }),
    ]);
    const [pendingRequest, removalConflict, activeRelocation] =
      await Promise.all([
        this.hasPendingRequest(presence.canonicalMediaId),
        this.hasRemovalConflict(presence.canonicalMediaId),
        this.dependencies.connection
          .getRepository(SeriesRelocationExecution)
          .exists({
            where: {
              canonicalMediaId: presence.canonicalMediaId,
              activeKey: Not(IsNull()),
              ...(ignoreExecutionId ? { id: Not(ignoreExecutionId) } : {}),
            },
          }),
      ]);
    const reportedRoot = normalizedPath(
      series.rootFolderPath ?? sourceLocation.path
    );
    const rootMatches =
      reportedRoot === normalizedPath(sourceLocation.path) &&
      settings.overflow.defaultSeriesVolumeId ===
        discovery.volumes.find((volume) =>
          volume.locationIds.includes(sourceLocation.id)
        )?.id;
    const eligibility = rootMatches
      ? evaluateSeriesRelocationFacts({
          now: this.dependencies.now(),
          threshold: settings.overflow.seriesSeasonThreshold,
          torrentDelayHours: settings.overflow.torrentRelocationDelayHours,
          files,
          foundationFiles,
          queue,
          history,
          pendingRequest,
          removalConflict,
          activeRelocation,
          destinationVolume,
        })
      : ineligible('not-default-volume');
    return {
      canonicalMediaId: presence.canonicalMediaId,
      presence,
      sourceRoot,
      sourceLocation,
      destinationLocation: rootResolution.location,
      destinationVolume,
      server,
      series,
      files,
      eligibility,
    };
  }

  private incompleteCandidate(
    presence: LibraryPresence,
    sourceRoot: StorageRoot,
    sourceLocation: StorageLocation | undefined,
    destinationVolume: PhysicalVolume | undefined,
    settings: AllSettings,
    reason: SeriesRelocationReason
  ): RelocationCandidate {
    const server = settings.sonarr.find(
      (candidate) => candidate.id === sourceRoot.serviceId
    );
    return {
      canonicalMediaId: presence.canonicalMediaId,
      presence,
      sourceRoot,
      sourceLocation: sourceLocation ?? ({} as StorageLocation),
      destinationLocation: {} as StorageLocation,
      destinationVolume: destinationVolume ?? ({} as PhysicalVolume),
      server: server ?? ({} as SonarrSettings),
      series: {} as SonarrSeries,
      files: [],
      eligibility: ineligible(reason),
    };
  }

  private async hasPendingRequest(canonicalMediaId: number): Promise<boolean> {
    const canonical = await this.dependencies.connection
      .getRepository(CanonicalMedia)
      .findOne({
        where: { id: canonicalMediaId },
        select: { currentMediaId: true },
      });
    if (!canonical?.currentMediaId) return false;
    return this.dependencies.connection.getRepository(MediaRequest).exists({
      where: {
        media: { id: canonical.currentMediaId },
        status: In(ACTIVE_REQUEST_STATUSES),
      },
    });
  }

  private async hasRemovalConflict(canonicalMediaId: number): Promise<boolean> {
    const [claim, schedule] = await Promise.all([
      this.dependencies.connection.getRepository(RemovalExecutionClaim).exists({
        where: { canonicalMediaId, executionId: Not(IsNull()) },
      }),
      this.dependencies.connection.getRepository(RemovalSchedule).exists({
        where: {
          canonicalMediaId,
          status: In([
            RemovalScheduleStatus.ACTIVE,
            RemovalScheduleStatus.DEFERRED,
          ]),
        },
      }),
    ]);
    return claim || schedule;
  }

  private async executeCandidate(
    candidate: RelocationCandidate
  ): Promise<SeriesRelocationResult> {
    let execution: SeriesRelocationExecution;
    try {
      execution = await this.acquire(candidate);
    } catch {
      return {
        canonicalMediaId: candidate.canonicalMediaId,
        outcome: 'blocked',
        reason: 'removal-conflict',
      };
    }
    try {
      const settings = this.dependencies.settings();
      const discovery = await this.dependencies.discover(settings);
      const rechecked = await this.evaluatePresence(
        candidate.presence,
        settings,
        discovery,
        execution.id
      );
      if (!rechecked.eligibility.eligible) {
        await this.terminateBeforeProvider(
          execution,
          rechecked.eligibility.reason,
          'Eligibility changed after the relocation claim was acquired.'
        );
        return {
          canonicalMediaId: candidate.canonicalMediaId,
          executionId: execution.id,
          outcome: this.blockingOutcome(rechecked.eligibility.reason),
          reason: rechecked.eligibility.reason,
        };
      }
      if (!this.matchesExecutionSnapshot(rechecked, execution)) {
        await this.terminateBeforeProvider(
          execution,
          'verification-failed',
          'The Series or EpisodeFile snapshot changed after the relocation claim was acquired.'
        );
        return {
          canonicalMediaId: candidate.canonicalMediaId,
          executionId: execution.id,
          outcome: 'blocked',
          reason: 'verification-failed',
        };
      }
      const api = this.dependencies.createSonarr(rechecked.server);
      execution.state = SeriesRelocationState.PROVIDER_IN_FLIGHT;
      execution.providerStartedAt = this.dependencies.now();
      await this.dependencies.connection
        .getRepository(SeriesRelocationExecution)
        .save(execution);
      await api.moveSeries(
        rechecked.series,
        rechecked.destinationLocation.path
      );
      execution.providerAcceptedAt = this.dependencies.now();
      execution.state = SeriesRelocationState.VERIFYING;
      await this.dependencies.connection
        .getRepository(SeriesRelocationExecution)
        .save(execution);
      const reconciliation = await this.waitForReconciliation(api, execution);
      if (reconciliation.outcome === 'pending') {
        await this.markPending(execution, reconciliation.reason);
        return {
          canonicalMediaId: candidate.canonicalMediaId,
          executionId: execution.id,
          outcome: 'needs_reconciliation',
          reason: 'move-pending',
        };
      }
      if (reconciliation.outcome === 'ambiguous') {
        await this.quarantine(
          execution,
          'verification-failed',
          reconciliation.reason
        );
        return {
          canonicalMediaId: candidate.canonicalMediaId,
          executionId: execution.id,
          outcome: 'needs_reconciliation',
          reason: 'verification-failed',
        };
      }
      await this.completeExecution(execution);
      return {
        canonicalMediaId: candidate.canonicalMediaId,
        executionId: execution.id,
        outcome: 'moved',
        reason: 'eligible',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!execution.providerStartedAt) {
        await this.terminateBeforeProvider(
          execution,
          'provider-error',
          message
        );
        return {
          canonicalMediaId: candidate.canonicalMediaId,
          executionId: execution.id,
          outcome: 'blocked',
          reason: 'provider-error',
        };
      }
      await this.quarantine(execution, 'provider-error', message);
      return {
        canonicalMediaId: candidate.canonicalMediaId,
        executionId: execution.id,
        outcome: 'needs_reconciliation',
        reason: 'provider-error',
      };
    }
  }

  private matchesExecutionSnapshot(
    candidate: RelocationCandidate,
    execution: SeriesRelocationExecution
  ): boolean {
    const ids = candidate.files
      .map((file) => file.id)
      .sort((left, right) => left - right);
    const bytes = candidate.files.reduce(
      (total, file) => total + BigInt(file.size),
      0n
    );
    return (
      candidate.server.id === execution.serviceId &&
      candidate.series.id === execution.sonarrSeriesId &&
      candidate.sourceLocation.rootFolderId === execution.sourceRootFolderId &&
      candidate.destinationLocation.rootFolderId ===
        execution.destinationRootFolderId &&
      normalizedPath(candidate.series.path) ===
        normalizedPath(execution.sourcePath) &&
      normalizedPath(
        seriesDestinationPath(
          candidate.series.path,
          candidate.destinationLocation.path
        )
      ) === normalizedPath(execution.destinationPath) &&
      ids.length === execution.expectedFileCount &&
      ids.every(
        (id, index) => id === execution.expectedEpisodeFileIds[index]
      ) &&
      bytes === BigInt(execution.expectedBytes)
    );
  }

  private async acquire(
    candidate: RelocationCandidate
  ): Promise<SeriesRelocationExecution> {
    return this.dependencies.connection.transaction(
      'SERIALIZABLE',
      async (manager) => {
        await this.lockCanonical(manager, candidate.canonicalMediaId);
        if (
          await manager.getRepository(SeriesRelocationExecution).exists({
            where: {
              canonicalMediaId: candidate.canonicalMediaId,
              activeKey: Not(IsNull()),
            },
          })
        ) {
          throw new Error('Series relocation is already active');
        }
        if (
          await this.hasRemovalConflictIn(manager, candidate.canonicalMediaId)
        ) {
          throw new Error('Removal operation conflicts with relocation');
        }
        const destinationPath = seriesDestinationPath(
          candidate.series.path,
          candidate.destinationLocation.path
        );
        return manager.getRepository(SeriesRelocationExecution).save(
          new SeriesRelocationExecution({
            id: randomUUID(),
            canonicalMediaId: candidate.canonicalMediaId,
            state: SeriesRelocationState.CLAIMED,
            activeKey: `series:${candidate.canonicalMediaId}`,
            serviceId: candidate.server.id,
            sonarrSeriesId: candidate.series.id!,
            sourceRootFolderId: candidate.sourceLocation.rootFolderId!,
            destinationRootFolderId:
              candidate.destinationLocation.rootFolderId!,
            sourceVolumeId:
              this.dependencies.settings().overflow.defaultSeriesVolumeId!,
            destinationVolumeId:
              this.dependencies.settings().overflow.expansionSeriesVolumeId!,
            sourcePath: candidate.series.path,
            destinationPath,
            expectedEpisodeFileIds: candidate.files
              .map((file) => file.id)
              .sort((left, right) => left - right),
            expectedFileCount: candidate.files.length,
            expectedBytes: candidate.eligibility.totalBytes,
          })
        );
      }
    );
  }

  private async lockCanonical(
    manager: EntityManager,
    canonicalMediaId: number
  ): Promise<void> {
    const query = manager
      .getRepository(CanonicalMedia)
      .createQueryBuilder('canonical')
      .where('canonical.id = :canonicalMediaId', { canonicalMediaId });
    if (this.dependencies.connection.options.type !== 'sqlite') {
      query.setLock('pessimistic_write');
    }
    if (!(await query.getOne())) throw new Error('Canonical Series not found');
  }

  private async hasRemovalConflictIn(
    manager: EntityManager,
    canonicalMediaId: number
  ): Promise<boolean> {
    const [claim, schedule] = await Promise.all([
      manager.getRepository(RemovalExecutionClaim).exists({
        where: { canonicalMediaId, executionId: Not(IsNull()) },
      }),
      manager.getRepository(RemovalSchedule).exists({
        where: {
          canonicalMediaId,
          status: In([
            RemovalScheduleStatus.ACTIVE,
            RemovalScheduleStatus.DEFERRED,
          ]),
        },
      }),
    ]);
    return claim || schedule;
  }

  private async inspectExecution(
    api: SonarrAPI,
    execution: SeriesRelocationExecution
  ): Promise<SeriesMoveReconciliation> {
    const [series, files, commands] = await Promise.all([
      api.getSeriesById(execution.sonarrSeriesId),
      api.getEpisodeFiles(execution.sonarrSeriesId),
      api.getSeriesMoveCommands(execution.sonarrSeriesId),
    ]);
    return reconcileSeriesMoveSnapshot(series, files, commands, execution);
  }

  public async waitForReconciliation(
    api: SonarrAPI,
    execution: SeriesRelocationExecution
  ): Promise<SeriesMoveReconciliation> {
    const deadline =
      this.dependencies.now().getTime() +
      this.dependencies.verificationTimeoutMs;
    let last: SeriesMoveReconciliation = {
      outcome: 'ambiguous',
      reason: 'Sonarr relocation verification has not completed.',
    };
    while (this.dependencies.now().getTime() <= deadline) {
      try {
        last = await this.inspectExecution(api, execution);
      } catch (error) {
        return {
          outcome: 'ambiguous',
          reason: `Sonarr relocation state is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (last.outcome === 'completed') return last;
      if (this.dependencies.now().getTime() >= deadline) break;
      await this.dependencies.sleep(this.dependencies.pollIntervalMs);
    }
    return last;
  }

  private async completeExecution(
    execution: SeriesRelocationExecution
  ): Promise<void> {
    execution.state = SeriesRelocationState.COMPLETED;
    execution.activeKey = null;
    execution.failureCode = null;
    execution.failureMessage = null;
    execution.verifiedAt = this.dependencies.now();
    await this.dependencies.connection
      .getRepository(SeriesRelocationExecution)
      .save(execution);
    logger.info('Series relocation verified complete', {
      label: 'Series Relocation',
      canonicalMediaId: execution.canonicalMediaId,
      serviceId: execution.serviceId,
      sonarrSeriesId: execution.sonarrSeriesId,
      executionId: execution.id,
    });
  }

  private async terminateBeforeProvider(
    execution: SeriesRelocationExecution,
    reason: SeriesRelocationReason,
    message: string
  ): Promise<void> {
    if (execution.providerStartedAt) {
      throw new Error(
        'Cannot safely terminate a possibly submitted relocation'
      );
    }
    // The existing durable schema uses COMPLETED as its terminal envelope.
    // A null verifiedAt plus the failure fields distinguish this safe
    // pre-provider termination from a conclusively verified relocation.
    execution.state = SeriesRelocationState.COMPLETED;
    execution.activeKey = null;
    execution.failureCode = reason;
    execution.failureMessage = message.slice(0, 4000);
    execution.verifiedAt = null;
    await this.dependencies.connection
      .getRepository(SeriesRelocationExecution)
      .save(execution);
    logger.info('Series relocation terminated before provider invocation', {
      label: 'Series Relocation',
      canonicalMediaId: execution.canonicalMediaId,
      serviceId: execution.serviceId,
      sonarrSeriesId: execution.sonarrSeriesId,
      executionId: execution.id,
      reason,
    });
  }

  private async markPending(
    execution: SeriesRelocationExecution,
    message: string
  ): Promise<void> {
    execution.state = SeriesRelocationState.VERIFYING;
    execution.failureCode = 'move-pending';
    execution.failureMessage = message.slice(0, 4000);
    await this.dependencies.connection
      .getRepository(SeriesRelocationExecution)
      .save(execution);
    logger.info('Series relocation remains pending in Sonarr', {
      label: 'Series Relocation',
      canonicalMediaId: execution.canonicalMediaId,
      serviceId: execution.serviceId,
      sonarrSeriesId: execution.sonarrSeriesId,
      executionId: execution.id,
      reason: message,
    });
  }

  private async quarantine(
    execution: SeriesRelocationExecution,
    reason: SeriesRelocationReason,
    message: string
  ): Promise<void> {
    execution.state = SeriesRelocationState.RECONCILIATION_REQUIRED;
    execution.failureCode = reason;
    execution.failureMessage = message.slice(0, 4000);
    await this.dependencies.connection
      .getRepository(SeriesRelocationExecution)
      .save(execution);
    logger.warn('Series relocation requires reconciliation', {
      label: 'Series Relocation',
      canonicalMediaId: execution.canonicalMediaId,
      serviceId: execution.serviceId,
      sonarrSeriesId: execution.sonarrSeriesId,
      executionId: execution.id,
      reason,
      reconciliationReason: execution.failureMessage,
    });
  }

  public async reconcileOutstanding(): Promise<SeriesRelocationResult[]> {
    const repository = this.dependencies.connection.getRepository(
      SeriesRelocationExecution
    );
    const outstanding = await repository.find({
      where: {
        state: In([...ACTIVE_SERIES_RELOCATION_STATES]),
        activeKey: Not(IsNull()),
      },
      order: { updatedAt: 'ASC', id: 'ASC' },
    });
    const results: SeriesRelocationResult[] = [];
    for (const execution of outstanding) {
      if (!execution.providerStartedAt) {
        await this.terminateBeforeProvider(
          execution,
          'pre-provider-terminated',
          'Recovered a durable claim that conclusively ended before provider invocation.'
        );
        results.push({
          canonicalMediaId: execution.canonicalMediaId,
          executionId: execution.id,
          outcome: 'blocked',
          reason: 'pre-provider-terminated',
        });
        continue;
      }
      const server = this.dependencies
        .settings()
        .sonarr.find((candidate) => candidate.id === execution.serviceId);
      if (!server) {
        await this.quarantine(
          execution,
          'provider-error',
          'The Sonarr instance for this relocation is no longer configured.'
        );
        results.push({
          canonicalMediaId: execution.canonicalMediaId,
          executionId: execution.id,
          outcome: 'needs_reconciliation',
          reason: 'provider-error',
        });
        continue;
      }
      let observation: SeriesMoveReconciliation;
      try {
        observation = await this.inspectExecution(
          this.dependencies.createSonarr(server),
          execution
        );
      } catch (error) {
        observation = {
          outcome: 'ambiguous',
          reason: `Sonarr relocation state is unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (observation.outcome === 'completed') {
        await this.completeExecution(execution);
        results.push({
          canonicalMediaId: execution.canonicalMediaId,
          executionId: execution.id,
          outcome: 'moved',
          reason: 'eligible',
        });
      } else if (observation.outcome === 'pending') {
        await this.markPending(execution, observation.reason);
        results.push({
          canonicalMediaId: execution.canonicalMediaId,
          executionId: execution.id,
          outcome: 'needs_reconciliation',
          reason: 'move-pending',
        });
      } else {
        await this.quarantine(
          execution,
          'verification-failed',
          observation.reason
        );
        results.push({
          canonicalMediaId: execution.canonicalMediaId,
          executionId: execution.id,
          outcome: 'needs_reconciliation',
          reason: 'verification-failed',
        });
      }
    }
    return results;
  }

  public async reconciliationRequired(): Promise<SeriesRelocationExecution[]> {
    return this.dependencies.connection
      .getRepository(SeriesRelocationExecution)
      .find({
        where: {
          state: In([...ACTIVE_SERIES_RELOCATION_STATES]),
          activeKey: Not(IsNull()),
        },
        order: { updatedAt: 'ASC' },
      });
  }
}

const seriesRelocation = new SeriesRelocationService();
export default seriesRelocation;
