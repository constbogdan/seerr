import type { RadarrMovie } from '@server/api/servarr/radarr';
import RadarrAPI from '@server/api/servarr/radarr';
import type {
  SonarrEpisode,
  SonarrEpisodeFile,
  SonarrSeries,
} from '@server/api/servarr/sonarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  LibraryMediaType,
  LibraryReconciliationState,
  LibraryRemovalSource,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
  CanonicalSeasonIdentity,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import backgroundDatabaseWriteCoordinator, {
  type BackgroundDatabaseWriteCoordinator,
} from '@server/lib/backgroundDatabaseWriteCoordinator';
import type {
  ConfirmedServarrImport,
  EpisodeNumberResult,
} from '@server/lib/downloadtracker';
import {
  CurrentLibraryGenerationService,
  LibraryHydrationEpochChangedError,
  LibraryHydrationEpochService,
} from '@server/lib/libraryHydrationEpoch';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { DataSource, EntityManager } from 'typeorm';

export const LIBRARY_TARGETED_REFRESH_DEBOUNCE_MS = 3_000;
export const LIBRARY_TARGETED_REFRESH_RETRY_MS = 15_000;
export const LIBRARY_TARGETED_REFRESH_MAX_RETRY_MS = 60_000;
export const LIBRARY_TARGETED_REFRESH_ACTIVE_WINDOW_MS = 4 * 60_000;
export const LIBRARY_TARGETED_REFRESH_CONCURRENCY = 3;
const COMPLETED_GENERATION_CACHE_LIMIT = 1_000;

type Provider = 'radarr' | 'sonarr';
type ServarrSettings = RadarrSettings | SonarrSettings;

export class LibraryTargetedIdentityConflictError extends Error {}
export class LibraryTargetedNotReadyError extends Error {}
export class LibraryTargetedMalformedSnapshotError extends Error {}

interface TargetedFences {
  generation: number;
  epochs: Map<string, number>;
}

export interface LibraryTargetedRefreshTarget {
  key: string;
  provider: Provider;
  physicalServerKey: string;
  externalId: number;
  servers: ServarrSettings[];
  downloadIds: string[];
  episodes: EpisodeNumberResult[];
}

interface PendingTarget extends LibraryTargetedRefreshTarget {
  attempts: number;
  nextAttemptAt: number;
  expiresAt: number;
  revision: number;
}

type PendingSnapshot = PendingTarget;

export interface LibraryTargetedRefreshResult {
  state: 'updated' | 'unchanged';
  providerCalls: number;
  rowsChanged: number;
}

export interface LibraryTargetedRefreshStatus {
  pendingTargets: number;
  running: boolean;
  signalsReceived: number;
  targetsQueued: number;
  coalescedSignals: number;
  providerReads: number;
  updatedTargets: number;
  unchangedTargets: number;
  retries: number;
  terminalFailures: number;
  identityConflicts: number;
  supersededSnapshots: number;
  rowsChanged: number;
}

interface RadarrTargetedClient {
  getMovie(input: { id: number }): Promise<RadarrMovie>;
}

interface SonarrTargetedClient {
  getSeriesById(id: number): Promise<SonarrSeries>;
  getEpisodes(seriesId: number): Promise<SonarrEpisode[]>;
  getEpisodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]>;
}

interface TargetedRefreshDependencies {
  radarrServers(): RadarrSettings[];
  sonarrServers(): SonarrSettings[];
  createRadarrClient(server: RadarrSettings): RadarrTargetedClient;
  createSonarrClient(server: SonarrSettings): SonarrTargetedClient;
  refreshTarget(
    target: LibraryTargetedRefreshTarget,
    onProviderRead: (count?: number) => void
  ): Promise<LibraryTargetedRefreshResult>;
  setTimer(callback: () => void, delay: number): NodeJS.Timeout;
  clearTimer(timer: NodeJS.Timeout): void;
  now(): number;
  concurrency: number;
}

interface MovieSnapshot {
  provider: 'radarr';
  movie: RadarrMovie;
}

interface SeriesSnapshot {
  provider: 'sonarr';
  series: SonarrSeries;
  episodes: SonarrEpisode[];
  files: SonarrEpisodeFile[];
}

type ProviderSnapshot = MovieSnapshot | SeriesSnapshot;

const sourceScope = (serviceId: number): string => `service:${serviceId}`;

const normalizedBaseUrl = (value?: string): string => {
  const normalized = (value ?? '').trim().replaceAll('\\', '/');
  if (!normalized || normalized === '/') return '';
  return `/${normalized.replace(/^\/+|\/+$/g, '').toLowerCase()}`;
};

export const servarrPhysicalServerKey = (server: ServarrSettings): string =>
  `${server.useSsl ? 'https' : 'http'}://${server.hostname
    .trim()
    .toLowerCase()}:${server.port}${normalizedBaseUrl(server.baseUrl)}`;

const safeDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizePath = (value?: string | null): string =>
  (value ?? '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

const resolution = (
  file?: {
    quality?: { quality?: { resolution?: number | null } | null } | null;
  } | null
): number | null => {
  const value = file?.quality?.quality?.resolution;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
};

const generationKey = (
  target: Pick<LibraryTargetedRefreshTarget, 'key'>,
  downloadId: string
): string => `${target.key}:${downloadId}`;

const episodeKey = (episode: EpisodeNumberResult): string =>
  `${episode.seasonNumber}:${episode.episodeNumber}:${episode.id}`;

const uniqueServers = <T extends ServarrSettings>(servers: T[]): T[] => [
  ...new Map(servers.map((server) => [server.id, server])).values(),
];

const mergeTarget = (
  existing: LibraryTargetedRefreshTarget | undefined,
  incoming: LibraryTargetedRefreshTarget
): LibraryTargetedRefreshTarget => ({
  ...incoming,
  servers: uniqueServers([...(existing?.servers ?? []), ...incoming.servers]),
  downloadIds: [
    ...new Set([...(existing?.downloadIds ?? []), ...incoming.downloadIds]),
  ],
  episodes: [
    ...new Map(
      [...(existing?.episodes ?? []), ...incoming.episodes].map((episode) => [
        episodeKey(episode),
        episode,
      ])
    ).values(),
  ],
});

export class LibraryTargetedPersistence {
  private readonly epochs: LibraryHydrationEpochService;
  private readonly generation: CurrentLibraryGenerationService;

  constructor(
    private readonly connection: DataSource = dataSource,
    private readonly writeCoordinator: BackgroundDatabaseWriteCoordinator = backgroundDatabaseWriteCoordinator,
    private readonly now: () => Date = () => new Date()
  ) {
    this.epochs = new LibraryHydrationEpochService(connection);
    this.generation = new CurrentLibraryGenerationService(this.epochs);
  }

  public async capture(
    target: LibraryTargetedRefreshTarget
  ): Promise<TargetedFences> {
    return this.writeCoordinator.runExclusive(() =>
      this.connection.transaction('SERIALIZABLE', async (manager) => {
        const generation = await this.generation.capture(manager);
        const epochs = new Map<string, number>();
        for (const server of [...target.servers].sort((a, b) => a.id - b.id)) {
          const scope = sourceScope(server.id);
          epochs.set(
            scope,
            await this.epochs.capture(target.provider, scope, manager)
          );
        }
        return { generation, epochs };
      })
    );
  }

  public async persist(
    target: LibraryTargetedRefreshTarget,
    snapshot: ProviderSnapshot,
    fences: TargetedFences
  ): Promise<number> {
    return this.writeCoordinator.runExclusive(() =>
      this.connection.transaction('SERIALIZABLE', async (manager) => {
        await this.generation.assert(manager, fences.generation);
        for (const [scope, epoch] of [...fences.epochs].sort(([a], [b]) =>
          a.localeCompare(b)
        )) {
          await this.epochs.assert(manager, target.provider, scope, epoch);
        }

        const changedScopes = new Set<string>();
        let rowsChanged = 0;
        if (snapshot.provider === 'radarr') {
          rowsChanged = await this.persistMovie(
            manager,
            target,
            snapshot.movie,
            changedScopes
          );
        } else {
          rowsChanged = await this.persistSeries(
            manager,
            target,
            snapshot,
            changedScopes
          );
        }

        if (rowsChanged > 0) {
          for (const scope of [...changedScopes].sort()) {
            await this.epochs.advance(manager, target.provider, scope);
          }
          await this.generation.advance(manager);
        }
        return rowsChanged;
      })
    );
  }

  private async resolveCanonical(
    manager: EntityManager,
    mediaType: LibraryMediaType,
    identities: { provider: string; sourceScope: string; value: string }[]
  ): Promise<{ canonical: CanonicalMedia; rowsChanged: number }> {
    const identityRepository = manager.getRepository(CanonicalMediaIdentity);
    const matches = await Promise.all(
      identities.map((identity) =>
        identityRepository.findOneBy({ ...identity, mediaType })
      )
    );
    const canonicalIds = [
      ...new Set(
        matches.flatMap((identity) => identity?.canonicalMediaId ?? [])
      ),
    ];
    if (canonicalIds.length > 1) {
      throw new LibraryTargetedIdentityConflictError(
        'Exact provider identities resolve to different canonical media'
      );
    }

    const canonicalRepository = manager.getRepository(CanonicalMedia);
    let canonical: CanonicalMedia;
    let rowsChanged = 0;
    if (canonicalIds.length) {
      canonical = await canonicalRepository.findOneByOrFail({
        id: canonicalIds[0],
      });
      if (canonical.mediaType !== mediaType) {
        throw new LibraryTargetedIdentityConflictError(
          'Exact provider identity has the wrong media type'
        );
      }
    } else {
      canonical = await canonicalRepository.save(
        new CanonicalMedia({
          mediaType,
          titleSnapshot: null,
          year: null,
        })
      );
      rowsChanged += 1;
    }

    for (let index = 0; index < identities.length; index += 1) {
      const existing = matches[index];
      if (existing) {
        if (existing.canonicalMediaId !== canonical.id) {
          throw new LibraryTargetedIdentityConflictError(
            'Exact provider identity changed canonical ownership'
          );
        }
        continue;
      }
      await identityRepository.save(
        new CanonicalMediaIdentity({
          canonicalMediaId: canonical.id,
          mediaType,
          ...identities[index],
        })
      );
      rowsChanged += 1;
    }
    return { canonical, rowsChanged };
  }

  private async linkMedia(
    manager: EntityManager,
    canonical: CanonicalMedia,
    mediaType: LibraryMediaType,
    tmdbId?: number,
    tvdbId?: number
  ): Promise<number> {
    const media =
      mediaType === LibraryMediaType.MOVIE
        ? await manager.getRepository(Media).findBy({
            mediaType: MediaType.MOVIE,
            tmdbId,
          })
        : await manager.getRepository(Media).findBy({
            mediaType: MediaType.TV,
            tvdbId,
          });
    if (media.length > 1) {
      throw new LibraryTargetedIdentityConflictError(
        'Multiple Seerr media rows match the exact provider identity'
      );
    }
    const match = media[0];
    if (!match || canonical.currentMediaId === match.id) return 0;
    if (canonical.currentMediaId) {
      throw new LibraryTargetedIdentityConflictError(
        'Canonical media is linked to a different Seerr media row'
      );
    }
    canonical.currentMediaId = match.id;
    await manager.getRepository(CanonicalMedia).save(canonical);
    return 1;
  }

  private async findRoot(
    manager: EntityManager,
    provider: Provider,
    serviceId: number,
    path?: string | null
  ): Promise<StorageRoot | undefined> {
    const normalized = normalizePath(path);
    const roots = await manager.getRepository(StorageRoot).findBy({
      servarrType: provider,
      serviceId,
    });
    return roots
      .filter((root) => {
        const rootPath = normalizePath(root.pathSnapshot);
        return (
          rootPath &&
          (normalized === rootPath || normalized.startsWith(`${rootPath}/`))
        );
      })
      .sort(
        (left, right) =>
          normalizePath(right.pathSnapshot).length -
          normalizePath(left.pathSnapshot).length
      )[0];
  }

  private async ensurePresence(
    manager: EntityManager,
    input: {
      canonicalId: number;
      provider: Provider;
      scope: string;
      sourceItemId: string;
      root?: StorageRoot;
      path?: string | null;
      logicalSizeBytes: string;
      addedAt?: Date | null;
      addedAtSource: string;
      hasFile: boolean;
    }
  ): Promise<{ presence: LibraryPresence; changed: number }> {
    const repository = manager.getRepository(LibraryPresence);
    const current = await repository.findBy({
      sourceSystem: input.provider,
      sourceScope: input.scope,
      sourceItemId: input.sourceItemId,
      isCurrent: true,
    });
    if (current.length > 1) {
      throw new LibraryTargetedIdentityConflictError(
        'Multiple current presences share one provider identity'
      );
    }
    let presence = current[0];
    if (presence && presence.canonicalMediaId !== input.canonicalId) {
      throw new LibraryTargetedIdentityConflictError(
        'Provider presence is attached to another canonical item'
      );
    }
    const now = this.now();
    if (!presence) {
      const prior = await repository.countBy({
        sourceSystem: input.provider,
        sourceScope: input.scope,
        sourceItemId: input.sourceItemId,
      });
      presence = await repository.save(
        new LibraryPresence({
          canonicalMediaId: input.canonicalId,
          sourceSystem: input.provider,
          sourceScope: input.scope,
          sourceItemId: input.sourceItemId,
          sourceGeneration: String(prior + 1),
          storageRootId: input.root?.id ?? null,
          pathSnapshot: input.path ?? null,
          logicalSizeBytes: input.logicalSizeBytes,
          addedAt: input.addedAt ?? null,
          addedAtSource: input.addedAt ? input.addedAtSource : null,
          addedAtConfidence: input.addedAt ? 'exact' : null,
          firstObservedAt: now,
          lastSeenAt: now,
          removedAt: null,
          servarrManaged: true,
          servarrHasFile: input.hasFile,
          isCurrent: true,
          reconciliationState: LibraryReconciliationState.CURRENT,
        })
      );
      return { presence, changed: 1 };
    }

    const nextRootId = input.root?.id ?? presence.storageRootId ?? null;
    let changed =
      presence.storageRootId !== nextRootId ||
      (presence.pathSnapshot ?? null) !== (input.path ?? null) ||
      (presence.logicalSizeBytes ?? null) !== input.logicalSizeBytes ||
      presence.servarrManaged !== true ||
      presence.servarrHasFile !== input.hasFile ||
      presence.reconciliationState !== LibraryReconciliationState.CURRENT;
    if (!presence.addedAt && input.addedAt) changed = true;
    if (!changed) return { presence, changed: 0 };

    presence.storageRootId = nextRootId;
    presence.pathSnapshot = input.path ?? null;
    presence.logicalSizeBytes = input.logicalSizeBytes;
    if (!presence.addedAt && input.addedAt) {
      presence.addedAt = input.addedAt;
      presence.addedAtSource = input.addedAtSource;
      presence.addedAtConfidence = 'exact';
    }
    presence.lastSeenAt = now;
    presence.removedAt = null;
    presence.isCurrent = true;
    presence.servarrManaged = true;
    presence.servarrHasFile = input.hasFile;
    presence.reconciliationState = LibraryReconciliationState.CURRENT;
    presence = await repository.save(presence);
    return { presence, changed: 1 };
  }

  private async ensureFile(
    manager: EntityManager,
    input: {
      presence: LibraryPresence;
      provider: Provider;
      scope: string;
      sourceFileId: string;
      root?: StorageRoot;
      path?: string | null;
      size: number;
      resolution: number | null;
      importedAt: Date | null;
      canonicalEpisodeIds?: number[];
    }
  ): Promise<{ file: LibraryFile; changed: number }> {
    const repository = manager.getRepository(LibraryFile);
    const current = await repository.findBy({
      sourceSystem: input.provider,
      sourceScope: input.scope,
      sourceFileId: input.sourceFileId,
      isCurrent: true,
    });
    if (
      current.length > 1 ||
      (current[0] && current[0].libraryPresenceId !== input.presence.id)
    ) {
      throw new LibraryTargetedIdentityConflictError(
        'Current provider file belongs to another presence'
      );
    }
    let file = current[0];
    const now = this.now();
    let changed = 0;
    if (!file) {
      const prior = await repository.countBy({
        sourceSystem: input.provider,
        sourceScope: input.scope,
        sourceFileId: input.sourceFileId,
      });
      file = await repository.save(
        new LibraryFile({
          libraryPresenceId: input.presence.id,
          sourceSystem: input.provider,
          sourceScope: input.scope,
          sourceFileId: input.sourceFileId,
          sourceGeneration: String(prior + 1),
          storageRootId: input.root?.id ?? null,
          pathSnapshot: input.path ?? null,
          sizeBytes: String(input.size),
          resolution: input.resolution,
          importedAt: input.importedAt,
          importedAtSource: input.importedAt
            ? `${input.provider}-file-date-added`
            : null,
          importedAtConfidence: input.importedAt ? 'exact' : null,
          firstObservedAt: now,
          lastSeenAt: now,
          removedAt: null,
          isCurrent: true,
        })
      );
      changed += 1;
    } else {
      const nextRootId = input.root?.id ?? file.storageRootId ?? null;
      const shouldSave =
        file.storageRootId !== nextRootId ||
        (file.pathSnapshot ?? null) !== (input.path ?? null) ||
        file.sizeBytes !== String(input.size) ||
        (file.resolution ?? null) !== input.resolution ||
        (!file.importedAt && Boolean(input.importedAt));
      if (shouldSave) {
        file.storageRootId = nextRootId;
        file.pathSnapshot = input.path ?? null;
        file.sizeBytes = String(input.size);
        file.resolution = input.resolution;
        if (!file.importedAt && input.importedAt) {
          file.importedAt = input.importedAt;
          file.importedAtSource = `${input.provider}-file-date-added`;
          file.importedAtConfidence = 'exact';
        }
        file.lastSeenAt = now;
        file = await repository.save(file);
        changed += 1;
      }
    }

    if (input.canonicalEpisodeIds) {
      const links = manager.getRepository(LibraryFileEpisode);
      const expected = new Set(input.canonicalEpisodeIds);
      const existing = await links.findBy({ libraryFileId: file.id });
      for (const link of existing) {
        if (expected.has(link.canonicalEpisodeId)) continue;
        await links.delete({
          libraryFileId: file.id,
          canonicalEpisodeId: link.canonicalEpisodeId,
        });
        changed += 1;
      }
      const existingIds = new Set(
        existing.map(({ canonicalEpisodeId }) => canonicalEpisodeId)
      );
      for (const canonicalEpisodeId of expected) {
        if (existingIds.has(canonicalEpisodeId)) continue;
        await links.save(
          new LibraryFileEpisode({
            libraryFileId: file.id,
            canonicalEpisodeId,
          })
        );
        changed += 1;
      }
    }
    return { file, changed };
  }

  private async closeSupersededFiles(
    manager: EntityManager,
    presence: LibraryPresence,
    seenIds: Set<number>
  ): Promise<number> {
    const repository = manager.getRepository(LibraryFile);
    const files = await repository.findBy({
      libraryPresenceId: presence.id,
      isCurrent: true,
    });
    let changed = 0;
    for (const file of files) {
      if (seenIds.has(file.id)) continue;
      file.isCurrent = false;
      file.removedAt = this.now();
      file.removalSource ??= LibraryRemovalSource.EXTERNAL;
      await repository.save(file);
      changed += 1;
    }
    return changed;
  }

  private async persistMovie(
    manager: EntityManager,
    target: LibraryTargetedRefreshTarget,
    movie: RadarrMovie,
    changedScopes: Set<string>
  ): Promise<number> {
    const identities = [
      { provider: 'tmdb', sourceScope: '', value: String(movie.tmdbId) },
      ...(movie.imdbId
        ? [{ provider: 'imdb', sourceScope: '', value: movie.imdbId }]
        : []),
      ...target.servers.map((server) => ({
        provider: 'radarr',
        sourceScope: sourceScope(server.id),
        value: String(movie.id),
      })),
    ];
    const resolved = await this.resolveCanonical(
      manager,
      LibraryMediaType.MOVIE,
      identities
    );
    let rowsChanged = resolved.rowsChanged;
    rowsChanged += await this.linkMedia(
      manager,
      resolved.canonical,
      LibraryMediaType.MOVIE,
      movie.tmdbId
    );
    const file = movie.movieFile!;
    for (const server of target.servers) {
      const scope = sourceScope(server.id);
      const before = rowsChanged;
      const root = await this.findRoot(
        manager,
        'radarr',
        server.id,
        movie.rootFolderPath ?? movie.path
      );
      const presenceResult = await this.ensurePresence(manager, {
        canonicalId: resolved.canonical.id,
        provider: 'radarr',
        scope,
        sourceItemId: `movie:${movie.id}`,
        root,
        path: movie.path,
        logicalSizeBytes: String(file.size),
        addedAt: safeDate(file.dateAdded),
        addedAtSource: 'radarr-movie-file-date-added',
        hasFile: true,
      });
      rowsChanged += presenceResult.changed;
      const stored = await this.ensureFile(manager, {
        presence: presenceResult.presence,
        provider: 'radarr',
        scope,
        sourceFileId: `movie-file:${file.id}`,
        root,
        path:
          file.path ??
          (file.relativePath
            ? `${movie.path.replace(/[\\/]$/, '')}/${file.relativePath}`
            : null),
        size: file.size,
        resolution: resolution(file),
        importedAt: safeDate(file.dateAdded),
      });
      rowsChanged += stored.changed;
      rowsChanged += await this.closeSupersededFiles(
        manager,
        presenceResult.presence,
        new Set([stored.file.id])
      );
      if (rowsChanged > before) changedScopes.add(scope);
    }
    if (rowsChanged > 0 && changedScopes.size === 0) {
      target.servers.forEach((server) =>
        changedScopes.add(sourceScope(server.id))
      );
    }
    return rowsChanged;
  }

  private async ensureSeason(
    manager: EntityManager,
    seriesId: number,
    seasonNumber: number,
    scopes: string[],
    sourceSeriesId: number
  ): Promise<{ season: CanonicalSeason; changed: number }> {
    const repository = manager.getRepository(CanonicalSeason);
    let season = await repository.findOneBy({ seriesId, seasonNumber });
    let changed = 0;
    if (!season) {
      season = await repository.save(
        new CanonicalSeason({ seriesId, seasonNumber })
      );
      changed += 1;
    }
    const identities = manager.getRepository(CanonicalSeasonIdentity);
    for (const scope of scopes) {
      const value = `${sourceSeriesId}:${seasonNumber}`;
      const existing = await identities.findOneBy({
        provider: 'sonarr',
        sourceScope: scope,
        value,
      });
      if (existing && existing.canonicalSeasonId !== season.id) {
        throw new LibraryTargetedIdentityConflictError(
          'Sonarr Season identity belongs to another canonical Season'
        );
      }
      if (!existing) {
        await identities.save(
          new CanonicalSeasonIdentity({
            canonicalSeasonId: season.id,
            provider: 'sonarr',
            sourceScope: scope,
            value,
          })
        );
        changed += 1;
      }
    }
    return { season, changed };
  }

  private async ensureEpisode(
    manager: EntityManager,
    season: CanonicalSeason,
    episode: SonarrEpisode,
    scopes: string[]
  ): Promise<{ episode: CanonicalEpisode; changed: number }> {
    const repository = manager.getRepository(CanonicalEpisode);
    let stored = await repository.findOneBy({
      seasonId: season.id,
      episodeNumber: episode.episodeNumber,
    });
    let changed = 0;
    if (!stored) {
      stored = await repository.save(
        new CanonicalEpisode({
          seasonId: season.id,
          episodeNumber: episode.episodeNumber,
          airDate: episode.airDate || null,
          isSpecial: episode.seasonNumber === 0,
        })
      );
      changed += 1;
    } else {
      const nextAirDate = episode.airDate || stored.airDate || null;
      const nextSpecial = episode.seasonNumber === 0;
      if (stored.airDate !== nextAirDate || stored.isSpecial !== nextSpecial) {
        stored.airDate = nextAirDate;
        stored.isSpecial = nextSpecial;
        await repository.save(stored);
        changed += 1;
      }
    }
    const identityRepository = manager.getRepository(CanonicalEpisodeIdentity);
    const identities = [
      ...scopes.map((scope) => ({
        provider: 'sonarr',
        sourceScope: scope,
        value: String(episode.id),
      })),
      ...(episode.tvdbId
        ? [
            {
              provider: 'tvdb',
              sourceScope: '',
              value: String(episode.tvdbId),
            },
          ]
        : []),
    ];
    for (const identity of identities) {
      const existing = await identityRepository.findOneBy(identity);
      if (existing && existing.canonicalEpisodeId !== stored.id) {
        throw new LibraryTargetedIdentityConflictError(
          'Exact Episode identity belongs to another canonical Episode'
        );
      }
      if (!existing) {
        await identityRepository.save(
          new CanonicalEpisodeIdentity({
            canonicalEpisodeId: stored.id,
            ...identity,
          })
        );
        changed += 1;
      }
    }
    return { episode: stored, changed };
  }

  private async persistSeries(
    manager: EntityManager,
    target: LibraryTargetedRefreshTarget,
    snapshot: SeriesSnapshot,
    changedScopes: Set<string>
  ): Promise<number> {
    const { series, episodes, files } = snapshot;
    const scopes = target.servers.map(({ id }) => sourceScope(id));
    const identities = [
      { provider: 'tvdb', sourceScope: '', value: String(series.tvdbId) },
      ...(series.imdbId
        ? [{ provider: 'imdb', sourceScope: '', value: series.imdbId }]
        : []),
      ...scopes.map((scope) => ({
        provider: 'sonarr',
        sourceScope: scope,
        value: String(series.id),
      })),
    ];
    const resolved = await this.resolveCanonical(
      manager,
      LibraryMediaType.SERIES,
      identities
    );
    let rowsChanged = resolved.rowsChanged;
    rowsChanged += await this.linkMedia(
      manager,
      resolved.canonical,
      LibraryMediaType.SERIES,
      undefined,
      series.tvdbId
    );

    const seasonNumbers = new Set([
      ...series.seasons.map(({ seasonNumber }) => seasonNumber),
      ...episodes.map(({ seasonNumber }) => seasonNumber),
    ]);
    const seasons = new Map<number, CanonicalSeason>();
    for (const seasonNumber of [...seasonNumbers].sort((a, b) => a - b)) {
      const result = await this.ensureSeason(
        manager,
        resolved.canonical.id,
        seasonNumber,
        scopes,
        series.id!
      );
      seasons.set(seasonNumber, result.season);
      rowsChanged += result.changed;
    }
    const canonicalEpisodes = new Map<number, CanonicalEpisode>();
    for (const episode of episodes) {
      const season = seasons.get(episode.seasonNumber);
      if (!season) continue;
      const result = await this.ensureEpisode(manager, season, episode, scopes);
      canonicalEpisodes.set(episode.id, result.episode);
      rowsChanged += result.changed;
    }

    const distinctFiles = [
      ...new Map(files.map((file) => [file.id, file])).values(),
    ];
    const logicalSize = String(
      distinctFiles.reduce((total, file) => total + BigInt(file.size), 0n)
    );
    const importedAt = distinctFiles
      .map(({ dateAdded }) => safeDate(dateAdded))
      .filter((date): date is Date => Boolean(date))
      .sort((a, b) => a.getTime() - b.getTime())[0];

    for (const server of target.servers) {
      const scope = sourceScope(server.id);
      const before = rowsChanged;
      const root = await this.findRoot(
        manager,
        'sonarr',
        server.id,
        series.rootFolderPath ?? series.path
      );
      const presenceResult = await this.ensurePresence(manager, {
        canonicalId: resolved.canonical.id,
        provider: 'sonarr',
        scope,
        sourceItemId: `series:${series.id}`,
        root,
        path: series.path,
        logicalSizeBytes: logicalSize,
        addedAt: importedAt ?? null,
        addedAtSource: 'sonarr-episode-file-date-added',
        hasFile: distinctFiles.length > 0,
      });
      rowsChanged += presenceResult.changed;
      const seen = new Set<number>();
      for (const file of distinctFiles) {
        const linkedEpisodeIds = episodes
          .filter(({ episodeFileId }) => episodeFileId === file.id)
          .flatMap((episode) => {
            const canonical = canonicalEpisodes.get(episode.id);
            return canonical ? [canonical.id] : [];
          });
        const stored = await this.ensureFile(manager, {
          presence: presenceResult.presence,
          provider: 'sonarr',
          scope,
          sourceFileId: `episode-file:${file.id}`,
          root,
          path:
            file.path ??
            (file.relativePath
              ? `${series.path.replace(/[\\/]$/, '')}/${file.relativePath}`
              : null),
          size: file.size,
          resolution: resolution(file),
          importedAt: safeDate(file.dateAdded),
          canonicalEpisodeIds: linkedEpisodeIds,
        });
        seen.add(stored.file.id);
        rowsChanged += stored.changed;
      }
      rowsChanged += await this.closeSupersededFiles(
        manager,
        presenceResult.presence,
        seen
      );
      if (rowsChanged > before) changedScopes.add(scope);
    }
    if (rowsChanged > 0 && changedScopes.size === 0) {
      scopes.forEach((scope) => changedScopes.add(scope));
    }
    return rowsChanged;
  }
}

export class LibraryTargetedRefreshExecutor {
  constructor(
    private readonly dependencies: Pick<
      TargetedRefreshDependencies,
      'createRadarrClient' | 'createSonarrClient'
    >,
    private readonly persistence = new LibraryTargetedPersistence()
  ) {}

  public async refresh(
    target: LibraryTargetedRefreshTarget,
    onProviderRead: (count?: number) => void = () => undefined
  ): Promise<LibraryTargetedRefreshResult> {
    const fences = await this.persistence.capture(target);
    const snapshot = await this.readProvider(target, onProviderRead);
    const rowsChanged = await this.persistence.persist(
      target,
      snapshot,
      fences
    );
    return {
      state: rowsChanged > 0 ? 'updated' : 'unchanged',
      providerCalls: snapshot.provider === 'radarr' ? 1 : 3,
      rowsChanged,
    };
  }

  private async readProvider(
    target: LibraryTargetedRefreshTarget,
    onProviderRead: (count?: number) => void
  ): Promise<ProviderSnapshot> {
    const primary = target.servers[0];
    if (!primary) {
      throw new LibraryTargetedIdentityConflictError(
        'Confirmed import has no configured physical server'
      );
    }
    if (target.provider === 'radarr') {
      onProviderRead();
      const movie = await this.dependencies
        .createRadarrClient(primary as RadarrSettings)
        .getMovie({ id: target.externalId });
      if (
        movie.id !== target.externalId ||
        !Number.isSafeInteger(movie.tmdbId) ||
        movie.tmdbId <= 0
      ) {
        throw new LibraryTargetedIdentityConflictError(
          'Radarr returned an unexpected Movie identity'
        );
      }
      const file = movie.movieFile;
      if (!movie.hasFile || !file) {
        throw new LibraryTargetedNotReadyError(
          'Radarr has not exposed the imported Movie file yet'
        );
      }
      if (
        file.movieId !== movie.id ||
        !Number.isSafeInteger(file.id) ||
        file.id <= 0 ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
      ) {
        throw new LibraryTargetedMalformedSnapshotError(
          'Radarr Movie file relationship is malformed'
        );
      }
      return { provider: 'radarr', movie };
    }

    const client = this.dependencies.createSonarrClient(
      primary as SonarrSettings
    );
    onProviderRead();
    const series = await client.getSeriesById(target.externalId);
    if (
      series.id !== target.externalId ||
      !Number.isSafeInteger(series.tvdbId) ||
      series.tvdbId <= 0
    ) {
      throw new LibraryTargetedIdentityConflictError(
        'Sonarr returned an unexpected Series identity'
      );
    }
    // A target occupies one of the service's three provider-read slots. Keep
    // its Sonarr calls sequential so the configured target concurrency is
    // also the real HTTP-request concurrency ceiling.
    onProviderRead();
    const episodes = await client.getEpisodes(target.externalId);
    onProviderRead();
    const files = await client.getEpisodeFiles(target.externalId);
    if (!files.length) {
      throw new LibraryTargetedNotReadyError(
        'Sonarr has not exposed an Episode file for the imported Series yet'
      );
    }
    const episodeIds = new Set<number>();
    const fileIds = new Set<number>();
    for (const episode of episodes) {
      if (
        episode.seriesId !== target.externalId ||
        !Number.isSafeInteger(episode.id) ||
        episode.id <= 0 ||
        episodeIds.has(episode.id)
      ) {
        throw new LibraryTargetedMalformedSnapshotError(
          'Sonarr Episode relationship is malformed'
        );
      }
      episodeIds.add(episode.id);
    }
    for (const file of files) {
      if (
        file.seriesId !== target.externalId ||
        !Number.isSafeInteger(file.id) ||
        file.id <= 0 ||
        fileIds.has(file.id) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
      ) {
        throw new LibraryTargetedMalformedSnapshotError(
          'Sonarr Episode file relationship is malformed'
        );
      }
      fileIds.add(file.id);
    }
    if (
      target.episodes.length > 0 &&
      target.episodes.some((hint) => {
        const episode = episodes.find(({ id }) => id === hint.id);
        return (
          !episode ||
          !episode.hasFile ||
          !episode.episodeFileId ||
          !fileIds.has(episode.episodeFileId)
        );
      })
    ) {
      throw new LibraryTargetedNotReadyError(
        'Sonarr has not exposed every confirmed Episode import yet'
      );
    }
    if (
      files.some(
        (file) => !episodes.some((episode) => episode.episodeFileId === file.id)
      ) ||
      episodes.some(
        (episode) =>
          episode.hasFile &&
          (!episode.episodeFileId || !fileIds.has(episode.episodeFileId))
      )
    ) {
      throw new LibraryTargetedMalformedSnapshotError(
        'Sonarr Episode and EpisodeFile responses disagree'
      );
    }
    return { provider: 'sonarr', series, episodes, files };
  }
}

const defaultClientDependencies = {
  createRadarrClient: (server: RadarrSettings): RadarrTargetedClient =>
    new RadarrAPI({
      apiKey: server.apiKey,
      url: RadarrAPI.buildUrl(server, '/api/v3'),
    }),
  createSonarrClient: (server: SonarrSettings): SonarrTargetedClient =>
    new SonarrAPI({
      apiKey: server.apiKey,
      url: SonarrAPI.buildUrl(server, '/api/v3'),
    }),
};

const defaultExecutor = new LibraryTargetedRefreshExecutor(
  defaultClientDependencies
);

const defaultDependencies: TargetedRefreshDependencies = {
  radarrServers: () =>
    getSettings().radarr.filter(({ syncEnabled }) => syncEnabled),
  sonarrServers: () =>
    getSettings().sonarr.filter(({ syncEnabled }) => syncEnabled),
  ...defaultClientDependencies,
  refreshTarget: (target, onProviderRead) =>
    defaultExecutor.refresh(target, onProviderRead),
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  now: Date.now,
  concurrency: LIBRARY_TARGETED_REFRESH_CONCURRENCY,
};

export class LibraryTargetedRefreshService {
  private readonly pending = new Map<string, PendingTarget>();
  private readonly completedGenerations = new Set<string>();
  private timer?: NodeJS.Timeout;
  private timerDueAt?: number;
  private activeRun?: Promise<void>;
  private readonly dependencies: TargetedRefreshDependencies;
  private readonly status: LibraryTargetedRefreshStatus = {
    pendingTargets: 0,
    running: false,
    signalsReceived: 0,
    targetsQueued: 0,
    coalescedSignals: 0,
    providerReads: 0,
    updatedTargets: 0,
    unchangedTargets: 0,
    retries: 0,
    terminalFailures: 0,
    identityConflicts: 0,
    supersededSnapshots: 0,
    rowsChanged: 0,
  };

  constructor(dependencies: Partial<TargetedRefreshDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  public request(imports: ConfirmedServarrImport[]): void {
    const requestedAt = this.dependencies.now();
    this.status.signalsReceived += imports.length;
    const targets = this.resolveTargets(imports);
    for (const target of targets) {
      const outstanding = target.downloadIds.filter(
        (downloadId) =>
          !this.completedGenerations.has(generationKey(target, downloadId))
      );
      if (!outstanding.length) continue;
      target.downloadIds = outstanding;
      const existing = this.pending.get(target.key);
      const hasNewGeneration =
        !existing ||
        outstanding.some(
          (downloadId) => !existing.downloadIds.includes(downloadId)
        );
      if (existing) this.status.coalescedSignals += 1;
      else this.status.targetsQueued += 1;
      const merged = mergeTarget(existing, target);
      this.pending.set(target.key, {
        ...merged,
        attempts: existing?.attempts ?? 0,
        nextAttemptAt:
          existing?.nextAttemptAt ??
          requestedAt + LIBRARY_TARGETED_REFRESH_DEBOUNCE_MS,
        expiresAt:
          existing && !hasNewGeneration
            ? existing.expiresAt
            : Math.max(
                existing?.expiresAt ?? 0,
                requestedAt + LIBRARY_TARGETED_REFRESH_ACTIVE_WINDOW_MS
              ),
        revision: (existing?.revision ?? 0) + 1,
      });
    }
    this.updateRuntimeStatus();
    if (targets.length) {
      logger.info('Targeted Library Foundation refresh requested', {
        label: 'Library Targeted Refresh',
        confirmedImports: imports.length,
        distinctTargets: targets.length,
        pendingTargets: this.pending.size,
      });
      this.scheduleNext();
    }
  }

  public getStatus(): LibraryTargetedRefreshStatus {
    this.updateRuntimeStatus();
    return { ...this.status };
  }

  private resolveTargets(
    imports: ConfirmedServarrImport[]
  ): LibraryTargetedRefreshTarget[] {
    const targets = new Map<string, LibraryTargetedRefreshTarget>();
    for (const imported of imports) {
      const provider: Provider =
        imported.mediaType === MediaType.MOVIE ? 'radarr' : 'sonarr';
      const configured =
        provider === 'radarr'
          ? this.dependencies.radarrServers()
          : this.dependencies.sonarrServers();
      const aliasIds = new Set(imported.serverAliases.map(({ id }) => id));
      const matching = configured.filter((server) => aliasIds.has(server.id));
      const physicalGroups = new Map<string, ServarrSettings[]>();
      for (const server of matching) {
        const physicalKey = servarrPhysicalServerKey(server);
        physicalGroups.set(physicalKey, [
          ...(physicalGroups.get(physicalKey) ?? []),
          server,
        ]);
      }
      for (const [physicalServerKey, servers] of physicalGroups) {
        const key = `${provider}:${physicalServerKey}:${imported.externalId}`;
        const incoming: LibraryTargetedRefreshTarget = {
          key,
          provider,
          physicalServerKey,
          externalId: imported.externalId,
          servers: uniqueServers(servers),
          downloadIds: [imported.downloadId],
          episodes: imported.episodes,
        };
        targets.set(key, mergeTarget(targets.get(key), incoming));
      }
    }
    return [...targets.values()];
  }

  private scheduleNext(): void {
    if (this.activeRun || !this.pending.size) return;
    this.expireTargets();
    if (!this.pending.size) return;
    const dueAt = Math.min(
      ...[...this.pending.values()].flatMap((target) => [
        target.nextAttemptAt,
        target.expiresAt,
      ])
    );
    if (
      this.timer &&
      this.timerDueAt !== undefined &&
      this.timerDueAt <= dueAt
    ) {
      return;
    }
    if (this.timer) this.dependencies.clearTimer(this.timer);
    this.timerDueAt = dueAt;
    this.timer = this.dependencies.setTimer(
      () => {
        this.timer = undefined;
        this.timerDueAt = undefined;
        void this.run();
      },
      Math.max(0, dueAt - this.dependencies.now())
    );
  }

  private run(): Promise<void> {
    if (this.activeRun) return this.activeRun;
    this.expireTargets();
    const now = this.dependencies.now();
    const due = [...this.pending.entries()]
      .filter(([, target]) => target.nextAttemptAt <= now)
      .map(([key, target]) => ({ ...target, key }));
    if (!due.length) {
      this.scheduleNext();
      return Promise.resolve();
    }
    const run = this.reconcile(due).finally(() => {
      if (this.activeRun === run) this.activeRun = undefined;
      this.updateRuntimeStatus();
      this.scheduleNext();
    });
    this.activeRun = run;
    this.updateRuntimeStatus();
    return run;
  }

  private async reconcile(targets: PendingSnapshot[]): Promise<void> {
    const startedAt = this.dependencies.now();
    const groups = [
      ...new Map(
        targets.map((target) => [
          `${target.provider}:${target.physicalServerKey}`,
          targets.filter(
            (candidate) =>
              candidate.provider === target.provider &&
              candidate.physicalServerKey === target.physicalServerKey
          ),
        ])
      ).values(),
    ];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < groups.length) {
        const group = groups[cursor++];
        // Targets sharing one source are serialized so advancing that source's
        // epoch for one target cannot invalidate a sibling snapshot read in
        // parallel by this service.
        for (const target of group) await this.reconcileOne(target);
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.min(
            Math.max(1, this.dependencies.concurrency),
            groups.length
          ),
        },
        () => worker()
      )
    );
    this.expireTargets();
    logger.debug('Targeted Library Foundation refresh batch completed', {
      label: 'Library Targeted Refresh',
      targets: targets.length,
      physicalServers: groups.length,
      durationMs: this.dependencies.now() - startedAt,
      pendingTargets: this.pending.size,
    });
  }

  private async reconcileOne(target: PendingSnapshot): Promise<void> {
    const startedAt = this.dependencies.now();
    let observedProviderReads = 0;
    try {
      const result = await this.dependencies.refreshTarget(
        target,
        (count = 1) => {
          observedProviderReads += count;
          this.status.providerReads += count;
        }
      );
      if (observedProviderReads === 0) {
        this.status.providerReads += result.providerCalls;
      }
      this.status.rowsChanged += result.rowsChanged;
      if (result.state === 'updated') this.status.updatedTargets += 1;
      else this.status.unchangedTargets += 1;
      const current = this.pending.get(target.key);
      if (!current || current.revision !== target.revision) return;
      for (const downloadId of current.downloadIds) {
        this.rememberCompletedGeneration(generationKey(current, downloadId));
      }
      this.pending.delete(target.key);
      logger.info('Targeted Library Foundation refresh completed', {
        label: 'Library Targeted Refresh',
        provider: target.provider,
        providerMediaId: target.externalId,
        state: result.state,
        providerCalls: result.providerCalls,
        rowsChanged: result.rowsChanged,
        durationMs: this.dependencies.now() - startedAt,
      });
    } catch (error) {
      const current = this.pending.get(target.key);
      if (!current || current.revision !== target.revision) return;
      if (
        error instanceof LibraryTargetedIdentityConflictError ||
        error instanceof LibraryTargetedMalformedSnapshotError
      ) {
        this.pending.delete(target.key);
        this.status.terminalFailures += 1;
        if (error instanceof LibraryTargetedIdentityConflictError) {
          this.status.identityConflicts += 1;
        }
        logger.warn(
          'Targeted Library Foundation refresh rejected provider snapshot',
          {
            label: 'Library Targeted Refresh',
            provider: target.provider,
            providerMediaId: target.externalId,
            failureType: error.constructor.name,
          }
        );
        return;
      }
      if (error instanceof LibraryHydrationEpochChangedError) {
        this.status.supersededSnapshots += 1;
      }
      current.attempts += 1;
      const retryDelay = Math.min(
        LIBRARY_TARGETED_REFRESH_RETRY_MS * 2 ** (current.attempts - 1),
        LIBRARY_TARGETED_REFRESH_MAX_RETRY_MS
      );
      current.nextAttemptAt = this.dependencies.now() + retryDelay;
      this.status.retries += 1;
      logger.debug('Targeted Library Foundation refresh will retry', {
        label: 'Library Targeted Refresh',
        provider: target.provider,
        providerMediaId: target.externalId,
        failureType:
          error instanceof Error ? error.constructor.name : 'UnknownError',
        attempt: current.attempts,
        retryDelayMs: retryDelay,
        nextRetryAt: new Date(current.nextAttemptAt).toISOString(),
      });
    }
  }

  private expireTargets(): void {
    const now = this.dependencies.now();
    for (const [key, target] of this.pending) {
      if (target.expiresAt > now) continue;
      this.pending.delete(key);
      this.status.terminalFailures += 1;
      logger.warn(
        'Targeted Library Foundation refresh exhausted its retry window',
        {
          label: 'Library Targeted Refresh',
          provider: target.provider,
          providerMediaId: target.externalId,
          attempts: target.attempts,
        }
      );
    }
    this.updateRuntimeStatus();
  }

  private rememberCompletedGeneration(key: string): void {
    this.completedGenerations.add(key);
    if (this.completedGenerations.size <= COMPLETED_GENERATION_CACHE_LIMIT)
      return;
    const oldest = this.completedGenerations.values().next().value;
    if (oldest) this.completedGenerations.delete(oldest);
  }

  private updateRuntimeStatus(): void {
    this.status.pendingTargets = this.pending.size;
    this.status.running = Boolean(this.activeRun);
  }
}

const libraryTargetedRefresh = new LibraryTargetedRefreshService();

export default libraryTargetedRefresh;
