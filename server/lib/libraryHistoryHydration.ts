import type JellyfinAPI from '@server/api/jellyfin';
import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import type { RootFolder } from '@server/api/servarr/base';
import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  LibraryMediaType,
  LibraryReconciliationState,
  LibraryRemovalSource,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
  CanonicalSeasonIdentity,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import type { HydrationRun } from '@server/entity/LibraryHydration';
import { LibrarySourceObservation } from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import backgroundDatabaseWriteCoordinator from '@server/lib/backgroundDatabaseWriteCoordinator';
import libraryHydrationEpoch from '@server/lib/libraryHydrationEpoch';
import {
  LibraryHydrationRunCoordinator,
  LibraryHydrationRunOwnershipLostError,
} from '@server/lib/libraryHydrationRunCoordinator';
import { createJellyfinScannerContext } from '@server/lib/scanners/jellyfin';
import type {
  JellyfinSettings,
  RadarrSettings,
  SonarrSettings,
} from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, type EntityManager } from 'typeorm';

const SOURCE_CONCURRENCY = 4;
const JELLYFIN_PAGE_SIZE = 200;

type ExactIdentity = {
  provider: string;
  value: string | number | null | undefined;
  sourceScope?: string;
};

export interface HydrationSourceSummary {
  source: 'radarr' | 'sonarr' | 'jellyfin' | 'seerr';
  sourceScope: string;
  complete: boolean;
  durationMs: number;
  apiCalls: number;
  rootsInspected: number;
  rootsCreated: number;
  rootsUpdated: number;
  mediaInspected: number;
  canonicalCreated: number;
  canonicalReused: number;
  seasonsCreated: number;
  seasonsReused: number;
  episodesCreated: number;
  episodesReused: number;
  presencesCreated: number;
  presencesUpdated: number;
  presencesClosed: number;
  filesCreated: number;
  filesUpdated: number;
  filesClosed: number;
  aliasesCreated: number;
  aliasesResolved: number;
  mediaLinksResolved: number;
  mediaLinksConflicting: number;
  requestsInspected: number;
  requestsLinked: number;
  requestsUnresolved: number;
  unresolved: number;
  conflicts: number;
  logicalBytes: string;
  failureCode?: string;
}

export interface LibraryHydrationResult {
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  complete: boolean;
  sources: HydrationSourceSummary[];
  queryMetadata: QueryMetadataSummary;
}

export interface QueryMetadataSummary {
  uniqueProviderIdentities: number;
  enriched: number;
  aliasesCreated: number;
  conflicts: number;
  failures: number;
  durationMs: number;
  concurrency: number;
}

interface RadarrHydrationClient {
  getRootFolders(): Promise<RootFolder[]>;
  getMovies(): Promise<RadarrMovie[]>;
}

interface SonarrHydrationClient {
  getRootFolders(): Promise<RootFolder[]>;
  getSeries(): Promise<SonarrSeries[]>;
  getEpisodes(seriesId: number): Promise<SonarrEpisode[]>;
  getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]>;
}

interface JellyfinHydrationClient {
  getAllItems(
    options: Parameters<JellyfinAPI['getAllItems']>[0],
    pageSize?: number,
    onPage?: () => void
  ): Promise<JellyfinLibraryItemExtended[]>;
}

interface QueryMetadataClient {
  getMovieForScan(input: {
    movieId: number;
    language?: string;
  }): Promise<{ id: number; title: string; release_date?: string }>;
  getTvShowForScan(input: {
    tvId: number;
    language?: string;
  }): Promise<{ id: number; name: string; first_air_date?: string }>;
  getShowByTvdbIdForScan(input: {
    tvdbId: number;
    language?: string;
  }): Promise<{ id: number; name: string; first_air_date?: string }>;
  resolveImdbIdForScan(input: { imdbId: string }): Promise<number>;
}

export interface LibraryHydrationDependencies {
  radarrServers(): RadarrSettings[];
  sonarrServers(): SonarrSettings[];
  jellyfinSettings(): JellyfinSettings;
  createRadarrClient(server: RadarrSettings): RadarrHydrationClient;
  createSonarrClient(server: SonarrSettings): SonarrHydrationClient;
  createJellyfinContext(): Promise<
    | {
        client: JellyfinHydrationClient;
        libraries: { id: string; enabled: boolean }[];
      }
    | undefined
  >;
  createQueryMetadataClient(): QueryMetadataClient;
  now(): Date;
}

const defaultDependencies: LibraryHydrationDependencies = {
  radarrServers: () =>
    getSettings().radarr.filter(({ syncEnabled }) => syncEnabled),
  sonarrServers: () =>
    getSettings().sonarr.filter(({ syncEnabled }) => syncEnabled),
  jellyfinSettings: () => getSettings().jellyfin,
  createRadarrClient: (server) =>
    new RadarrAPI({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    }),
  createSonarrClient: (server) =>
    new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    }),
  createJellyfinContext: createJellyfinScannerContext,
  createQueryMetadataClient: () => new TheMovieDb(),
  now: () => new Date(),
};

const emptySummary = (
  source: HydrationSourceSummary['source'],
  sourceScope: string
): HydrationSourceSummary => ({
  source,
  sourceScope,
  complete: false,
  durationMs: 0,
  apiCalls: 0,
  rootsInspected: 0,
  rootsCreated: 0,
  rootsUpdated: 0,
  mediaInspected: 0,
  canonicalCreated: 0,
  canonicalReused: 0,
  seasonsCreated: 0,
  seasonsReused: 0,
  episodesCreated: 0,
  episodesReused: 0,
  presencesCreated: 0,
  presencesUpdated: 0,
  presencesClosed: 0,
  filesCreated: 0,
  filesUpdated: 0,
  filesClosed: 0,
  aliasesCreated: 0,
  aliasesResolved: 0,
  mediaLinksResolved: 0,
  mediaLinksConflicting: 0,
  requestsInspected: 0,
  requestsLinked: 0,
  requestsUnresolved: 0,
  unresolved: 0,
  conflicts: 0,
  logicalBytes: '0',
});

const safeDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const fileQualityResolution = (
  file?: {
    quality?: {
      quality?: { resolution?: number | null } | null;
    } | null;
  } | null
): number | null => {
  const resolution = file?.quality?.quality?.resolution;
  return typeof resolution === 'number' &&
    Number.isSafeInteger(resolution) &&
    resolution > 0
    ? resolution
    : null;
};

const providerYear = (value?: string | null): number | null => {
  const year = value ? Number(value.slice(0, 4)) : NaN;
  return Number.isSafeInteger(year) && year > 0 ? year : null;
};

const normalizePath = (value?: string | null): string =>
  (value ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

const sourceScope = (serviceId: number): string => `service:${serviceId}`;

const exactIdentities = (identities: ExactIdentity[]): ExactIdentity[] => {
  const seen = new Set<string>();
  return identities.filter(({ provider, sourceScope = '', value }) => {
    if (value === null || value === undefined || String(value).trim() === '') {
      return false;
    }
    const key = `${provider}:${sourceScope}:${String(value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const mapBounded = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await mapper(values[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
};

export class LibraryHistoryHydrationService {
  private inFlight?: Promise<LibraryHydrationResult>;
  private catchUpStarted = false;

  constructor(
    private readonly dependencies: LibraryHydrationDependencies = defaultDependencies,
    private readonly runCoordinator = new LibraryHydrationRunCoordinator(
      dataSource,
      dependencies.now
    )
  ) {}

  public running(): boolean {
    return Boolean(this.inFlight);
  }

  public run(): Promise<LibraryHydrationResult> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = backgroundDatabaseWriteCoordinator
      .runExclusive(async () => {
        await this.runCoordinator.recoverExpiredRuns();
        return this.execute();
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  public startCatchUp(): void {
    if (this.catchUpStarted) return;
    this.catchUpStarted = true;
    const timer = setTimeout(() => {
      void this.run().catch((error) => {
        logger.error('Current library hydration catch-up failed', {
          label: 'Library History',
          errorType:
            error instanceof Error ? error.constructor.name : 'UnknownError',
        });
      });
    }, 30_000);
    timer.unref();
  }

  private async execute(): Promise<LibraryHydrationResult> {
    const startedAt = this.dependencies.now();
    const summaries: HydrationSourceSummary[] = [];

    for (const server of this.dependencies.radarrServers()) {
      summaries.push(await this.hydrateRadarr(server));
    }
    for (const server of this.dependencies.sonarrServers()) {
      summaries.push(await this.hydrateSonarr(server));
    }
    summaries.push(await this.hydrateJellyfin());
    summaries.push(await this.hydrateSeerr());
    const queryMetadata = await this.hydrateQueryMetadata();

    const completedAt = this.dependencies.now();
    const result = {
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      complete: summaries.every(({ complete }) => complete),
      sources: summaries,
      queryMetadata,
    };
    logger.info('Current library hydration completed', {
      label: 'Library History',
      complete: result.complete,
      durationMs: result.durationMs,
      sources: summaries,
      queryMetadata,
    });
    return result;
  }

  private async beginRun(source: string, scope: string): Promise<HydrationRun> {
    return this.runCoordinator.begin(
      source,
      scope,
      source === 'radarr' || source === 'sonarr' || source === 'jellyfin'
    );
  }

  private async finishRun(
    run: HydrationRun,
    summary: HydrationSourceSummary,
    failure?: unknown
  ): Promise<void> {
    const completedAt = this.dependencies.now();
    const failureCode = failure
      ? failure instanceof Error
        ? failure.constructor.name
        : 'UnknownError'
      : null;
    if (failureCode) summary.failureCode = failureCode;
    try {
      await this.runCoordinator.complete(run.id, {
        succeeded: summary.complete,
        completedAt,
        coverageEndedAt: summary.complete ? completedAt : null,
        rowsInspected:
          summary.rootsInspected +
          summary.mediaInspected +
          summary.requestsInspected,
        rowsCreated:
          summary.rootsCreated +
          summary.canonicalCreated +
          summary.seasonsCreated +
          summary.episodesCreated +
          summary.presencesCreated +
          summary.filesCreated +
          summary.aliasesCreated,
        rowsUpdated:
          summary.rootsUpdated +
          summary.presencesUpdated +
          summary.presencesClosed +
          summary.filesUpdated +
          summary.filesClosed +
          summary.mediaLinksResolved,
        unresolvedCount: summary.unresolved + summary.conflicts,
        failureCode,
        failureMessage: failure
          ? 'Current source enumeration or reconciliation failed.'
          : null,
      });
    } catch (error) {
      if (!(error instanceof LibraryHydrationRunOwnershipLostError)) {
        throw error;
      }
      summary.complete = false;
      summary.failureCode = error.constructor.name;
      logger.warn('Discarded stale current-library hydration completion', {
        label: 'Library History',
        source: run.source,
        sourceScope: run.sourceScope,
      });
    }
  }

  private async assertRunOwnership(
    manager: EntityManager,
    run: HydrationRun,
    sourceSystem?: string,
    scope?: string,
    snapshotEpoch?: number
  ): Promise<void> {
    await this.runCoordinator.assertOwnership(run.id, manager);
    if (
      sourceSystem !== undefined &&
      scope !== undefined &&
      snapshotEpoch !== undefined
    ) {
      await libraryHydrationEpoch.assert(
        manager,
        sourceSystem,
        scope,
        snapshotEpoch
      );
    }
  }

  private async withOwnedRun<T>(
    run: HydrationRun,
    work: (manager: EntityManager) => Promise<T>,
    sourceSystem?: string,
    scope?: string,
    snapshotEpoch?: number
  ): Promise<T> {
    return dataSource.transaction('SERIALIZABLE', async (manager) => {
      await this.assertRunOwnership(
        manager,
        run,
        sourceSystem,
        scope,
        snapshotEpoch
      );
      return work(manager);
    });
  }

  private async resolveCanonical({
    mediaType,
    identities,
    run,
    sourceSystem,
    scope,
    summary,
    snapshotEpoch,
  }: {
    mediaType: LibraryMediaType;
    identities: ExactIdentity[];
    run: HydrationRun;
    sourceSystem: string;
    scope: string;
    summary: HydrationSourceSummary;
    snapshotEpoch?: number;
  }): Promise<CanonicalMedia | undefined> {
    const values = exactIdentities(identities);
    if (values.length === 0) {
      summary.unresolved++;
      return undefined;
    }
    return this.withOwnedRun(
      run,
      async (manager) => {
        const identityRepository = manager.getRepository(
          CanonicalMediaIdentity
        );
        const matched = await Promise.all(
          values.map(({ provider, sourceScope = '', value }) =>
            identityRepository.findOneBy({
              provider,
              sourceScope,
              mediaType,
              value: String(value),
            })
          )
        );
        const authoritativeCanonicalIds = [
          ...new Set(
            matched.flatMap((identity, index) =>
              values[index].sourceScope
                ? []
                : (identity?.canonicalMediaId ?? [])
            )
          ),
        ];
        if (authoritativeCanonicalIds.length > 1) {
          summary.conflicts++;
          return undefined;
        }

        const authoritativeCanonicalId = authoritativeCanonicalIds[0];
        if (authoritativeCanonicalId !== undefined) {
          for (let index = 0; index < values.length; index++) {
            const identity = values[index];
            const existing = matched[index];
            if (
              !identity.sourceScope ||
              !existing ||
              existing.canonicalMediaId === authoritativeCanonicalId
            ) {
              continue;
            }
            const presenceRepository = manager.getRepository(LibraryPresence);
            const presences = await presenceRepository.findBy({
              sourceSystem: identity.provider,
              sourceScope: identity.sourceScope,
              sourceItemId: In([
                String(identity.value),
                `${mediaType}:${identity.value}`,
              ]),
            });
            presences.forEach((presence) => {
              presence.canonicalMediaId = authoritativeCanonicalId;
            });
            if (presences.length > 0) await presenceRepository.save(presences);

            if (identity.provider === 'jellyfin') {
              const stateRepository =
                manager.getRepository(CurrentViewingState);
              const states = await stateRepository.findBy({
                sourceScope: identity.sourceScope,
                sourceItemId: String(identity.value),
              });
              states.forEach((state) => {
                state.canonicalMediaId = authoritativeCanonicalId;
              });
              if (states.length > 0) await stateRepository.save(states);
            }
            const evidenceRepository = manager.getRepository(ViewingEvidence);
            const evidence = await evidenceRepository.findBy({
              source: identity.provider,
              sourceScope: identity.sourceScope,
              sourceItemId: String(identity.value),
            });
            evidence.forEach((item) => {
              item.canonicalMediaId = authoritativeCanonicalId;
            });
            if (evidence.length > 0) await evidenceRepository.save(evidence);
            existing.canonicalMediaId = authoritativeCanonicalId;
            await identityRepository.save(existing);
            summary.aliasesResolved++;
          }
        }

        const canonicalIds = [
          ...new Set(
            matched.flatMap((identity) => identity?.canonicalMediaId ?? [])
          ),
        ];
        if (canonicalIds.length > 1) {
          summary.conflicts++;
          return undefined;
        }
        const canonicalRepository = manager.getRepository(CanonicalMedia);
        let canonical: CanonicalMedia;
        if (canonicalIds.length === 1) {
          canonical = await canonicalRepository.findOneByOrFail({
            id: canonicalIds[0],
          });
          summary.canonicalReused++;
        } else {
          canonical = await canonicalRepository.save(
            new CanonicalMedia({ mediaType, titleSnapshot: null, year: null })
          );
          summary.canonicalCreated++;
        }
        for (let index = 0; index < values.length; index++) {
          const identity = values[index];
          const existing = matched[index];
          if (existing) {
            if (existing.canonicalMediaId !== canonical.id) {
              summary.conflicts++;
              return undefined;
            }
            summary.aliasesResolved++;
            continue;
          }
          await identityRepository.save(
            new CanonicalMediaIdentity({
              canonicalMediaId: canonical.id,
              mediaType,
              provider: identity.provider,
              sourceScope: identity.sourceScope ?? '',
              value: String(identity.value),
            })
          );
          summary.aliasesCreated++;
        }
        return canonical;
      },
      sourceSystem,
      scope,
      snapshotEpoch
    );
  }

  private async ensureRoot(
    type: 'radarr' | 'sonarr',
    serviceId: number,
    root: RootFolder,
    summary: HydrationSourceSummary,
    run: HydrationRun,
    snapshotEpoch: number
  ): Promise<StorageRoot> {
    const scope = sourceScope(serviceId);
    return this.withOwnedRun(
      run,
      async (manager) => {
        const repository = manager.getRepository(StorageRoot);
        let stored = await repository.findOneBy({
          servarrType: type,
          serviceId,
          sourceRootId: root.id,
        });
        if (!stored) {
          stored = await repository.save(
            new StorageRoot({
              servarrType: type,
              serviceId,
              sourceRootId: root.id,
              pathSnapshot: root.path,
            })
          );
          summary.rootsCreated++;
        } else if (stored.pathSnapshot !== root.path) {
          stored.pathSnapshot = root.path;
          stored = await repository.save(stored);
          summary.rootsUpdated++;
        }
        return stored;
      },
      type,
      scope,
      snapshotEpoch
    );
  }

  private matchRoot(
    path: string | undefined,
    roots: { source: RootFolder; stored: StorageRoot }[]
  ): StorageRoot | undefined {
    const normalized = normalizePath(path);
    return roots
      .filter(({ source }) => {
        const root = normalizePath(source.path);
        return normalized === root || normalized.startsWith(`${root}/`);
      })
      .sort(
        (left, right) =>
          normalizePath(right.source.path).length -
          normalizePath(left.source.path).length
      )[0]?.stored;
  }

  private async ensurePresence({
    canonical,
    sourceSystem,
    scope,
    sourceItemId,
    storageRoot,
    path,
    logicalSizeBytes,
    addedAt,
    addedAtSource,
    servarrManaged,
    servarrHasFile,
    jellyfinVisible,
    run,
    summary,
    snapshotEpoch,
  }: {
    canonical: CanonicalMedia;
    sourceSystem: string;
    scope: string;
    sourceItemId: string;
    storageRoot?: StorageRoot;
    path?: string | null;
    logicalSizeBytes?: string | null;
    addedAt?: Date | null;
    addedAtSource?: string | null;
    servarrManaged?: boolean | null;
    servarrHasFile?: boolean | null;
    jellyfinVisible?: boolean | null;
    run: HydrationRun;
    summary: HydrationSourceSummary;
    snapshotEpoch?: number;
  }): Promise<LibraryPresence> {
    return this.withOwnedRun(
      run,
      async (manager) => {
        const repository = manager.getRepository(LibraryPresence);
        let presence = await repository.findOneBy({
          sourceSystem,
          sourceScope: scope,
          sourceItemId,
          isCurrent: true,
        });
        if (presence && presence.canonicalMediaId !== canonical.id) {
          summary.conflicts++;
          throw new Error(
            'Source identity is already attached to another canonical item.'
          );
        }
        const now = this.dependencies.now();
        if (!presence) {
          const prior = await repository.countBy({
            sourceSystem,
            sourceScope: scope,
            sourceItemId,
          });
          presence = new LibraryPresence({
            canonicalMediaId: canonical.id,
            sourceSystem,
            sourceScope: scope,
            sourceItemId,
            sourceGeneration: String(prior + 1),
            firstObservedAt: now,
          });
          summary.presencesCreated++;
        } else {
          summary.presencesUpdated++;
        }
        presence.storageRootId = storageRoot?.id ?? null;
        presence.pathSnapshot = path ?? null;
        presence.logicalSizeBytes = logicalSizeBytes ?? null;
        if (!presence.addedAt && addedAt) {
          presence.addedAt = addedAt;
          presence.addedAtSource = addedAtSource ?? null;
          presence.addedAtConfidence = 'exact';
        }
        presence.lastSeenAt = now;
        presence.removedAt = null;
        presence.isCurrent = true;
        presence.servarrManaged = servarrManaged ?? null;
        presence.servarrHasFile = servarrHasFile ?? null;
        if (jellyfinVisible !== undefined) {
          presence.jellyfinVisible = jellyfinVisible;
        }
        presence.reconciliationState = LibraryReconciliationState.CURRENT;
        presence = await repository.save(presence);
        await this.observePresence(presence, run, manager);
        return presence;
      },
      sourceSystem,
      scope,
      snapshotEpoch
    );
  }

  private async observePresence(
    presence: LibraryPresence,
    run: HydrationRun,
    manager?: EntityManager
  ): Promise<void> {
    const repository = manager
      ? manager.getRepository(LibrarySourceObservation)
      : getRepository(LibrarySourceObservation);
    const identity = {
      source: run.source,
      sourceScope: run.sourceScope,
      sourceGeneration: presence.sourceGeneration,
      sourceObservationId: `current:${presence.sourceItemId}`,
    };
    let observation = await repository.findOneBy(identity);
    observation ??= new LibrarySourceObservation({
      ...identity,
      libraryPresenceId: presence.id,
    });
    observation.hydrationRunId = run.id;
    observation.storageRootId = presence.storageRootId ?? null;
    observation.pathSnapshot = presence.pathSnapshot ?? null;
    observation.logicalSizeBytes = presence.logicalSizeBytes ?? null;
    observation.servarrManaged = presence.servarrManaged ?? null;
    observation.servarrHasFile = presence.servarrHasFile ?? null;
    observation.jellyfinVisible = presence.jellyfinVisible ?? null;
    observation.observedAt = this.dependencies.now();
    await repository.save(observation);
  }

  private async ensureFile({
    presence,
    sourceSystem,
    scope,
    sourceFileId,
    storageRoot,
    path,
    size,
    resolution,
    importedAt,
    run,
    summary,
    snapshotEpoch,
    canonicalEpisodeIds = [],
  }: {
    presence: LibraryPresence;
    sourceSystem: string;
    scope: string;
    sourceFileId: string;
    storageRoot?: StorageRoot;
    path?: string | null;
    size?: number | null;
    resolution?: number | null;
    importedAt?: Date | null;
    run: HydrationRun;
    summary: HydrationSourceSummary;
    snapshotEpoch?: number;
    canonicalEpisodeIds?: number[];
  }): Promise<LibraryFile> {
    return this.withOwnedRun(
      run,
      async (manager) => {
        const repository = manager.getRepository(LibraryFile);
        let file = await repository.findOneBy({
          sourceSystem,
          sourceScope: scope,
          sourceFileId,
          isCurrent: true,
        });
        const now = this.dependencies.now();
        if (!file) {
          const prior = await repository.countBy({
            sourceSystem,
            sourceScope: scope,
            sourceFileId,
          });
          file = new LibraryFile({
            libraryPresenceId: presence.id,
            sourceSystem,
            sourceScope: scope,
            sourceFileId,
            sourceGeneration: String(prior + 1),
            firstObservedAt: now,
          });
          summary.filesCreated++;
        } else {
          summary.filesUpdated++;
        }
        file.libraryPresenceId = presence.id;
        file.storageRootId = storageRoot?.id ?? null;
        file.pathSnapshot = path ?? null;
        file.sizeBytes =
          size === null || size === undefined ? null : String(size);
        if (resolution !== null && resolution !== undefined)
          file.resolution = resolution;
        if (!file.importedAt && importedAt) {
          file.importedAt = importedAt;
          file.importedAtSource = `${sourceSystem}-file-date-added`;
          file.importedAtConfidence = 'exact';
        }
        file.lastSeenAt = now;
        file.removedAt = null;
        file.isCurrent = true;
        file = await repository.save(file);
        const linkRepository = manager.getRepository(LibraryFileEpisode);
        for (const canonicalEpisodeId of canonicalEpisodeIds) {
          if (
            !(await linkRepository.findOneBy({
              libraryFileId: file.id,
              canonicalEpisodeId,
            }))
          ) {
            await linkRepository.save(
              new LibraryFileEpisode({
                libraryFileId: file.id,
                canonicalEpisodeId,
              })
            );
          }
        }
        return file;
      },
      sourceSystem,
      scope,
      snapshotEpoch
    );
  }

  private async closeMissing(
    sourceSystem: string,
    scope: string,
    seenPresenceIds: Set<number>,
    seenFileIds: Set<number>,
    run: HydrationRun,
    summary: HydrationSourceSummary,
    snapshotEpoch?: number
  ): Promise<void> {
    await this.withOwnedRun(
      run,
      async (manager) => {
        const now = this.dependencies.now();
        const fileRepository = manager.getRepository(LibraryFile);
        const currentFiles = await fileRepository.findBy({
          sourceSystem,
          sourceScope: scope,
          isCurrent: true,
        });
        for (const file of currentFiles) {
          if (seenFileIds.has(file.id)) continue;
          file.isCurrent = false;
          file.removedAt = now;
          file.removalSource ??= LibraryRemovalSource.EXTERNAL;
          await fileRepository.save(file);
          summary.filesClosed++;
        }

        const presenceRepository = manager.getRepository(LibraryPresence);
        const currentPresences = await presenceRepository.findBy({
          sourceSystem,
          sourceScope: scope,
          isCurrent: true,
        });
        for (const presence of currentPresences) {
          if (seenPresenceIds.has(presence.id)) continue;
          presence.isCurrent = false;
          presence.removedAt = now;
          presence.removalSource ??= LibraryRemovalSource.EXTERNAL;
          presence.reconciliationState = LibraryReconciliationState.CURRENT;
          await presenceRepository.save(presence);
          summary.presencesClosed++;
        }
      },
      sourceSystem,
      scope,
      snapshotEpoch
    );
  }

  private async hydrateRadarr(
    server: RadarrSettings
  ): Promise<HydrationSourceSummary> {
    const scope = sourceScope(server.id);
    const summary = emptySummary('radarr', scope);
    const started = this.dependencies.now().getTime();
    const run = await this.beginRun('radarr', scope);
    const heartbeat = this.runCoordinator.heartbeat(run.id);
    const snapshotEpoch = await libraryHydrationEpoch.capture('radarr', scope);
    let failure: unknown;
    try {
      const client = this.dependencies.createRadarrClient(server);
      const [rootFolders, movies] = await Promise.all([
        client.getRootFolders(),
        client.getMovies(),
      ]);
      summary.apiCalls += 2;
      summary.rootsInspected = rootFolders.length;
      summary.mediaInspected = movies.length;

      const roots = [] as { source: RootFolder; stored: StorageRoot }[];
      for (const root of rootFolders) {
        roots.push({
          source: root,
          stored: await this.ensureRoot(
            'radarr',
            server.id,
            root,
            summary,
            run,
            snapshotEpoch
          ),
        });
      }
      const seenPresenceIds = new Set<number>();
      const seenFileIds = new Set<number>();
      let logicalBytes = 0n;
      for (const movie of movies) {
        const canonical = await this.resolveCanonical({
          mediaType: LibraryMediaType.MOVIE,
          run,
          sourceSystem: 'radarr',
          scope,
          identities: [
            { provider: 'tmdb', value: movie.tmdbId },
            { provider: 'imdb', value: movie.imdbId },
            { provider: 'radarr', sourceScope: scope, value: movie.id },
          ],
          summary,
          snapshotEpoch,
        });
        if (!canonical) continue;
        const root = this.matchRoot(movie.rootFolderPath ?? movie.path, roots);
        const file = movie.movieFile;
        const importedAt = safeDate(file?.dateAdded);
        const presence = await this.ensurePresence({
          canonical,
          sourceSystem: 'radarr',
          scope,
          sourceItemId: `movie:${movie.id}`,
          storageRoot: root,
          path: movie.path,
          logicalSizeBytes: file ? String(file.size) : null,
          addedAt: importedAt,
          addedAtSource: importedAt ? 'radarr-movie-file-date-added' : null,
          servarrManaged: true,
          servarrHasFile: Boolean(movie.hasFile && file),
          run,
          summary,
          snapshotEpoch,
        });
        seenPresenceIds.add(presence.id);
        if (file) {
          const path =
            file.path ??
            (file.relativePath
              ? `${movie.path.replace(/[\\/]$/, '')}/${file.relativePath}`
              : null);
          const storedFile = await this.ensureFile({
            presence,
            sourceSystem: 'radarr',
            scope,
            sourceFileId: `movie-file:${file.id}`,
            storageRoot: root,
            path,
            size: file.size,
            resolution: fileQualityResolution(file),
            importedAt,
            run,
            summary,
            snapshotEpoch,
          });
          seenFileIds.add(storedFile.id);
          logicalBytes += BigInt(file.size);
        }
      }
      await this.closeMissing(
        'radarr',
        scope,
        seenPresenceIds,
        seenFileIds,
        run,
        summary,
        snapshotEpoch
      );
      summary.logicalBytes = String(logicalBytes);
      summary.complete = true;
      return summary;
    } catch (error) {
      failure = error;
      return summary;
    } finally {
      await heartbeat.stop();
      summary.durationMs = this.dependencies.now().getTime() - started;
      await this.finishRun(
        run,
        summary,
        summary.complete ? undefined : failure
      );
    }
  }

  private async hydrateSonarr(
    server: SonarrSettings
  ): Promise<HydrationSourceSummary> {
    const scope = sourceScope(server.id);
    const summary = emptySummary('sonarr', scope);
    const started = this.dependencies.now().getTime();
    const run = await this.beginRun('sonarr', scope);
    const heartbeat = this.runCoordinator.heartbeat(run.id);
    const snapshotEpoch = await libraryHydrationEpoch.capture('sonarr', scope);
    let failure: unknown;
    try {
      const client = this.dependencies.createSonarrClient(server);
      const [rootFolders, series] = await Promise.all([
        client.getRootFolders(),
        client.getSeries(),
      ]);
      summary.apiCalls += 2;
      const details = await mapBounded(
        series,
        SOURCE_CONCURRENCY,
        async (show) => {
          if (!show.id) throw new Error('Sonarr series has no source ID.');
          const [episodes, files] = await Promise.all([
            client.getEpisodes(show.id),
            client.getEpisodeFiles(show.id),
          ]);
          return { show, episodes, files };
        }
      );
      summary.apiCalls += series.length * 2;
      summary.rootsInspected = rootFolders.length;
      summary.mediaInspected =
        series.length +
        details.reduce((total, detail) => total + detail.episodes.length, 0);

      const roots = [] as { source: RootFolder; stored: StorageRoot }[];
      for (const root of rootFolders) {
        roots.push({
          source: root,
          stored: await this.ensureRoot(
            'sonarr',
            server.id,
            root,
            summary,
            run,
            snapshotEpoch
          ),
        });
      }
      const seenPresenceIds = new Set<number>();
      const seenFileIds = new Set<number>();
      let logicalBytes = 0n;
      for (const { show, episodes, files } of details) {
        const showId = show.id as number;
        const canonical = await this.resolveCanonical({
          mediaType: LibraryMediaType.SERIES,
          run,
          sourceSystem: 'sonarr',
          scope,
          identities: [
            { provider: 'tvdb', value: show.tvdbId },
            { provider: 'imdb', value: show.imdbId },
            { provider: 'sonarr', sourceScope: scope, value: showId },
          ],
          summary,
          snapshotEpoch,
        });
        if (!canonical) continue;
        const root = this.matchRoot(show.rootFolderPath ?? show.path, roots);
        const distinctFiles = new Map(files.map((file) => [file.id, file]));
        const imported = [...distinctFiles.values()]
          .map(({ dateAdded }) => safeDate(dateAdded))
          .filter((date): date is Date => Boolean(date))
          .sort((left, right) => left.getTime() - right.getTime());
        const seriesBytes = [...distinctFiles.values()].reduce(
          (total, file) => total + BigInt(file.size),
          0n
        );
        const presence = await this.ensurePresence({
          canonical,
          sourceSystem: 'sonarr',
          scope,
          sourceItemId: `series:${showId}`,
          storageRoot: root,
          path: show.path,
          logicalSizeBytes: String(seriesBytes),
          addedAt: imported[0] ?? null,
          addedAtSource: imported.length
            ? 'sonarr-episode-file-date-added'
            : null,
          servarrManaged: true,
          servarrHasFile: distinctFiles.size > 0,
          run,
          summary,
          snapshotEpoch,
        });
        seenPresenceIds.add(presence.id);

        const seasonNumbers = new Set([
          ...show.seasons.map(({ seasonNumber }) => seasonNumber),
          ...episodes.map(({ seasonNumber }) => seasonNumber),
        ]);
        const seasons = new Map<number, CanonicalSeason>();
        for (const seasonNumber of seasonNumbers) {
          seasons.set(
            seasonNumber,
            await this.ensureSeason(
              canonical,
              seasonNumber,
              scope,
              showId,
              summary,
              run,
              snapshotEpoch
            )
          );
        }
        const canonicalEpisodes = new Map<number, CanonicalEpisode>();
        for (const episode of episodes) {
          const season = seasons.get(episode.seasonNumber);
          if (!season) continue;
          canonicalEpisodes.set(
            episode.id,
            await this.ensureEpisode(
              season,
              episode,
              scope,
              summary,
              run,
              snapshotEpoch
            )
          );
        }

        for (const file of distinctFiles.values()) {
          const path =
            file.path ??
            (file.relativePath
              ? `${show.path.replace(/[\\/]$/, '')}/${file.relativePath}`
              : null);
          const linkedEpisodeIds = episodes
            .filter(({ episodeFileId }) => episodeFileId === file.id)
            .flatMap((episode) => {
              const canonicalEpisode = canonicalEpisodes.get(episode.id);
              return canonicalEpisode ? [canonicalEpisode.id] : [];
            });
          const storedFile = await this.ensureFile({
            presence,
            sourceSystem: 'sonarr',
            scope,
            sourceFileId: `episode-file:${file.id}`,
            storageRoot: root,
            path,
            size: file.size,
            resolution: fileQualityResolution(file),
            importedAt: safeDate(file.dateAdded),
            run,
            summary,
            snapshotEpoch,
            canonicalEpisodeIds: linkedEpisodeIds,
          });
          seenFileIds.add(storedFile.id);
          logicalBytes += BigInt(file.size);
        }
      }
      await this.closeMissing(
        'sonarr',
        scope,
        seenPresenceIds,
        seenFileIds,
        run,
        summary,
        snapshotEpoch
      );
      summary.logicalBytes = String(logicalBytes);
      summary.complete = true;
      return summary;
    } catch (error) {
      failure = error;
      return summary;
    } finally {
      await heartbeat.stop();
      summary.durationMs = this.dependencies.now().getTime() - started;
      await this.finishRun(
        run,
        summary,
        summary.complete ? undefined : failure
      );
    }
  }

  private async ensureSeason(
    series: CanonicalMedia,
    seasonNumber: number,
    scope: string,
    sourceSeriesId: number,
    summary: HydrationSourceSummary,
    run: HydrationRun,
    snapshotEpoch: number
  ): Promise<CanonicalSeason> {
    return this.withOwnedRun(
      run,
      async (manager) => {
        const repository = manager.getRepository(CanonicalSeason);
        let season = await repository.findOneBy({
          seriesId: series.id,
          seasonNumber,
        });
        if (!season) {
          season = await repository.save(
            new CanonicalSeason({ seriesId: series.id, seasonNumber })
          );
          summary.seasonsCreated++;
        } else {
          summary.seasonsReused++;
        }
        const identityRepository = manager.getRepository(
          CanonicalSeasonIdentity
        );
        if (
          !(await identityRepository.findOneBy({
            provider: 'sonarr',
            sourceScope: scope,
            value: `${sourceSeriesId}:${seasonNumber}`,
          }))
        ) {
          await identityRepository.save(
            new CanonicalSeasonIdentity({
              canonicalSeasonId: season.id,
              provider: 'sonarr',
              sourceScope: scope,
              value: `${sourceSeriesId}:${seasonNumber}`,
            })
          );
          summary.aliasesCreated++;
        }
        return season;
      },
      'sonarr',
      scope,
      snapshotEpoch
    );
  }

  private async ensureEpisode(
    season: CanonicalSeason,
    episode: SonarrEpisode,
    scope: string,
    summary: HydrationSourceSummary,
    run: HydrationRun,
    snapshotEpoch: number
  ): Promise<CanonicalEpisode> {
    return this.withOwnedRun(
      run,
      async (manager) => {
        const repository = manager.getRepository(CanonicalEpisode);
        let stored = await repository.findOneBy({
          seasonId: season.id,
          episodeNumber: episode.episodeNumber,
        });
        if (!stored) {
          stored = await repository.save(
            new CanonicalEpisode({
              seasonId: season.id,
              episodeNumber: episode.episodeNumber,
              airDate: episode.airDate || null,
              isSpecial: episode.seasonNumber === 0,
            })
          );
          summary.episodesCreated++;
        } else {
          stored.airDate = episode.airDate || stored.airDate;
          stored.isSpecial = episode.seasonNumber === 0;
          await repository.save(stored);
          summary.episodesReused++;
        }
        const identities = exactIdentities([
          { provider: 'sonarr', sourceScope: scope, value: episode.id },
          { provider: 'tvdb', value: episode.tvdbId },
        ]);
        const identityRepository = manager.getRepository(
          CanonicalEpisodeIdentity
        );
        for (const identity of identities) {
          const existing = await identityRepository.findOneBy({
            provider: identity.provider,
            sourceScope: identity.sourceScope ?? '',
            value: String(identity.value),
          });
          if (existing && existing.canonicalEpisodeId !== stored.id) {
            summary.conflicts++;
            continue;
          }
          if (!existing) {
            await identityRepository.save(
              new CanonicalEpisodeIdentity({
                canonicalEpisodeId: stored.id,
                provider: identity.provider,
                sourceScope: identity.sourceScope ?? '',
                value: String(identity.value),
              })
            );
            summary.aliasesCreated++;
          }
        }
        return stored;
      },
      'sonarr',
      scope,
      snapshotEpoch
    );
  }

  private async reconcileScopedMediaHistory(
    provider: string,
    scope: string,
    targets: Map<
      string,
      { canonicalMediaId: number; mediaType: LibraryMediaType }
    >,
    run: HydrationRun,
    summary: HydrationSourceSummary,
    snapshotEpoch?: number
  ): Promise<void> {
    if (targets.size === 0) return;
    await this.withOwnedRun(
      run,
      async (manager) => {
        const sourceItemIds = [...targets].map(
          ([sourceItemId, target]) => `${target.mediaType}:${sourceItemId}`
        );
        const presenceRepository = manager.getRepository(LibraryPresence);
        const presences = await presenceRepository.findBy({
          sourceSystem: provider,
          sourceScope: scope,
          sourceItemId: In(sourceItemIds),
        });
        const changedPresences = presences.filter((presence) => {
          const separator = presence.sourceItemId.indexOf(':');
          const sourceItemId =
            separator >= 0
              ? presence.sourceItemId.slice(separator + 1)
              : presence.sourceItemId;
          const target = targets.get(sourceItemId);
          if (
            !target ||
            presence.canonicalMediaId === target.canonicalMediaId
          ) {
            return false;
          }
          presence.canonicalMediaId = target.canonicalMediaId;
          return true;
        });
        if (changedPresences.length > 0) {
          await presenceRepository.save(changedPresences);
          summary.presencesUpdated += changedPresences.length;
        }

        if (provider !== 'jellyfin') return;
        const movieTargets = new Map(
          [...targets].filter(
            ([, target]) => target.mediaType === LibraryMediaType.MOVIE
          )
        );
        if (movieTargets.size === 0) return;
        const movieSourceItemIds = [...movieTargets.keys()];
        const stateRepository = manager.getRepository(CurrentViewingState);
        const states = await stateRepository.findBy({
          sourceScope: scope,
          sourceItemId: In(movieSourceItemIds),
          mediaType: 'movie',
        });
        const changedStates = states.filter((state) => {
          const target = movieTargets.get(state.sourceItemId);
          if (!target || state.canonicalMediaId === target.canonicalMediaId) {
            return false;
          }
          state.canonicalMediaId = target.canonicalMediaId;
          return true;
        });
        if (changedStates.length > 0) await stateRepository.save(changedStates);

        const evidenceRepository = manager.getRepository(ViewingEvidence);
        const evidence = await evidenceRepository.findBy({
          source: provider,
          sourceScope: scope,
          sourceItemId: In(movieSourceItemIds),
        });
        const changedEvidence = evidence.filter((item) => {
          const target = item.sourceItemId
            ? movieTargets.get(item.sourceItemId)
            : undefined;
          if (
            !target ||
            item.canonicalEpisodeId ||
            item.canonicalMediaId === target.canonicalMediaId
          ) {
            return false;
          }
          item.canonicalMediaId = target.canonicalMediaId;
          return true;
        });
        if (changedEvidence.length > 0) {
          await evidenceRepository.save(changedEvidence);
        }
      },
      provider,
      scope,
      snapshotEpoch
    );
  }

  private async hydrateJellyfin(): Promise<HydrationSourceSummary> {
    const settings = this.dependencies.jellyfinSettings();
    const scope = settings.serverId || 'configured-server';
    const summary = emptySummary('jellyfin', scope);
    const started = this.dependencies.now().getTime();
    const run = await this.beginRun('jellyfin', scope);
    const heartbeat = this.runCoordinator.heartbeat(run.id);
    const snapshotEpoch = await libraryHydrationEpoch.capture(
      'jellyfin',
      scope
    );
    let failure: unknown;
    try {
      const context = await this.dependencies.createJellyfinContext();
      if (!context) {
        if (
          settings.apiKey &&
          settings.libraries.some(({ enabled }) => enabled)
        ) {
          throw new Error('Configured Jellyfin context is unavailable.');
        }
        summary.complete = true;
        return summary;
      }
      const enabledLibraries = context.libraries.filter(
        ({ enabled }) => enabled
      );
      if (enabledLibraries.length === 0) {
        summary.complete = true;
        return summary;
      }
      const libraryItems = await mapBounded(
        enabledLibraries,
        SOURCE_CONCURRENCY,
        async (library) =>
          context.client.getAllItems(
            {
              parentId: library.id,
              recursive: true,
              includeItemTypes: ['Movie', 'Series', 'Episode'],
              fields: ['ProviderIds', 'Path', 'DateCreated'],
            },
            JELLYFIN_PAGE_SIZE,
            () => summary.apiCalls++
          )
      );
      const items = [
        ...new Map(
          libraryItems.flat().map((item) => [item.Id, item] as const)
        ).values(),
      ];
      summary.mediaInspected = items.length;
      const seenPresenceIds = new Set<number>();
      const visibleCanonicalIds = new Set<number>();
      const jellyfinSeries = new Map<string, CanonicalMedia>();
      const jellyfinCanonicalTargets = new Map<
        string,
        { canonicalMediaId: number; mediaType: LibraryMediaType }
      >();

      for (const item of items.filter(({ Type }) => Type !== 'Episode')) {
        const mediaType =
          item.Type === 'Movie'
            ? LibraryMediaType.MOVIE
            : LibraryMediaType.SERIES;
        const canonical = await this.resolveCanonical({
          mediaType,
          run,
          sourceSystem: 'jellyfin',
          scope,
          identities: [
            {
              provider: 'tmdb',
              value: item.ProviderIds?.Tmdb || item.ProviderIds?.TheMovieDb,
            },
            { provider: 'tvdb', value: item.ProviderIds?.Tvdb },
            { provider: 'imdb', value: item.ProviderIds?.Imdb },
            { provider: 'jellyfin', sourceScope: scope, value: item.Id },
          ],
          summary,
          snapshotEpoch,
        });
        if (!canonical) continue;
        jellyfinCanonicalTargets.set(item.Id, {
          canonicalMediaId: canonical.id,
          mediaType,
        });
        visibleCanonicalIds.add(canonical.id);
        if (item.Type === 'Series') jellyfinSeries.set(item.Id, canonical);
        const presence = await this.ensurePresence({
          canonical,
          sourceSystem: 'jellyfin',
          scope,
          sourceItemId: `${mediaType}:${item.Id}`,
          path: item.Path ?? null,
          addedAt: safeDate(item.DateCreated),
          addedAtSource: item.DateCreated ? 'jellyfin-date-created' : null,
          servarrManaged: null,
          servarrHasFile: null,
          jellyfinVisible: true,
          run,
          summary,
          snapshotEpoch,
        });
        seenPresenceIds.add(presence.id);
      }

      for (const item of items.filter(({ Type }) => Type === 'Episode')) {
        const series = item.SeriesId
          ? jellyfinSeries.get(item.SeriesId)
          : undefined;
        if (
          !series ||
          item.ParentIndexNumber === undefined ||
          item.IndexNumber === undefined
        ) {
          summary.unresolved++;
          continue;
        }
        const season = await getRepository(CanonicalSeason).findOneBy({
          seriesId: series.id,
          seasonNumber: item.ParentIndexNumber,
        });
        if (!season) {
          summary.unresolved++;
          continue;
        }
        const episode = await getRepository(CanonicalEpisode).findOneBy({
          seasonId: season.id,
          episodeNumber: item.IndexNumber,
        });
        if (!episode) {
          summary.unresolved++;
          continue;
        }
        const identities = exactIdentities([
          { provider: 'tvdb', value: item.ProviderIds?.Tvdb },
          { provider: 'jellyfin', sourceScope: scope, value: item.Id },
        ]);
        await this.withOwnedRun(
          run,
          async (manager) => {
            const repository = manager.getRepository(CanonicalEpisodeIdentity);
            const existingIdentities = await Promise.all(
              identities.map((identity) =>
                repository.findOneBy({
                  provider: identity.provider,
                  sourceScope: identity.sourceScope ?? '',
                  value: String(identity.value),
                })
              )
            );
            if (
              existingIdentities.some(
                (identity) =>
                  identity && identity.canonicalEpisodeId !== episode.id
              )
            ) {
              summary.conflicts++;
              return;
            }
            for (const identity of identities) {
              const existing = await repository.findOneBy({
                provider: identity.provider,
                sourceScope: identity.sourceScope ?? '',
                value: String(identity.value),
              });
              if (existing && existing.canonicalEpisodeId !== episode.id) {
                summary.conflicts++;
              } else if (!existing) {
                await repository.save(
                  new CanonicalEpisodeIdentity({
                    canonicalEpisodeId: episode.id,
                    provider: identity.provider,
                    sourceScope: identity.sourceScope ?? '',
                    value: String(identity.value),
                  })
                );
                summary.aliasesCreated++;
              } else {
                summary.aliasesResolved++;
              }
            }
          },
          'jellyfin',
          scope,
          snapshotEpoch
        );
      }

      await this.reconcileScopedMediaHistory(
        'jellyfin',
        scope,
        jellyfinCanonicalTargets,
        run,
        summary,
        snapshotEpoch
      );

      await this.withOwnedRun(
        run,
        async (manager) => {
          const presenceRepository = manager.getRepository(LibraryPresence);
          const currentServarr = await presenceRepository.findBy({
            sourceSystem: In(['radarr', 'sonarr']),
            isCurrent: true,
          });
          for (const presence of currentServarr) {
            presence.jellyfinVisible = visibleCanonicalIds.has(
              presence.canonicalMediaId
            );
            presence.reconciliationState = presence.jellyfinVisible
              ? LibraryReconciliationState.CURRENT
              : LibraryReconciliationState.PENDING;
            await presenceRepository.save(presence);
          }
        },
        'jellyfin',
        scope,
        snapshotEpoch
      );
      await this.closeMissing(
        'jellyfin',
        scope,
        seenPresenceIds,
        new Set(),
        run,
        summary,
        snapshotEpoch
      );
      summary.complete = true;
      return summary;
    } catch (error) {
      failure = error;
      return summary;
    } finally {
      await heartbeat.stop();
      summary.durationMs = this.dependencies.now().getTime() - started;
      await this.finishRun(
        run,
        summary,
        summary.complete ? undefined : failure
      );
    }
  }

  private async hydrateSeerr(): Promise<HydrationSourceSummary> {
    const scope = 'local';
    const summary = emptySummary('seerr', scope);
    const started = this.dependencies.now().getTime();
    const run = await this.beginRun('seerr', scope);
    const heartbeat = this.runCoordinator.heartbeat(run.id);
    let failure: unknown;
    try {
      const media = await getRepository(Media).find({
        relations: ['requests'],
      });
      summary.mediaInspected = media.length;
      summary.requestsInspected = media.reduce(
        (total, current) => total + (current.requests?.length ?? 0),
        0
      );
      for (const current of media) {
        const mediaType =
          current.mediaType === MediaType.MOVIE
            ? LibraryMediaType.MOVIE
            : LibraryMediaType.SERIES;
        const identities = exactIdentities([
          { provider: 'tmdb', value: current.tmdbId },
          { provider: 'tvdb', value: current.tvdbId },
          { provider: 'imdb', value: current.imdbId },
        ]);
        await this.withOwnedRun(run, async (manager) => {
          const identityRepository = manager.getRepository(
            CanonicalMediaIdentity
          );
          const matches = await Promise.all(
            identities.map(({ provider, value }) =>
              identityRepository.findOneBy({
                provider,
                sourceScope: '',
                mediaType,
                value: String(value),
              })
            )
          );
          const canonicalIds = [
            ...new Set(
              matches.flatMap((match) => match?.canonicalMediaId ?? [])
            ),
          ];
          if (canonicalIds.length === 0) {
            summary.unresolved++;
            return;
          }
          if (canonicalIds.length > 1) {
            summary.mediaLinksConflicting++;
            summary.conflicts++;
            return;
          }
          const canonicalRepository = manager.getRepository(CanonicalMedia);
          const canonical = await canonicalRepository.findOneByOrFail({
            id: canonicalIds[0],
          });
          if (
            canonical.currentMediaId !== null &&
            canonical.currentMediaId !== undefined &&
            canonical.currentMediaId !== current.id
          ) {
            summary.mediaLinksConflicting++;
            return;
          }
          canonical.currentMediaId = current.id;
          await canonicalRepository.save(canonical);
          for (let index = 0; index < identities.length; index++) {
            if (matches[index]) continue;
            await identityRepository.save(
              new CanonicalMediaIdentity({
                canonicalMediaId: canonical.id,
                mediaType,
                provider: identities[index].provider,
                sourceScope: '',
                value: String(identities[index].value),
              })
            );
            summary.aliasesCreated++;
          }
          summary.mediaLinksResolved++;
          summary.requestsLinked += current.requests?.length ?? 0;
        });
      }
      summary.requestsUnresolved =
        summary.requestsInspected - summary.requestsLinked;
      summary.complete = true;
      return summary;
    } catch (error) {
      failure = error;
      return summary;
    } finally {
      await heartbeat.stop();
      summary.durationMs = this.dependencies.now().getTime() - started;
      await this.finishRun(
        run,
        summary,
        summary.complete ? undefined : failure
      );
    }
  }

  private async hydrateQueryMetadata(): Promise<QueryMetadataSummary> {
    const started = this.dependencies.now().getTime();
    const summary: QueryMetadataSummary = {
      uniqueProviderIdentities: 0,
      enriched: 0,
      aliasesCreated: 0,
      conflicts: 0,
      failures: 0,
      durationMs: 0,
      concurrency: SOURCE_CONCURRENCY,
    };
    const canonical = await getRepository(CanonicalMedia).find();
    if (canonical.length === 0) {
      summary.durationMs = this.dependencies.now().getTime() - started;
      return summary;
    }
    const identities = await getRepository(CanonicalMediaIdentity).findBy({
      canonicalMediaId: In(canonical.map(({ id }) => id)),
    });
    const client = this.dependencies.createQueryMetadataClient();
    const targets = canonical
      .map((media) => {
        const exact = identities.filter(
          (identity) => identity.canonicalMediaId === media.id
        );
        const value = (provider: string) =>
          exact.find(
            (identity) =>
              identity.provider === provider && identity.sourceScope === ''
          )?.value;
        const tmdbId = Number(value('tmdb'));
        const tvdbId = Number(value('tvdb'));
        const imdbId = value('imdb');
        if (
          !(Number.isSafeInteger(tmdbId) && tmdbId > 0) &&
          !(
            media.mediaType === LibraryMediaType.SERIES &&
            Number.isSafeInteger(tvdbId) &&
            tvdbId > 0
          ) &&
          !imdbId
        ) {
          return null;
        }
        return {
          media,
          tmdbId: Number.isSafeInteger(tmdbId) && tmdbId > 0 ? tmdbId : null,
          tvdbId: Number.isSafeInteger(tvdbId) && tvdbId > 0 ? tvdbId : null,
          imdbId: imdbId ?? null,
        };
      })
      .filter((target): target is NonNullable<typeof target> =>
        Boolean(target)
      );
    summary.uniqueProviderIdentities = targets.length;

    const fetched = await mapBounded(
      targets,
      SOURCE_CONCURRENCY,
      async (target) => {
        try {
          let tmdbId = target.tmdbId;
          if (!tmdbId && target.media.mediaType === LibraryMediaType.SERIES) {
            if (target.tvdbId) {
              const details = await client.getShowByTvdbIdForScan({
                tvdbId: target.tvdbId,
                language: 'en',
              });
              return {
                target,
                tmdbId: details.id,
                title: details.name,
                year: providerYear(details.first_air_date),
              };
            }
            tmdbId = await client.resolveImdbIdForScan({
              imdbId: target.imdbId!,
            });
          } else if (!tmdbId) {
            tmdbId = await client.resolveImdbIdForScan({
              imdbId: target.imdbId!,
            });
          }
          if (target.media.mediaType === LibraryMediaType.MOVIE) {
            const details = await client.getMovieForScan({
              movieId: tmdbId,
              language: 'en',
            });
            return {
              target,
              tmdbId: details.id,
              title: details.title,
              year: providerYear(details.release_date),
            };
          }
          const details = await client.getTvShowForScan({
            tvId: tmdbId,
            language: 'en',
          });
          return {
            target,
            tmdbId: details.id,
            title: details.name,
            year: providerYear(details.first_air_date),
          };
        } catch {
          summary.failures++;
          return null;
        }
      }
    );

    const canonicalRepository = getRepository(CanonicalMedia);
    const identityRepository = getRepository(CanonicalMediaIdentity);
    for (const result of fetched) {
      if (!result) continue;
      const title = result.title.trim();
      if (!title) {
        summary.failures++;
        continue;
      }
      const existingTmdb = await identityRepository.findOneBy({
        provider: 'tmdb',
        sourceScope: '',
        mediaType: result.target.media.mediaType,
        value: String(result.tmdbId),
      });
      if (
        existingTmdb &&
        existingTmdb.canonicalMediaId !== result.target.media.id
      ) {
        summary.conflicts++;
        continue;
      }
      if (!existingTmdb) {
        await identityRepository.save(
          new CanonicalMediaIdentity({
            canonicalMediaId: result.target.media.id,
            mediaType: result.target.media.mediaType,
            provider: 'tmdb',
            sourceScope: '',
            value: String(result.tmdbId),
          })
        );
        summary.aliasesCreated++;
      }
      result.target.media.titleSnapshot = title;
      result.target.media.year = result.year;
      await canonicalRepository.save(result.target.media);
      summary.enriched++;
    }
    summary.durationMs = this.dependencies.now().getTime() - started;
    return summary;
  }
}

const libraryHistoryHydration = new LibraryHistoryHydrationService();

export default libraryHistoryHydration;
