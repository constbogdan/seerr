import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import { RemovalTargetType } from '@server/constants/removal';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import type Media from '@server/entity/Media';
import {
  MediaRemovalError,
  type RemovalTarget,
  type ResolvedRemovalTarget,
} from '@server/lib/mediaRemoval';
import { getSettings, type DVRSettings } from '@server/lib/settings';
import { In } from 'typeorm';

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

interface CanonicalWithCurrentMedia extends CanonicalMedia {
  currentMedia?: Media | null;
}

interface SeasonFileMembership {
  presenceId: number;
  seasonId: number;
}

const numberFromDatabase = (value: unknown): number => Number(value);

/**
 * Resolves read-only bulk eligibility facts with set queries. This deliberately
 * does not replace the single-target resolver used immediately before a
 * destructive operation.
 */
export const resolveCurrentRemovalTargetsForEligibility = async (
  targets: RemovalTarget[]
): Promise<PromiseSettledResult<ResolvedRemovalTarget>[]> => {
  if (targets.length === 0) return [];

  const canonicalMediaIds = [
    ...new Set(
      targets
        .map(({ canonicalMediaId }) => canonicalMediaId)
        .filter((id): id is number => id !== undefined)
    ),
  ];
  const canonicalMedia = (await getRepository(CanonicalMedia)
    .createQueryBuilder('canonical')
    .leftJoinAndSelect('canonical.currentMedia', 'currentMedia')
    .where('canonical.id IN (:...canonicalMediaIds)', { canonicalMediaIds })
    .getMany()) as CanonicalWithCurrentMedia[];
  const canonicalById = new Map(
    canonicalMedia.map((canonical) => [canonical.id, canonical])
  );

  const presences = await getRepository(LibraryPresence).find({
    where: {
      canonicalMediaId: In(canonicalMediaIds),
      isCurrent: true,
      servarrHasFile: true,
    },
    order: {
      canonicalMediaId: 'ASC',
      sourceScope: 'ASC',
      sourceItemId: 'ASC',
      id: 'ASC',
    },
  });
  const presencesByMedia = new Map<number, LibraryPresence[]>();
  for (const presence of presences) {
    const current = presencesByMedia.get(presence.canonicalMediaId) ?? [];
    current.push(presence);
    presencesByMedia.set(presence.canonicalMediaId, current);
  }

  const seasonTargets = targets.filter(
    (target) =>
      target.targetType === RemovalTargetType.SEASON &&
      target.canonicalMediaId !== undefined &&
      target.seasonNumber !== undefined
  );
  const seasonSeriesIds = [
    ...new Set(
      seasonTargets.map(({ canonicalMediaId }) => canonicalMediaId as number)
    ),
  ];
  const seasons =
    seasonSeriesIds.length === 0
      ? []
      : await getRepository(CanonicalSeason).findBy({
          seriesId: In(seasonSeriesIds),
        });
  const seasonByIdentity = new Map(
    seasons.map((season) => [
      `${season.seriesId}:${season.seasonNumber}`,
      season,
    ])
  );

  const relevantPresenceIds = [
    ...new Set(
      seasonTargets.flatMap((target) =>
        (presencesByMedia.get(target.canonicalMediaId as number) ?? []).map(
          ({ id }) => id
        )
      )
    ),
  ];
  const relevantSeasonIds = [...new Set(seasons.map(({ id }) => id))];
  const membershipRows: SeasonFileMembership[] =
    relevantPresenceIds.length === 0 || relevantSeasonIds.length === 0
      ? []
      : await getRepository(LibraryFile)
          .createQueryBuilder('file')
          .select('file.libraryPresenceId', 'presenceId')
          .addSelect('episode.seasonId', 'seasonId')
          .innerJoin(LibraryFileEpisode, 'link', 'link.libraryFileId = file.id')
          .innerJoin(
            CanonicalEpisode,
            'episode',
            'episode.id = link.canonicalEpisodeId'
          )
          .where('file.libraryPresenceId IN (:...presenceIds)', {
            presenceIds: relevantPresenceIds,
          })
          .andWhere('file.isCurrent = :current', { current: true })
          .andWhere('episode.seasonId IN (:...seasonIds)', {
            seasonIds: relevantSeasonIds,
          })
          .groupBy('file.libraryPresenceId')
          .addGroupBy('episode.seasonId')
          .getRawMany<SeasonFileMembership>();
  const seasonFileMembership = new Set(
    membershipRows.map(
      ({ presenceId, seasonId }) =>
        `${numberFromDatabase(presenceId)}:${numberFromDatabase(seasonId)}`
    )
  );

  const settings = getSettings();
  return targets.map((target): PromiseSettledResult<ResolvedRemovalTarget> => {
    try {
      const canonical =
        target.canonicalMediaId === undefined
          ? undefined
          : canonicalById.get(target.canonicalMediaId);
      if (!canonical) {
        throw new MediaRemovalError('NOT_FOUND', 'Canonical media not found');
      }
      const media = canonical.currentMedia ?? null;
      if (
        media &&
        ((canonical.mediaType === LibraryMediaType.MOVIE &&
          media.mediaType !== MediaType.MOVIE) ||
          (canonical.mediaType === LibraryMediaType.SERIES &&
            media.mediaType !== MediaType.TV))
      ) {
        throw new MediaRemovalError(
          'IDENTITY_CONFLICT',
          'Canonical and Seerr media types do not match'
        );
      }

      const mediaType =
        canonical.mediaType === LibraryMediaType.MOVIE
          ? MediaType.MOVIE
          : MediaType.TV;
      const targetType =
        target.targetType ??
        (mediaType === MediaType.MOVIE
          ? RemovalTargetType.MOVIE
          : RemovalTargetType.SERIES);
      if (
        (mediaType === MediaType.MOVIE &&
          targetType !== RemovalTargetType.MOVIE) ||
        (mediaType === MediaType.TV &&
          targetType === RemovalTargetType.MOVIE) ||
        (targetType === RemovalTargetType.SEASON &&
          (!Number.isInteger(target.seasonNumber) ||
            target.seasonNumber! < 0)) ||
        (targetType !== RemovalTargetType.SEASON &&
          target.seasonNumber !== undefined)
      ) {
        throw new MediaRemovalError(
          'IDENTITY_CONFLICT',
          'Removal target does not match the canonical media type'
        );
      }

      const sourceSystem =
        canonical.mediaType === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr';
      const matchingPresences = (
        presencesByMedia.get(canonical.id) ?? []
      ).filter(
        (presence) =>
          presence.sourceSystem === sourceSystem &&
          (!target.sourceScope || presence.sourceScope === target.sourceScope)
      );
      if (matchingPresences.length === 0) {
        throw new MediaRemovalError(
          'NOT_CURRENT',
          'No authoritative current removable Servarr presence exists'
        );
      }
      if (matchingPresences.length > 1) {
        throw new MediaRemovalError(
          'AMBIGUOUS_SOURCE',
          'Multiple current Servarr sources match this removal target'
        );
      }
      const presence = matchingPresences[0];
      const scopedId = serviceIdFromScope(presence.sourceScope);
      if (scopedId === undefined) {
        throw new MediaRemovalError(
          'CONFIGURATION',
          'The current Servarr source is not mapped to a configured service'
        );
      }

      const isMovie = mediaType === MediaType.MOVIE;
      const configured = isMovie ? settings.radarr : settings.sonarr;
      const service = configured.find(
        (candidate) =>
          candidate.id === scopedId && candidate.is4k === Boolean(target.is4k)
      ) as DVRSettings | undefined;
      if (!service) {
        throw new MediaRemovalError(
          'CONFIGURATION',
          `No compatible ${isMovie ? 'Radarr' : 'Sonarr'} server is configured for this source`
        );
      }
      const mediaServiceId = target.is4k
        ? media?.serviceId4k
        : media?.serviceId;
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
        const season = seasonByIdentity.get(
          `${canonical.id}:${target.seasonNumber}`
        );
        if (
          !season ||
          !seasonFileMembership.has(`${presence.id}:${season.id}`)
        ) {
          throw new MediaRemovalError(
            'NOT_CURRENT',
            season
              ? 'Current removable Season has no authoritative physical files'
              : 'Current removable Season not found'
          );
        }
      }

      return {
        status: 'fulfilled',
        value: {
          media: media ?? undefined,
          canonicalMedia: canonical,
          canonicalMediaId: canonical.id,
          targetType,
          seasonNumber: target.seasonNumber,
          sourceSystem,
          sourceScope: presence.sourceScope,
          service,
          is4k: Boolean(target.is4k),
          externalServiceId,
          libraryPresenceId: presence.id,
          sourceItemId: presence.sourceItemId,
          sourceGeneration: presence.sourceGeneration,
          removalSource: target.removalSource,
        },
      };
    } catch (reason) {
      return { status: 'rejected', reason };
    }
  });
};
