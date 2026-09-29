import type { TmdbSeasonWithEpisodes } from '@server/api/themoviedb/interfaces';
import type FreshMedia from '@server/entity/FreshMedia';
import type FreshObservation from '@server/entity/FreshObservation';
import { eligibilityForObservation } from '@server/lib/fresh/membership';

const DAY = 86_400_000;
export const FRESH_MOVIE_GRACE_DAYS = 14;
export const FRESH_TV_AIR_DATE_TOLERANCE_DAYS = 1;

export type FreshRecurringIdentity =
  | { identityKind: 'movie'; seasonKey: -1; specialEpisodeKey: -1 }
  | { identityKind: 'season'; seasonKey: number; specialEpisodeKey: -1 }
  | { identityKind: 'special'; seasonKey: 0; specialEpisodeKey: number };

export type FreshAdmissionDecision = {
  eligible: boolean;
  reason: string;
  firstObservedAt: Date;
  activityDate?: string;
  activitySource: string;
  ageDays?: number;
};

const dateOnly = (value: string | null | undefined): Date | undefined => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const result = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(result.getTime()) ? undefined : result;
};

export const recurringIdentityForEvidence = (value: {
  mediaType: 'movie' | 'tv';
  seasonKey: number;
  specialEpisodeKey: number;
  explicitSeason: boolean;
  explicitSpecial: boolean;
}): FreshRecurringIdentity | undefined => {
  if (value.mediaType === 'movie') {
    return { identityKind: 'movie', seasonKey: -1, specialEpisodeKey: -1 };
  }
  if (
    value.explicitSpecial &&
    value.seasonKey === 0 &&
    value.specialEpisodeKey > 0
  ) {
    return {
      identityKind: 'special',
      seasonKey: 0,
      specialEpisodeKey: value.specialEpisodeKey,
    };
  }
  if (value.explicitSeason && value.seasonKey > 0) {
    return {
      identityKind: 'season',
      seasonKey: value.seasonKey,
      specialEpisodeKey: -1,
    };
  }
  return undefined;
};

export const evaluateMovieAdmission = (
  media: FreshMedia,
  observations: Pick<FreshObservation, 'availabilityType' | 'observedAt'>[],
  eligibilityDays: number
): FreshAdmissionDecision | undefined => {
  const first = [...observations].sort(
    (left, right) => left.observedAt.getTime() - right.observedAt.getTime()
  )[0];
  if (!first) return undefined;
  const evaluation = eligibilityForObservation(media, first, eligibilityDays);
  if (evaluation.ageDays === undefined) {
    return {
      eligible: false,
      reason: 'movie_availability_unknown',
      firstObservedAt: first.observedAt,
      activitySource: evaluation.eligibilityDateSource,
    };
  }
  const inNormalWindow =
    evaluation.ageDays >= 0 && evaluation.ageDays <= eligibilityDays;
  const inGrace =
    evaluation.ageDays > eligibilityDays &&
    evaluation.ageDays <= eligibilityDays + FRESH_MOVIE_GRACE_DAYS;
  return {
    eligible: inNormalWindow || inGrace,
    reason: inNormalWindow
      ? 'eligible_movie'
      : inGrace
        ? 'eligible_movie_first_observation_grace'
        : evaluation.ageDays < 0
          ? 'movie_not_yet_available'
          : 'outside_movie_eligibility',
    firstObservedAt: first.observedAt,
    ...(evaluation.eligibilityDate
      ? { activityDate: evaluation.eligibilityDate }
      : {}),
    activitySource: evaluation.eligibilityDateSource,
    ageDays: evaluation.ageDays,
  };
};

export const selectTvActivityDate = (
  season: TmdbSeasonWithEpisodes,
  observationAt: Date,
  identity: Exclude<FreshRecurringIdentity, { identityKind: 'movie' }>
): { date?: string; source: string; reason?: string } => {
  const tolerance =
    observationAt.getTime() + FRESH_TV_AIR_DATE_TOLERANCE_DAYS * DAY;
  if (identity.identityKind === 'special') {
    const episode = season.episodes.find(
      (value) => value.episode_number === identity.specialEpisodeKey
    );
    const airDate = dateOnly(episode?.air_date);
    if (!airDate)
      return { source: 'tmdb_special_episode', reason: 'tv_activity_unknown' };
    if (airDate.getTime() > tolerance)
      return {
        date: episode?.air_date ?? undefined,
        source: 'tmdb_special_episode',
        reason: 'tv_not_yet_aired',
      };
    return {
      date: episode?.air_date ?? undefined,
      source: 'tmdb_special_episode',
    };
  }

  const latestEpisode = season.episodes
    .map((episode) => ({ episode, airDate: dateOnly(episode.air_date) }))
    .filter(
      (value): value is { episode: typeof value.episode; airDate: Date } =>
        !!value.airDate && value.airDate.getTime() <= tolerance
    )
    .sort((left, right) => right.airDate.getTime() - left.airDate.getTime())[0];
  if (latestEpisode) {
    return {
      date: latestEpisode.episode.air_date ?? undefined,
      source: 'tmdb_latest_aired_episode',
    };
  }
  const seasonDate = dateOnly(season.air_date);
  if (seasonDate && seasonDate.getTime() <= tolerance) {
    return { date: season.air_date, source: 'tmdb_season_air_date' };
  }
  if (
    season.episodes.some((episode) => {
      const value = dateOnly(episode.air_date);
      return value && value.getTime() > tolerance;
    }) ||
    (seasonDate && seasonDate.getTime() > tolerance)
  ) {
    return { source: 'tmdb_season', reason: 'tv_not_yet_aired' };
  }
  return { source: 'tmdb_season', reason: 'tv_activity_unknown' };
};

export const evaluateTvAdmission = (
  season: TmdbSeasonWithEpisodes,
  observationAt: Date,
  identity: Exclude<FreshRecurringIdentity, { identityKind: 'movie' }>,
  eligibilityDays: number
): FreshAdmissionDecision => {
  const activity = selectTvActivityDate(season, observationAt, identity);
  if (!activity.date) {
    return {
      eligible: false,
      reason: activity.reason ?? 'tv_activity_unknown',
      firstObservedAt: observationAt,
      activitySource: activity.source,
    };
  }
  const aired = dateOnly(activity.date);
  const ageDays = aired
    ? (observationAt.getTime() - aired.getTime()) / DAY
    : undefined;
  const eligible =
    ageDays !== undefined &&
    ageDays >= -FRESH_TV_AIR_DATE_TOLERANCE_DAYS &&
    ageDays <= eligibilityDays;
  return {
    eligible,
    reason: eligible ? 'eligible_tv_recent_activity' : 'historical_tv_season',
    firstObservedAt: observationAt,
    activityDate: activity.date,
    activitySource: activity.source,
    ...(ageDays === undefined ? {} : { ageDays }),
  };
};

export const freshVisibleUntil = (
  firstFreshAt: Date,
  visibilityDays: number
): Date => new Date(firstFreshAt.getTime() + visibilityDays * DAY);
