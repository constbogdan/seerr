import { ViewingCompletionClassification } from '@server/constants/libraryHistory';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import { LibraryFileEpisode } from '@server/entity/LibraryHistory';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { filterActiveCurrentViewingStates } from '@server/lib/currentViewingTargets';
import { normalizeJellyfinActivityDate } from '@server/lib/jellyfinViewingSource';

export interface ViewerCompletionProjection {
  viewerId: number;
  currentPlayed: boolean | null;
  playCount: number;
  progressBasisPoints: number | null;
  everCompleted: boolean;
  strongestCompletion: ViewingCompletionClassification | null;
  lastCompletedWatch: Date | null;
}

export interface MovieViewingProjection {
  canonicalMediaId: number;
  metricsPopulation: number;
  viewers: number[];
  completedBy: number[];
  watchedBy: number[];
  watchedCount: number;
  incompleteViewers: number[];
  lastCompletedWatch: Date | null;
  lastCompletedWatchClassification: ViewingCompletionClassification | null;
  currentUserStates: ViewerCompletionProjection[];
}

export interface SeasonViewerProjection {
  viewerId: number;
  watchedEpisodeCount: number;
  availableEpisodeCount: number;
  airedEpisodeCount: number;
  availableCompletionPercent: number | null;
  airedCompletionPercent: number | null;
  availableComplete: boolean;
  airedCaughtUp: boolean;
  lastCompletedEpisodeAt: Date | null;
  incomplete: boolean;
  hasCurrentProgress: boolean;
}

export interface SeasonViewingProjection {
  canonicalSeasonId: number;
  seriesId: number;
  seasonNumber: number;
  isSpecial: boolean;
  availableEpisodeCount: number;
  airedEpisodeCount: number;
  unknownAirDateCount: number;
  viewers: number[];
  completedByAvailable: number[];
  caughtUpByAired: number[];
  incompleteViewers: number[];
  lastCompletedWatch: Date | null;
  perViewer: SeasonViewerProjection[];
}

export interface SeriesViewingProjection {
  canonicalMediaId: number;
  viewers: number[];
  caughtUpUsers: number[];
  incompleteUsers: number[];
  lastCompletedWatch: Date | null;
  seasons: SeasonViewingProjection[];
}

interface CompletionFact {
  viewerId: number;
  episodeId?: number;
  classification: ViewingCompletionClassification;
  completedAt: Date | null;
}

const isCompletion = (classification: ViewingCompletionClassification) =>
  classification === ViewingCompletionClassification.CONFIRMED ||
  classification === ViewingCompletionClassification.LIKELY;

const strongest = (
  values: ViewingCompletionClassification[]
): ViewingCompletionClassification | null => {
  if (values.includes(ViewingCompletionClassification.CONFIRMED)) {
    return ViewingCompletionClassification.CONFIRMED;
  }
  if (values.includes(ViewingCompletionClassification.LIKELY)) {
    return ViewingCompletionClassification.LIKELY;
  }
  return null;
};

const latest = (dates: (Date | null | undefined)[]): Date | null =>
  dates
    .map((date) => normalizeJellyfinActivityDate(date))
    .filter((date): date is Date => Boolean(date))
    .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;

const includedViewerIds = async (): Promise<Set<number>> =>
  new Set(
    (
      await dataSource
        .createQueryBuilder()
        .select('viewer.id', 'id')
        .from(Viewer, 'viewer')
        .innerJoin('viewer.user', 'user')
        .where('user.includeInUserMetrics = :included', { included: true })
        .getRawMany()
    ).map((row: { id: number | string }) => Number(row.id))
  );

const completionFacts = (evidence: ViewingEvidence[]): CompletionFact[] =>
  evidence
    .filter((item) => isCompletion(item.completionClassification))
    .flatMap((item) =>
      item.viewerId
        ? [
            {
              viewerId: item.viewerId,
              episodeId: item.canonicalEpisodeId ?? undefined,
              classification: item.completionClassification,
              completedAt: item.observedEndAt ?? item.observedAt ?? null,
            },
          ]
        : []
    );

export const getMovieViewingProjection = async (
  canonicalMediaId: number
): Promise<MovieViewingProjection> => {
  const [included, evidence, unfilteredStates] = await Promise.all([
    includedViewerIds(),
    getRepository(ViewingEvidence).findBy({ canonicalMediaId }),
    getRepository(CurrentViewingState).findBy({
      canonicalMediaId,
      mediaType: 'movie',
    }),
  ]);
  const states = await filterActiveCurrentViewingStates(unfilteredStates);
  const facts = completionFacts(evidence).filter((fact) =>
    included.has(fact.viewerId)
  );
  const includedStates = states.filter((state) => included.has(state.viewerId));
  const viewerIds = new Set([
    ...facts.map((fact) => fact.viewerId),
    ...includedStates.map((state) => state.viewerId),
  ]);
  const currentUserStates = [...viewerIds]
    .map((viewerId): ViewerCompletionProjection => {
      const viewerEvidence = facts.filter((fact) => fact.viewerId === viewerId);
      const viewerStates = includedStates.filter(
        (state) => state.viewerId === viewerId
      );
      const state = viewerStates.sort(
        (left, right) => right.observedAt.getTime() - left.observedAt.getTime()
      )[0];
      const currentPlayed = viewerStates.some((item) => item.played)
        ? true
        : viewerStates.length > 0
          ? false
          : null;
      return {
        viewerId,
        currentPlayed,
        playCount: Math.max(0, ...viewerStates.map((item) => item.playCount)),
        progressBasisPoints:
          Math.max(
            -1,
            ...viewerStates.map((item) => item.progressBasisPoints ?? -1)
          ) >= 0
            ? Math.max(
                0,
                ...viewerStates.map((item) => item.progressBasisPoints ?? 0)
              )
            : (state?.progressBasisPoints ?? null),
        everCompleted:
          viewerEvidence.length > 0 || viewerStates.some((item) => item.played),
        strongestCompletion:
          strongest(viewerEvidence.map((item) => item.classification)) ??
          (viewerStates.some((item) => item.played)
            ? ViewingCompletionClassification.CONFIRMED
            : null),
        lastCompletedWatch: latest(
          viewerEvidence.map((item) => item.completedAt)
        ),
      };
    })
    .sort((left, right) => left.viewerId - right.viewerId);
  const completedBy = currentUserStates
    .filter((state) => state.everCompleted)
    .map((state) => state.viewerId);
  const watchedBy = currentUserStates
    .filter((state) => state.currentPlayed === true)
    .map((state) => state.viewerId);
  const incompleteViewers = currentUserStates
    .filter(
      (state) =>
        state.currentPlayed === false && (state.progressBasisPoints ?? 0) > 0
    )
    .map((state) => state.viewerId);
  const lastFact = facts
    .filter((fact) => fact.completedAt)
    .sort(
      (left, right) =>
        right.completedAt!.getTime() - left.completedAt!.getTime()
    )[0];
  return {
    canonicalMediaId,
    metricsPopulation: included.size,
    viewers: [...new Set([...watchedBy, ...incompleteViewers])],
    completedBy,
    watchedBy,
    watchedCount: watchedBy.length,
    incompleteViewers,
    lastCompletedWatch: lastFact?.completedAt ?? null,
    lastCompletedWatchClassification: lastFact?.classification ?? null,
    currentUserStates,
  };
};

const availableEpisodesForSeries = async (
  seriesId: number
): Promise<Set<number>> => {
  const rows = (await dataSource
    .createQueryBuilder()
    .select('DISTINCT link.canonicalEpisodeId', 'episodeId')
    .from(LibraryFileEpisode, 'link')
    .innerJoin('link.libraryFile', 'file')
    .innerJoin('file.libraryPresence', 'presence')
    .innerJoin('link.canonicalEpisode', 'episode')
    .innerJoin('episode.season', 'season')
    .where('season.seriesId = :seriesId', { seriesId })
    .andWhere('file.isCurrent = :current', { current: true })
    .andWhere('presence.isCurrent = :current', { current: true })
    .andWhere('presence.servarrHasFile = :hasFile', { hasFile: true })
    .andWhere(
      `EXISTS (SELECT 1 FROM "library_presence" visible WHERE visible."canonicalMediaId" = :seriesId AND visible."sourceSystem" = 'jellyfin' AND visible."isCurrent" = :current AND visible."jellyfinVisible" = :visible)`,
      { seriesId, current: true, visible: true }
    )
    .getRawMany()) as { episodeId: number | string }[];
  return new Set(rows.map((row) => Number(row.episodeId)));
};

export const getSeasonViewingProjection = async (
  canonicalSeasonId: number,
  today = new Date()
): Promise<SeasonViewingProjection> => {
  const season = await getRepository(CanonicalSeason).findOneByOrFail({
    id: canonicalSeasonId,
  });
  const episodes = await getRepository(CanonicalEpisode).findBy({
    seasonId: canonicalSeasonId,
  });
  const [included, available, evidence, unfilteredStates] = await Promise.all([
    includedViewerIds(),
    availableEpisodesForSeries(season.seriesId),
    episodes.length
      ? getRepository(ViewingEvidence)
          .createQueryBuilder('evidence')
          .where('evidence.canonicalEpisodeId IN (:...episodeIds)', {
            episodeIds: episodes.map((episode) => episode.id),
          })
          .getMany()
      : Promise.resolve([]),
    episodes.length
      ? getRepository(CurrentViewingState)
          .createQueryBuilder('state')
          .where('state.canonicalEpisodeId IN (:...episodeIds)', {
            episodeIds: episodes.map((episode) => episode.id),
          })
          .getMany()
      : Promise.resolve([]),
  ]);
  const states = await filterActiveCurrentViewingStates(unfilteredStates);
  const isSpecial = season.seasonNumber === 0;
  const relevant = episodes.filter((episode) =>
    isSpecial ? episode.isSpecial : !episode.isSpecial
  );
  const availableIds = new Set(
    relevant
      .filter((episode) => available.has(episode.id))
      .map((episode) => episode.id)
  );
  const todayKey = today.toISOString().slice(0, 10);
  const airedIds = new Set(
    relevant
      .filter((episode) => episode.airDate && episode.airDate <= todayKey)
      .map((episode) => episode.id)
  );
  const facts = completionFacts(evidence).filter(
    (fact) => included.has(fact.viewerId) && fact.episodeId
  );
  const includedStates = states.filter((state) => included.has(state.viewerId));
  const viewerIds = new Set([
    ...facts.map((fact) => fact.viewerId),
    ...includedStates.map((state) => state.viewerId),
  ]);
  const perViewer = [...viewerIds]
    .map((viewerId): SeasonViewerProjection => {
      const completed = new Set([
        ...facts
          .filter((fact) => fact.viewerId === viewerId)
          .map((fact) => fact.episodeId!),
        ...includedStates
          .filter((state) => state.viewerId === viewerId && state.played)
          .map((state) => state.canonicalEpisodeId!)
          .filter(Boolean),
      ]);
      const completedAvailable = [...availableIds].filter((id) =>
        completed.has(id)
      ).length;
      const completedAired = [...airedIds].filter((id) =>
        completed.has(id)
      ).length;
      const progress = includedStates.some(
        (state) =>
          state.viewerId === viewerId &&
          !state.played &&
          (state.progressBasisPoints ?? 0) > 0
      );
      const anyCompleted = completed.size > 0;
      const availableComplete =
        availableIds.size > 0 && completedAvailable === availableIds.size;
      const airedCaughtUp =
        airedIds.size > 0 && completedAired === airedIds.size;
      return {
        viewerId,
        watchedEpisodeCount: completed.size,
        availableEpisodeCount: availableIds.size,
        airedEpisodeCount: airedIds.size,
        availableCompletionPercent:
          availableIds.size > 0
            ? Math.round((completedAvailable / availableIds.size) * 10_000) /
              100
            : null,
        airedCompletionPercent:
          airedIds.size > 0
            ? Math.round((completedAired / airedIds.size) * 10_000) / 100
            : null,
        availableComplete,
        airedCaughtUp,
        lastCompletedEpisodeAt: latest(
          facts
            .filter((fact) => fact.viewerId === viewerId)
            .map((fact) => fact.completedAt)
        ),
        incomplete:
          (anyCompleted || progress) && (!availableComplete || !airedCaughtUp),
        hasCurrentProgress: progress,
      };
    })
    .sort((left, right) => left.viewerId - right.viewerId);
  return {
    canonicalSeasonId,
    seriesId: season.seriesId,
    seasonNumber: season.seasonNumber,
    isSpecial,
    availableEpisodeCount: availableIds.size,
    airedEpisodeCount: airedIds.size,
    unknownAirDateCount: relevant.filter((episode) => !episode.airDate).length,
    viewers: perViewer
      .filter(
        (viewer) => viewer.watchedEpisodeCount > 0 || viewer.hasCurrentProgress
      )
      .map((viewer) => viewer.viewerId),
    completedByAvailable: perViewer
      .filter((viewer) => viewer.availableComplete)
      .map((viewer) => viewer.viewerId),
    caughtUpByAired: perViewer
      .filter((viewer) => viewer.airedCaughtUp)
      .map((viewer) => viewer.viewerId),
    incompleteViewers: perViewer
      .filter((viewer) => viewer.incomplete)
      .map((viewer) => viewer.viewerId),
    lastCompletedWatch: latest(
      perViewer.map((viewer) => viewer.lastCompletedEpisodeAt)
    ),
    perViewer,
  };
};

export const getSeriesViewingProjection = async (
  canonicalMediaId: number,
  today = new Date()
): Promise<SeriesViewingProjection> => {
  await getRepository(CanonicalMedia).findOneByOrFail({ id: canonicalMediaId });
  const seasonRows = await getRepository(CanonicalSeason).findBy({
    seriesId: canonicalMediaId,
  });
  const seasons = await Promise.all(
    seasonRows
      .sort((left, right) => left.seasonNumber - right.seasonNumber)
      .map((season) => getSeasonViewingProjection(season.id, today))
  );
  const regular = seasons.filter((season) => !season.isSpecial);
  const viewers = new Set(regular.flatMap((season) => season.viewers));
  const caughtUpUsers = [...viewers].filter(
    (viewerId) =>
      regular.some((season) => season.airedEpisodeCount > 0) &&
      regular
        .filter((season) => season.airedEpisodeCount > 0)
        .every((season) => season.caughtUpByAired.includes(viewerId))
  );
  return {
    canonicalMediaId,
    viewers: [...viewers],
    caughtUpUsers,
    incompleteUsers: [...viewers].filter(
      (viewerId) => !caughtUpUsers.includes(viewerId)
    ),
    lastCompletedWatch: latest(
      regular.map((season) => season.lastCompletedWatch)
    ),
    seasons,
  };
};
