import type { SonarrSeries } from '@server/api/servarr/sonarr';
import {
  MediaStatus,
  MediaType,
  MediaRequestStatus as RS,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import {
  requestIdentity,
  transitionRequestStatus,
} from '@server/lib/requestLifecycleState';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import {
  MediaRequestSubscriber,
  updateRequestStatus,
} from '@server/subscriber/MediaRequestSubscriber';
import { In } from 'typeorm';

export interface SonarrSettlementObservation {
  readonly mediaType: MediaType.TV;
  readonly tmdbId: number;
  readonly tvdbId: number;
  readonly sourceId: number;
  readonly sourceSeriesId: number;
  readonly is4k: boolean;
  readonly seasons: readonly Readonly<{
    seasonNumber: number;
    totalEpisodes: number;
    episodeFiles: number;
    valid: boolean;
  }>[];
  readonly isCurrent: () => boolean;
}

export const settleAvailableMovieRequests = async (
  mediaId: number,
  is4k: boolean,
  assertCurrent: () => void
) => {
  const repository = getRepository(MediaRequest);
  const requests = await repository.find({
    where: {
      media: {
        id: mediaId,
        mediaType: MediaType.MOVIE,
        [is4k ? 'status4k' : 'status']: MediaStatus.AVAILABLE,
      },
      is4k,
      status: In([RS.APPROVED, RS.FAILED]),
    },
  });
  for (const request of requests) {
    assertCurrent();
    await updateRequestStatus(repository.manager, request, RS.COMPLETED);
  }
};

/** Current known-Season acquisition statistics, never an import-generation identifier. */
export const observeSonarrSettlement = (
  series: SonarrSeries,
  tmdbId: number,
  metadataSeasons: readonly { season_number: number; episode_count: number }[],
  server: SonarrSettings,
  isCurrent: () => boolean
): SonarrSettlementObservation => {
  const source = Object.freeze({
    id: server.id,
    hostname: server.hostname,
    port: server.port,
    baseUrl: server.baseUrl,
    useSsl: server.useSsl,
    is4k: server.is4k,
  });
  const validIdentity =
    Number.isSafeInteger(series.id) &&
    (series.id ?? 0) > 0 &&
    Number.isSafeInteger(series.tvdbId) &&
    series.tvdbId > 0 &&
    Number.isSafeInteger(tmdbId) &&
    tmdbId > 0;
  const seasons = (Array.isArray(series.seasons) ? series.seasons : []).map(
    (season) => {
      const totalEpisodes = season.statistics?.totalEpisodeCount ?? 0;
      const episodeFiles = season.statistics?.episodeFileCount ?? -1;
      const matches = metadataSeasons.filter(
        (s) => s.season_number === season.seasonNumber
      );
      return Object.freeze({
        seasonNumber: season.seasonNumber,
        totalEpisodes,
        episodeFiles,
        valid:
          validIdentity &&
          Number.isSafeInteger(season.seasonNumber) &&
          season.seasonNumber >= 0 &&
          Number.isSafeInteger(totalEpisodes) &&
          totalEpisodes > 0 &&
          Number.isSafeInteger(episodeFiles) &&
          episodeFiles >= 0 &&
          episodeFiles <= totalEpisodes &&
          series.seasons.filter((s) => s.seasonNumber === season.seasonNumber)
            .length === 1 &&
          matches.length === 1 &&
          matches[0].episode_count === totalEpisodes,
      });
    }
  );
  return Object.freeze({
    mediaType: MediaType.TV as const,
    tmdbId,
    tvdbId: series.tvdbId,
    sourceId: source.id,
    sourceSeriesId: series.id ?? 0,
    is4k: source.is4k,
    seasons: Object.freeze(seasons),
    isCurrent: () =>
      isCurrent() &&
      getSettings().sonarr.some(
        (current) =>
          current.syncEnabled &&
          current.id === source.id &&
          current.hostname === source.hostname &&
          current.port === source.port &&
          current.baseUrl === source.baseUrl &&
          current.useSsl === source.useSsl &&
          current.is4k === source.is4k
      ),
  });
};

/** No provider I/O, cache, job or persistence of observations. Canonical flags are untouched. */
export const settleSonarrRequests = async (
  mediaId: number,
  observation: SonarrSettlementObservation
): Promise<number> => {
  if (!observation.isCurrent()) return 0;
  const complete = observation.seasons.filter(
    (s) => s.valid && s.episodeFiles === s.totalEpisodes
  );
  if (!complete.length) return 0;
  const manager = getRepository(MediaRequest).manager;
  const media = await manager.getRepository(Media).findOneBy({
    id: mediaId,
    mediaType: observation.mediaType,
    tmdbId: observation.tmdbId,
  });
  if (
    !media ||
    media.tvdbId !== observation.tvdbId ||
    media[observation.is4k ? 'serviceId4k' : 'serviceId'] !==
      observation.sourceId ||
    media[observation.is4k ? 'externalServiceId4k' : 'externalServiceId'] !==
      observation.sourceSeriesId
  )
    return 0;
  const requests = await manager.getRepository(MediaRequest).find({
    where: {
      media: { id: mediaId },
      type: MediaType.TV,
      is4k: observation.is4k,
      status: In([RS.APPROVED, RS.FAILED]),
    },
  });
  let completed = 0;
  for (const request of requests) {
    const authority =
      request.serverId !== null && request.serverId >= 0
        ? getSettings().sonarr.find((server) => server.id === request.serverId)
        : getSettings().sonarr.find(
            (server) => server.isDefault && server.is4k === request.is4k
          );
    if (
      authority?.id !== observation.sourceId ||
      authority.is4k !== request.is4k ||
      !authority.syncEnabled
    )
      continue;
    for (const season of complete) {
      const scopes = request.seasons.filter(
        (scope) => scope.seasonNumber === season.seasonNumber
      );
      if (
        scopes.length !== 1 ||
        ![RS.PENDING, RS.APPROVED, RS.FAILED].includes(scopes[0].status)
      )
        continue;
      if (!observation.isCurrent()) return completed;
      await manager
        .createQueryBuilder()
        .update(SeasonRequest)
        .set({ status: RS.COMPLETED })
        .where('requestId = :requestId AND seasonNumber = :seasonNumber', {
          requestId: request.id,
          seasonNumber: season.seasonNumber,
        })
        .andWhere('id = :childId', { childId: scopes[0].id })
        .andWhere('status IN (:...eligible)', {
          eligible: [RS.PENDING, RS.APPROVED, RS.FAILED],
        })
        .andWhere(
          'EXISTS (SELECT 1 FROM "media_request" "parent" WHERE "parent"."id" = :requestId AND "parent"."mediaId" = :mediaId AND "parent"."type" = :type AND "parent"."is4k" = :is4k AND "parent"."requestedById" = :owner AND "parent"."status" IN (:...parents) AND ("parent"."serverId" = :source OR ("parent"."serverId" IS NULL AND :defaultSource = :source)))',
          {
            mediaId,
            type: MediaType.TV,
            is4k: request.is4k,
            owner: request.requestedBy.id,
            parents: [RS.APPROVED, RS.FAILED],
            source: observation.sourceId,
            defaultSource:
              getSettings().sonarr.find(
                (s) => s.isDefault && s.is4k === request.is4k
              )?.id ?? -1,
          }
        )
        .andWhere(
          'EXISTS (SELECT 1 FROM "season" "canonical" JOIN "media" "identity_media" ON "identity_media"."id" = "canonical"."mediaId" WHERE "canonical"."mediaId" = :mediaId AND "canonical"."seasonNumber" = :seasonNumber AND "canonical"."' +
            (request.is4k ? 'status4k' : 'status') +
            '" = :available AND "identity_media"."mediaType" = :type AND "identity_media"."tmdbId" = :tmdbId AND "identity_media"."tvdbId" = :tvdbId AND "identity_media"."' +
            (request.is4k ? 'serviceId4k' : 'serviceId') +
            '" = :source AND "identity_media"."' +
            (request.is4k ? 'externalServiceId4k' : 'externalServiceId') +
            '" = :seriesId)',
          {
            available: MediaStatus.AVAILABLE,
            tmdbId: observation.tmdbId,
            tvdbId: observation.tvdbId,
            seriesId: observation.sourceSeriesId,
          }
        )
        .callListeners(false)
        .execute();
    }
    if (!observation.isCurrent()) return completed;
    const winner = await transitionRequestStatus(
      manager,
      requestIdentity(request),
      [RS.APPROVED, RS.FAILED],
      RS.COMPLETED,
      undefined,
      true
    );
    if (winner) {
      completed++;
      await new MediaRequestSubscriber().handleRequestUpdate(winner, manager);
    }
  }
  return completed;
};
