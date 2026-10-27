import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI, {
  type SonarrEpisode,
  type SonarrEpisodeFile,
} from '@server/api/servarr/sonarr';
import TheMovieDb from '@server/api/themoviedb';
import {
  LibraryMediaType,
  type LibraryRemovalSource,
} from '@server/constants/libraryHistory';
import { MediaStatus, MediaType } from '@server/constants/media';
import {
  RemovalExecutionInitiator,
  RemovalExecutionState,
  RemovalScheduleStatus,
  RemovalTargetType,
  type RemovalExecutionInitiator as RemovalExecutionInitiatorType,
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
import { LibraryHydrationEpoch } from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import type { RemovalExecution } from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import Season from '@server/entity/Season';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import downloadTracker from '@server/lib/downloadtracker';
import libraryHydrationEpoch, {
  currentLibraryGeneration,
} from '@server/lib/libraryHydrationEpoch';
import removalExecutionCoordinator, {
  RemovalExecutionClaimConflictError,
  RemovalExecutionHeartbeat,
  RemovalExecutionOwnershipLostError,
  type RemovalExecutionCoordinator,
} from '@server/lib/removalExecutionCoordinator';
import { getSettings, type DVRSettings } from '@server/lib/settings';
import { In, type EntityManager } from 'typeorm';

export type MediaRemovalErrorCode =
  | 'NOT_FOUND'
  | 'CONFIGURATION'
  | 'IDENTITY_CONFLICT'
  | 'NOT_CURRENT'
  | 'AMBIGUOUS_SOURCE'
  | 'SCHEDULE_CONFLICT'
  | 'EXECUTION_CONFLICT'
  | 'ACTIVE_ACQUISITION'
  | 'TRANSIENT_PROVIDER'
  | 'CROSS_SEASON_FILE'
  | 'REMOTE_REMOVED_LOCAL_FAILED';

export class MediaRemovalError extends Error {
  constructor(
    public readonly code: MediaRemovalErrorCode,
    message: string,
    public readonly retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export interface RemovalTarget {
  canonicalMediaId?: number;
  mediaId?: number;
  targetType?: RemovalTargetType;
  seasonNumber?: number;
  sourceScope?: string;
  is4k?: boolean;
  removalSource: LibraryRemovalSource.MANUAL | LibraryRemovalSource.SCHEDULED;
  executionLeaseToken?: string;
}

export interface RemovalResult {
  targetType: RemovalTargetType;
  providerResult: 'removed' | 'absent';
  affectedSchedules?: number;
}

export interface ResolvedRemovalTarget {
  media?: Media;
  canonicalMedia?: CanonicalMedia;
  canonicalMediaId?: number;
  targetType: RemovalTargetType;
  seasonNumber?: number;
  sourceSystem: 'radarr' | 'sonarr';
  sourceScope: string;
  service: DVRSettings;
  is4k: boolean;
  externalServiceId?: number;
  libraryPresenceId: number;
  sourceItemId: string;
  sourceGeneration: string;
  removalSource: LibraryRemovalSource.MANUAL | LibraryRemovalSource.SCHEDULED;
}

export const refreshRemovalAcquisitionState = async (): Promise<void> => {
  let outcome;
  try {
    outcome = await acquisitionMonitor.refresh('background');
  } catch (error) {
    throw new MediaRemovalError(
      'TRANSIENT_PROVIDER',
      'Unable to refresh acquisition state',
      true,
      { cause: error }
    );
  }
  if (!outcome.authoritative) {
    throw new MediaRemovalError(
      'TRANSIENT_PROVIDER',
      'Acquisition state is not authoritative',
      true
    );
  }
};

export const assertRemovalTargetAcquisitionInactive = (
  target: ResolvedRemovalTarget
): void => {
  const externalId = target.externalServiceId;
  if (externalId === null || externalId === undefined) return;
  const active =
    target.sourceSystem === 'radarr'
      ? downloadTracker.getMovieProgress(target.service.id, externalId)
      : downloadTracker.getSeriesProgress(target.service.id, externalId);
  const targetActive =
    target.targetType !== RemovalTargetType.SEASON
      ? active.length > 0
      : active.some(
          (item) =>
            !item.episode || item.episode.seasonNumber === target.seasonNumber
        );
  if (targetActive) {
    throw new MediaRemovalError(
      'ACTIVE_ACQUISITION',
      'Media has an active acquisition and cannot be removed'
    );
  }
};

type SonarrRemovalClient = Pick<
  SonarrAPI,
  | 'getLibrarySeriesByTvdbId'
  | 'getEpisodes'
  | 'getEpisodeFiles'
  | 'setSeasonMonitored'
  | 'setEpisodesMonitored'
  | 'deleteEpisodeFiles'
  | 'removeSeries'
>;

interface MediaRemovalDependencies {
  createRadarr: (
    service: DVRSettings
  ) => Pick<RadarrAPI, 'removeMovie'> &
    Partial<Pick<RadarrAPI, 'getLibraryMoviesByTmdbId'>>;
  createSonarr: (service: DVRSettings) => SonarrRemovalClient;
}

const defaultDependencies: MediaRemovalDependencies = {
  createRadarr: (service) =>
    new RadarrAPI({
      apiKey: service.apiKey,
      url: RadarrAPI.buildUrl(service, '/api/v3'),
    }),
  createSonarr: (service) =>
    new SonarrAPI({
      apiKey: service.apiKey,
      url: SonarrAPI.buildUrl(service, '/api/v3'),
    }),
};

const serviceIdFromScope = (scope?: string): number | undefined => {
  if (!scope?.startsWith('service:')) return undefined;
  const value = Number(scope.slice('service:'.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const externalServiceIdFromPresence = (
  sourceItemId: string,
  sourceSystem: 'radarr' | 'sonarr'
): number | undefined => {
  const expectedPrefix = sourceSystem === 'radarr' ? 'movie:' : 'series:';
  const value = sourceItemId.includes(':')
    ? sourceItemId.startsWith(expectedPrefix)
      ? sourceItemId.slice(expectedPrefix.length)
      : ''
    : sourceItemId;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export const resolveCurrentRemovalTarget = async (
  target: RemovalTarget
): Promise<ResolvedRemovalTarget> => {
  const mediaRepository = getRepository(Media);
  let media: Media | null = null;
  let canonicalMedia: CanonicalMedia | undefined;

  if (target.mediaId !== undefined) {
    media = await mediaRepository.findOne({ where: { id: target.mediaId } });
    canonicalMedia =
      (await getRepository(CanonicalMedia).findOneBy({
        currentMediaId: target.mediaId,
      })) ?? undefined;
  } else if (target.canonicalMediaId !== undefined) {
    canonicalMedia =
      (await getRepository(CanonicalMedia).findOneBy({
        id: target.canonicalMediaId,
      })) ?? undefined;
    if (canonicalMedia?.currentMediaId) {
      media = await mediaRepository.findOne({
        where: { id: canonicalMedia.currentMediaId },
      });
    }
  }

  if (!canonicalMedia) {
    throw new MediaRemovalError('NOT_FOUND', 'Canonical media not found');
  }
  if (
    media &&
    ((canonicalMedia.mediaType === LibraryMediaType.MOVIE &&
      media.mediaType !== MediaType.MOVIE) ||
      (canonicalMedia.mediaType === LibraryMediaType.SERIES &&
        media.mediaType !== MediaType.TV))
  ) {
    throw new MediaRemovalError(
      'IDENTITY_CONFLICT',
      'Canonical and Seerr media types do not match'
    );
  }

  const mediaType =
    canonicalMedia.mediaType === LibraryMediaType.MOVIE
      ? MediaType.MOVIE
      : MediaType.TV;
  const targetType =
    target.targetType ??
    (mediaType === MediaType.MOVIE
      ? RemovalTargetType.MOVIE
      : RemovalTargetType.SERIES);
  if (
    (mediaType === MediaType.MOVIE && targetType !== RemovalTargetType.MOVIE) ||
    (mediaType === MediaType.TV && targetType === RemovalTargetType.MOVIE) ||
    (targetType === RemovalTargetType.SEASON &&
      (!Number.isInteger(target.seasonNumber) || target.seasonNumber! < 0)) ||
    (targetType !== RemovalTargetType.SEASON &&
      target.seasonNumber !== undefined)
  ) {
    throw new MediaRemovalError(
      'IDENTITY_CONFLICT',
      'Removal target does not match the canonical media type'
    );
  }

  const sourceSystem =
    canonicalMedia.mediaType === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr';
  const currentPresences = await getRepository(LibraryPresence).find({
    where: {
      canonicalMediaId: canonicalMedia.id,
      sourceSystem,
      ...(target.sourceScope ? { sourceScope: target.sourceScope } : {}),
      isCurrent: true,
      servarrHasFile: true,
    },
    order: { sourceScope: 'ASC', sourceItemId: 'ASC', id: 'ASC' },
  });
  if (currentPresences.length === 0) {
    throw new MediaRemovalError(
      'NOT_CURRENT',
      'No authoritative current removable Servarr presence exists'
    );
  }
  if (currentPresences.length > 1) {
    throw new MediaRemovalError(
      'AMBIGUOUS_SOURCE',
      'Multiple current Servarr sources match this removal target'
    );
  }
  const presence = currentPresences[0];
  const sourceScope = presence.sourceScope;
  const scopedId = serviceIdFromScope(sourceScope);
  if (scopedId === undefined) {
    throw new MediaRemovalError(
      'CONFIGURATION',
      'The current Servarr source is not mapped to a configured service'
    );
  }

  const settings = getSettings();
  const isMovie = mediaType === MediaType.MOVIE;
  const configured = isMovie ? settings.radarr : settings.sonarr;
  const service = configured.find(
    (candidate) =>
      candidate.id === scopedId && candidate.is4k === Boolean(target.is4k)
  );
  if (!service) {
    throw new MediaRemovalError(
      'CONFIGURATION',
      `No compatible ${isMovie ? 'Radarr' : 'Sonarr'} server is configured for this source`
    );
  }
  const mediaServiceId = target.is4k ? media?.serviceId4k : media?.serviceId;
  if (mediaServiceId != null && mediaServiceId !== service.id) {
    throw new MediaRemovalError(
      'IDENTITY_CONFLICT',
      'The Seerr media service does not match the current Servarr source'
    );
  }

  const externalServiceId = externalServiceIdFromPresence(
    presence.sourceItemId,
    sourceSystem
  );
  if (externalServiceId === undefined) {
    throw new MediaRemovalError(
      'IDENTITY_CONFLICT',
      'The current Servarr presence has an incompatible provider identity'
    );
  }

  if (targetType === RemovalTargetType.SEASON) {
    const season = await getRepository(CanonicalSeason).findOneBy({
      seriesId: canonicalMedia.id,
      seasonNumber: target.seasonNumber,
    });
    if (!season) {
      throw new MediaRemovalError(
        'NOT_CURRENT',
        'Current removable Season not found'
      );
    }
    const currentFiles = await getRepository(LibraryFile)
      .createQueryBuilder('file')
      .innerJoin(LibraryFileEpisode, 'link', 'link.libraryFileId = file.id')
      .innerJoin(
        CanonicalEpisode,
        'episode',
        'episode.id = link.canonicalEpisodeId'
      )
      .where('file.libraryPresenceId = :presenceId', {
        presenceId: presence.id,
      })
      .andWhere('file.isCurrent = :current', { current: true })
      .andWhere('episode.seasonId = :seasonId', { seasonId: season.id })
      .getCount();
    if (currentFiles === 0) {
      throw new MediaRemovalError(
        'NOT_CURRENT',
        'Current removable Season has no authoritative physical files'
      );
    }
  }

  return {
    media: media ?? undefined,
    canonicalMedia,
    canonicalMediaId: canonicalMedia.id,
    targetType,
    seasonNumber: target.seasonNumber,
    sourceSystem,
    sourceScope,
    service,
    is4k: Boolean(target.is4k),
    externalServiceId,
    libraryPresenceId: presence.id,
    sourceItemId: presence.sourceItemId,
    sourceGeneration: presence.sourceGeneration,
    removalSource: target.removalSource,
  };
};

export const buildSeasonRemovalPlan = ({
  episodes,
  files,
  seasonNumber,
}: {
  episodes: SonarrEpisode[];
  files: SonarrEpisodeFile[];
  seasonNumber: number;
}): { episodeIds: number[]; fileIds: number[] } => {
  const seasonsByFile = new Map<number, Set<number>>();
  for (const episode of episodes) {
    if (!episode.episodeFileId) continue;
    const seasons = seasonsByFile.get(episode.episodeFileId) ?? new Set();
    seasons.add(episode.seasonNumber);
    seasonsByFile.set(episode.episodeFileId, seasons);
  }

  const targetEpisodes = episodes.filter(
    (episode) => episode.seasonNumber === seasonNumber
  );
  const targetFileIds = [
    ...new Set(
      targetEpisodes
        .map((episode) => episode.episodeFileId)
        .filter((id) => id > 0)
    ),
  ];
  const crossesSeasonBoundary = targetFileIds.some((id) =>
    [...(seasonsByFile.get(id) ?? [])].some(
      (candidateSeason) => candidateSeason !== seasonNumber
    )
  );
  if (crossesSeasonBoundary) {
    throw new MediaRemovalError(
      'CROSS_SEASON_FILE',
      'A shared EpisodeFile crosses the requested season boundary'
    );
  }

  const knownFileIds = new Set(files.map((file) => file.id));
  return {
    episodeIds: targetEpisodes.map((episode) => episode.id),
    fileIds: targetFileIds.filter((id) => knownFileIds.has(id)),
  };
};

export class MediaRemovalService {
  constructor(
    private readonly dependencies: MediaRemovalDependencies = defaultDependencies,
    private readonly coordinator: RemovalExecutionCoordinator = removalExecutionCoordinator,
    private readonly heartbeatMs = 3 * 60_000
  ) {}

  private async reconcileFoundation(
    target: ResolvedRemovalTarget,
    manager: EntityManager
  ): Promise<void> {
    if (!target.canonicalMediaId) return;
    const removedAt = new Date();
    const presenceRepository = manager.getRepository(LibraryPresence);
    const fileRepository = manager.getRepository(LibraryFile);
    const currentTargetPresences = await presenceRepository.findBy({
      canonicalMediaId: target.canonicalMediaId,
      sourceSystem: target.sourceSystem,
      sourceScope: target.sourceScope,
      isCurrent: true,
    });

    if (target.targetType === RemovalTargetType.SEASON) {
      if (currentTargetPresences.length === 0) return;
      const presenceIds = currentTargetPresences.map(({ id }) => id);
      const files = await fileRepository
        .createQueryBuilder('file')
        .innerJoin(LibraryFileEpisode, 'link', 'link.libraryFileId = file.id')
        .innerJoin(
          CanonicalEpisode,
          'episode',
          'episode.id = link.canonicalEpisodeId'
        )
        .innerJoin(CanonicalSeason, 'season', 'season.id = episode.seasonId')
        .where('file.libraryPresenceId IN (:...presenceIds)', {
          presenceIds,
        })
        .andWhere('file.isCurrent = :current', { current: true })
        .andWhere('season.seriesId = :canonicalMediaId', {
          canonicalMediaId: target.canonicalMediaId,
        })
        .andWhere('season.seasonNumber = :seasonNumber', {
          seasonNumber: target.seasonNumber,
        })
        .getMany();
      for (const file of files) {
        file.isCurrent = false;
        file.removedAt ??= removedAt;
        file.removalSource ??= target.removalSource;
      }
      if (files.length > 0) await fileRepository.save(files);

      for (const presence of currentTargetPresences) {
        const remaining = await fileRepository.findBy({
          libraryPresenceId: presence.id,
          isCurrent: true,
        });
        presence.servarrHasFile = remaining.length > 0;
        presence.logicalSizeBytes = remaining
          .reduce((total, file) => total + BigInt(file.sizeBytes ?? 0), 0n)
          .toString();
      }
      await presenceRepository.save(currentTargetPresences);
      return;
    }

    const targetPresenceIds = currentTargetPresences.map(({ id }) => id);
    if (targetPresenceIds.length > 0) {
      const files = await fileRepository.findBy({
        libraryPresenceId: In(targetPresenceIds),
        isCurrent: true,
      });
      for (const file of files) {
        file.isCurrent = false;
        file.removedAt ??= removedAt;
        file.removalSource ??= target.removalSource;
      }
      if (files.length > 0) await fileRepository.save(files);
      for (const presence of currentTargetPresences) {
        presence.isCurrent = false;
        presence.removedAt ??= removedAt;
        presence.removalSource ??= target.removalSource;
        // isCurrent closes availability; retain the last physical fact for Archive.
      }
      await presenceRepository.save(currentTargetPresences);
    }

    const remainingServarrPresence = await presenceRepository.findOne({
      where: {
        canonicalMediaId: target.canonicalMediaId,
        sourceSystem: In(['radarr', 'sonarr']),
        isCurrent: true,
        servarrHasFile: true,
      },
    });
    if (remainingServarrPresence) return;
    const jellyfinPresences = await presenceRepository.findBy({
      canonicalMediaId: target.canonicalMediaId,
      sourceSystem: 'jellyfin',
      isCurrent: true,
    });
    for (const presence of jellyfinPresences) {
      presence.isCurrent = false;
      presence.removedAt ??= removedAt;
      presence.removalSource ??= target.removalSource;
    }
    if (jellyfinPresences.length > 0) {
      await presenceRepository.save(jellyfinPresences);
    }
  }

  private async guardAcquisition(target: ResolvedRemovalTarget): Promise<void> {
    await refreshRemovalAcquisitionState();
    assertRemovalTargetAcquisitionInactive(target);
  }

  private async tvdbId(target: ResolvedRemovalTarget): Promise<number> {
    if (target.media?.tvdbId) return target.media.tvdbId;
    if (target.canonicalMediaId) {
      const canonical = await getRepository(CanonicalMediaIdentity).findOne({
        where: {
          canonicalMediaId: target.canonicalMediaId,
          mediaType: LibraryMediaType.SERIES,
          provider: 'tvdb',
          sourceScope: '',
        },
      });
      const value = Number(canonical?.value);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
    if (!target.media) {
      throw new MediaRemovalError(
        'IDENTITY_CONFLICT',
        'A confirmed TVDB identity is required for Sonarr removal'
      );
    }
    try {
      const tmdb = new TheMovieDb();
      const series = await tmdb.getTvShow({ tvId: target.media.tmdbId });
      const value = Number(series.external_ids.tvdb_id);
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch (error) {
      throw new MediaRemovalError(
        'TRANSIENT_PROVIDER',
        'Unable to resolve the TVDB identity',
        true,
        { cause: error }
      );
    }
    throw new MediaRemovalError(
      'IDENTITY_CONFLICT',
      'A confirmed TVDB identity is required for Sonarr removal'
    );
  }

  private async tmdbId(target: ResolvedRemovalTarget): Promise<number> {
    if (target.media?.tmdbId) return target.media.tmdbId;
    if (target.canonicalMediaId) {
      const canonical = await getRepository(CanonicalMediaIdentity).findOne({
        where: {
          canonicalMediaId: target.canonicalMediaId,
          mediaType: LibraryMediaType.MOVIE,
          provider: 'tmdb',
          sourceScope: '',
        },
      });
      const value = Number(canonical?.value);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
    throw new MediaRemovalError(
      'IDENTITY_CONFLICT',
      'A confirmed TMDB identity is required for Radarr removal'
    );
  }

  private async removeSeason(
    target: ResolvedRemovalTarget,
    sonarr: SonarrRemovalClient,
    tvdbId: number,
    beforeMutation: () => Promise<void> = async () => undefined
  ): Promise<'removed' | 'absent'> {
    const matches = (await sonarr.getLibrarySeriesByTvdbId(tvdbId)).filter(
      (series) => series.tvdbId === tvdbId
    );
    if (matches.length > 1) {
      throw new MediaRemovalError(
        'IDENTITY_CONFLICT',
        'Multiple exact Sonarr series matched the TVDB identity'
      );
    }
    const series = matches[0];
    if (!series?.id) return 'absent';
    const episodes = await sonarr.getEpisodes(series.id);
    const files = await sonarr.getEpisodeFiles(series.id);
    const plan = buildSeasonRemovalPlan({
      episodes,
      files,
      seasonNumber: target.seasonNumber!,
    });
    await beforeMutation();
    await sonarr.setSeasonMonitored(series, target.seasonNumber!, false);
    await beforeMutation();
    await sonarr.setEpisodesMonitored(plan.episodeIds, false);
    for (const fileId of plan.fileIds) {
      await beforeMutation();
      await sonarr.deleteEpisodeFiles([fileId]);
    }
    return 'removed';
  }

  private async assertExecutionAllowed(
    target: ResolvedRemovalTarget,
    executionLeaseToken?: string
  ): Promise<void> {
    const schedules = await getRepository(RemovalSchedule).find({
      where: {
        canonicalMediaId: target.canonicalMediaId,
        status: In([
          RemovalScheduleStatus.ACTIVE,
          RemovalScheduleStatus.DEFERRED,
        ]),
      },
    });
    if (
      target.targetType === RemovalTargetType.SEASON &&
      schedules.some(
        (schedule) => schedule.targetType === RemovalTargetType.SERIES
      )
    ) {
      throw new MediaRemovalError(
        'SCHEDULE_CONFLICT',
        'A whole-Series removal is already scheduled'
      );
    }
    const now = new Date();
    if (
      schedules.some(
        (schedule) =>
          schedule.leaseToken &&
          schedule.leaseToken !== executionLeaseToken &&
          schedule.leaseUntil &&
          schedule.leaseUntil > now
      )
    ) {
      throw new MediaRemovalError(
        'EXECUTION_CONFLICT',
        'A removal for this media is already being processed',
        true
      );
    }
  }

  public async prepareScheduledRemoval(
    targetInput: RemovalTarget
  ): Promise<ResolvedRemovalTarget> {
    const target = await resolveCurrentRemovalTarget(targetInput);
    await this.assertExecutionAllowed(target, targetInput.executionLeaseToken);
    await this.guardAcquisition(target);
    return target;
  }

  public async resolveScheduledRemovalTarget(
    targetInput: RemovalTarget
  ): Promise<ResolvedRemovalTarget> {
    return resolveCurrentRemovalTarget(targetInput);
  }

  public async executeScheduledProviderRemoval(
    target: ResolvedRemovalTarget,
    assertOwnership: () => Promise<void>
  ): Promise<RemovalResult> {
    let providerResult: 'removed' | 'absent';
    try {
      if (target.sourceSystem === 'radarr') {
        const radarr = this.dependencies.createRadarr(target.service);
        providerResult = await radarr.removeMovie(
          await this.tmdbId(target),
          assertOwnership
        );
      } else {
        const sonarr = this.dependencies.createSonarr(target.service);
        const tvdbId = await this.tvdbId(target);
        providerResult =
          target.targetType === RemovalTargetType.SEASON
            ? await this.removeSeason(target, sonarr, tvdbId, assertOwnership)
            : await sonarr.removeSeries(tvdbId, assertOwnership);
      }
    } catch (error) {
      if (error instanceof MediaRemovalError) throw error;
      throw new MediaRemovalError(
        'TRANSIENT_PROVIDER',
        'Provider removal failed',
        true,
        { cause: error }
      );
    }
    return { targetType: target.targetType, providerResult };
  }

  public async isScheduledProviderTargetAbsent(
    target: ResolvedRemovalTarget
  ): Promise<boolean> {
    if (target.sourceSystem === 'radarr') {
      const tmdbId = await this.tmdbId(target);
      const radarr = this.dependencies.createRadarr(target.service);
      if (!radarr.getLibraryMoviesByTmdbId) {
        throw new MediaRemovalError(
          'CONFIGURATION',
          'Read-only Radarr reconciliation is unavailable'
        );
      }
      const matches = (await radarr.getLibraryMoviesByTmdbId(tmdbId)).filter(
        (movie) => movie.tmdbId === tmdbId
      );
      if (matches.length > 1) {
        throw new MediaRemovalError(
          'IDENTITY_CONFLICT',
          'Multiple exact Radarr movies matched the TMDB identity'
        );
      }
      return matches.length === 0;
    }
    const tvdbId = await this.tvdbId(target);
    const sonarr = this.dependencies.createSonarr(target.service);
    const matches = (await sonarr.getLibrarySeriesByTvdbId(tvdbId)).filter(
      (series) => series.tvdbId === tvdbId
    );
    if (matches.length > 1) {
      throw new MediaRemovalError(
        'IDENTITY_CONFLICT',
        'Multiple exact Sonarr series matched the TVDB identity'
      );
    }
    const series = matches[0];
    if (!series?.id) return true;
    if (target.targetType !== RemovalTargetType.SEASON) return false;
    const plan = buildSeasonRemovalPlan({
      episodes: await sonarr.getEpisodes(series.id),
      files: await sonarr.getEpisodeFiles(series.id),
      seasonNumber: target.seasonNumber!,
    });
    return plan.fileIds.length === 0;
  }

  public async reconcileResolvedRemoval(
    target: ResolvedRemovalTarget,
    manager: EntityManager
  ): Promise<void> {
    await currentLibraryGeneration.advance(manager);
    const epochScopes = new Set([
      `${target.sourceSystem}\0${target.sourceScope}`,
    ]);
    if (
      target.canonicalMediaId &&
      target.targetType !== RemovalTargetType.SEASON
    ) {
      const jellyfinEpochs = await manager
        .getRepository(LibraryHydrationEpoch)
        .findBy({ sourceSystem: 'jellyfin' });
      jellyfinEpochs.forEach(({ sourceScope }) =>
        epochScopes.add(`jellyfin\0${sourceScope}`)
      );
      const jellyfinPresences = await manager
        .getRepository(LibraryPresence)
        .findBy({
          canonicalMediaId: target.canonicalMediaId,
          sourceSystem: 'jellyfin',
          isCurrent: true,
        });
      jellyfinPresences.forEach(({ sourceScope }) =>
        epochScopes.add(`jellyfin\0${sourceScope}`)
      );
    }
    for (const source of [...epochScopes].sort()) {
      const [sourceSystem, sourceScope] = source.split('\0');
      await libraryHydrationEpoch.advance(manager, sourceSystem, sourceScope);
    }
    await this.reconcileFoundation(target, manager);
    if (!target.media) return;
    if (target.targetType === RemovalTargetType.SEASON) {
      const season = target.media.seasons.find(
        (candidate) => candidate.seasonNumber === target.seasonNumber
      );
      if (season) {
        season[target.is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
        await manager.getRepository(Season).save(season);
      }
      const remaining = target.media.seasons.filter(
        (candidate) =>
          candidate[target.is4k ? 'status4k' : 'status'] !== MediaStatus.DELETED
      );
      target.media[target.is4k ? 'status4k' : 'status'] = remaining.length
        ? MediaStatus.PARTIALLY_AVAILABLE
        : MediaStatus.DELETED;
    } else {
      target.media[target.is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
      if (target.media.mediaType === MediaType.TV) {
        target.media.seasons.forEach((season) => {
          season[target.is4k ? 'status4k' : 'status'] = MediaStatus.DELETED;
        });
      }
      target.media.resetServiceData(target.is4k);
    }
    await manager.getRepository(Media).save(target.media);
  }

  public async assertResolvedTargetSnapshot(
    manager: EntityManager,
    execution: RemovalExecution
  ): Promise<void> {
    const presence = await manager.getRepository(LibraryPresence).findOneBy({
      id: execution.libraryPresenceId ?? -1,
      canonicalMediaId: execution.canonicalMediaId,
      sourceSystem: execution.sourceSystem ?? '',
      sourceScope: execution.sourceScope ?? '',
      sourceItemId: execution.sourceItemId ?? '',
      sourceGeneration: execution.sourceGeneration ?? '',
      isCurrent: true,
      servarrHasFile: true,
    });
    if (!presence) {
      throw new RemovalExecutionOwnershipLostError(
        'Authoritative removal target changed before provider execution'
      );
    }
    if (execution.targetType === RemovalTargetType.SEASON) {
      const currentFiles = await manager
        .getRepository(LibraryFile)
        .createQueryBuilder('file')
        .innerJoin(LibraryFileEpisode, 'link', 'link.libraryFileId = file.id')
        .innerJoin(
          CanonicalEpisode,
          'episode',
          'episode.id = link.canonicalEpisodeId'
        )
        .innerJoin(CanonicalSeason, 'season', 'season.id = episode.seasonId')
        .where('file.libraryPresenceId = :presenceId', {
          presenceId: presence.id,
        })
        .andWhere('file.isCurrent = :current', { current: true })
        .andWhere('season.seriesId = :canonicalMediaId', {
          canonicalMediaId: execution.canonicalMediaId,
        })
        .andWhere('season.seasonNumber = :seasonNumber', {
          seasonNumber: execution.seasonNumber,
        })
        .getCount();
      if (currentFiles === 0) {
        throw new RemovalExecutionOwnershipLostError(
          'Authoritative Season files changed before provider execution'
        );
      }
    }
  }

  public async reconcileSchedules(
    target: ResolvedRemovalTarget,
    manager: EntityManager
  ): Promise<number> {
    const schedules = await manager.getRepository(RemovalSchedule).find({
      where: {
        canonicalMediaId: target.canonicalMediaId,
        status: In([
          RemovalScheduleStatus.ACTIVE,
          RemovalScheduleStatus.DEFERRED,
        ]),
      },
      order: { id: 'ASC' },
    });
    const completed = schedules.filter(
      (schedule) =>
        (schedule.targetType === target.targetType &&
          (target.targetType !== RemovalTargetType.SEASON ||
            schedule.seasonNumber === target.seasonNumber)) ||
        (target.targetType === RemovalTargetType.SERIES &&
          schedule.targetType === RemovalTargetType.SEASON)
    );
    const now = new Date();
    for (const schedule of completed) {
      schedule.status = RemovalScheduleStatus.COMPLETED;
      schedule.completedAt = now;
      schedule.lastAttemptAt = now;
      schedule.activeKey = null;
      schedule.leaseToken = null;
      schedule.leaseUntil = null;
      schedule.failureCode = null;
      schedule.failureMessage = null;
      schedule.revision += 1;
    }
    if (completed.length > 0) {
      await manager.getRepository(RemovalSchedule).save(completed);
    }
    return completed.length;
  }

  public async remove(
    targetInput: RemovalTarget,
    initiator: RemovalExecutionInitiatorType = RemovalExecutionInitiator.MANUAL
  ): Promise<RemovalResult> {
    let target = await resolveCurrentRemovalTarget(targetInput);
    const canonicalMediaId = target.canonicalMediaId;
    if (!canonicalMediaId) {
      throw new MediaRemovalError(
        'IDENTITY_CONFLICT',
        'A canonical media identity is required for removal'
      );
    }
    let ownership;
    try {
      ownership = await this.coordinator.acquire({
        canonicalMediaId,
        targetType: target.targetType,
        seasonNumber: target.seasonNumber,
        initiator,
        sourceSystem: target.sourceSystem,
        sourceScope: target.sourceScope,
        sourceItemId: target.sourceItemId,
        sourceGeneration: target.sourceGeneration,
        libraryPresenceId: target.libraryPresenceId,
      });
    } catch (error) {
      if (error instanceof RemovalExecutionClaimConflictError) {
        throw new MediaRemovalError(
          'EXECUTION_CONFLICT',
          'A removal for this media is already being processed',
          true,
          { cause: error }
        );
      }
      throw error;
    }
    const heartbeat = new RemovalExecutionHeartbeat(
      ownership,
      this.coordinator,
      this.heartbeatMs
    );
    let providerStarted = false;
    let providerOutcomeRecorded = false;
    try {
      target = await this.prepareScheduledRemoval(targetInput);
      await heartbeat.assert();
      await this.coordinator.beginProvider(
        ownership,
        async (manager, execution) =>
          this.assertResolvedTargetSnapshot(manager, execution)
      );
      providerStarted = true;
      const result = await this.executeScheduledProviderRemoval(target, () =>
        heartbeat.assert()
      );
      await heartbeat.assert();
      await heartbeat.stop();
      await this.coordinator.recordProviderOutcome(
        ownership,
        result.providerResult === 'removed' ? 'acknowledged' : 'absent'
      );
      providerOutcomeRecorded = true;
      const affectedSchedules = await this.coordinator.complete(
        ownership,
        async (manager) => {
          await this.reconcileResolvedRemoval(target, manager);
          return this.reconcileSchedules(target, manager);
        }
      );
      return affectedSchedules > 0 ? { ...result, affectedSchedules } : result;
    } catch (error) {
      if (!providerStarted) {
        try {
          await this.coordinator.endBeforeProvider(
            ownership,
            RemovalExecutionState.FAILED_PRE_PROVIDER,
            error instanceof MediaRemovalError ? error.code : 'UNKNOWN',
            error instanceof Error ? error.message : 'Removal failed'
          );
        } catch {
          throw new MediaRemovalError(
            'EXECUTION_CONFLICT',
            'Removal execution ownership was lost before provider execution',
            true,
            { cause: error }
          );
        }
        throw error;
      }
      const failureCode =
        error instanceof MediaRemovalError ? error.code : 'UNKNOWN';
      const failureMessage =
        error instanceof Error ? error.message : 'Removal failed';
      if (providerOutcomeRecorded) {
        await this.coordinator.requireReconciliationIfOwned(
          ownership,
          'REMOTE_REMOVED_LOCAL_FAILED',
          `Provider outcome was recorded, but local reconciliation failed: ${failureMessage}`
        );
      } else {
        await this.coordinator.quarantineProviderOutcomeIfOwned(
          ownership,
          failureCode,
          failureMessage
        );
      }
      throw new MediaRemovalError(
        'REMOTE_REMOVED_LOCAL_FAILED',
        providerOutcomeRecorded
          ? 'Provider removal completed, but local reconciliation requires recovery. Do not retry automatically.'
          : 'The provider removal outcome is uncertain. Reconcile provider state before retrying.',
        false,
        { cause: error }
      );
    } finally {
      await heartbeat.stop();
    }
  }
}

const mediaRemoval = new MediaRemovalService();
export default mediaRemoval;
