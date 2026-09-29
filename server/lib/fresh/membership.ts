import type { FreshAvailabilityType } from '@server/api/autobrr';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import type FreshMedia from '@server/entity/FreshMedia';
import type FreshObservation from '@server/entity/FreshObservation';
import type { FreshSettings } from '@server/lib/settings';

const DAY = 86_400_000;

export type FreshMembershipReason =
  | 'active_fresh'
  | 'outside_eligibility_window'
  | 'eligibility_unknown'
  | 'visibility_expired'
  | 'excluded_genre'
  | 'missing_required_genre'
  | 'excluded_original_language'
  | 'missing_required_original_language'
  | 'excluded_content_rating'
  | 'missing_required_content_rating'
  | 'below_tmdb_score'
  | 'below_tmdb_vote_count'
  | 'season_unknown'
  | 'source_generation_inactive';

export interface FreshMembershipEvaluation {
  active: boolean;
  reason: FreshMembershipReason;
  reasons: FreshMembershipReason[];
}

export type FreshEligibilityDateSource =
  | 'digital'
  | 'physical'
  | 'canonical_fallback'
  | 'tv_first_air_date'
  | 'unavailable';

export interface FreshObservationEligibility {
  observation: Pick<FreshObservation, 'availabilityType' | 'observedAt'>;
  eligibilityDate?: string;
  eligibilityDateSource: FreshEligibilityDateSource;
  ageDays?: number;
  qualifies: boolean;
}

export interface FreshAdmissionEvidence {
  status: 'qualifying' | 'outside' | 'unknown';
  selected?: FreshObservationEligibility;
  legacyUnknown: boolean;
}

const validDate = (value: string | null | undefined): Date | undefined => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

export const qualifiesAtObservation = (
  mediaDate: string | null | undefined,
  observationTime: Date,
  mediaEligibilityDays: number
): boolean => {
  const released = validDate(mediaDate);
  if (!released) return false;
  const age = observationTime.getTime() - released.getTime();
  return age >= 0 && age <= mediaEligibilityDays * DAY;
};

const earliestReleaseDate = (
  details: TmdbMovieDetails,
  region: string,
  type: 4 | 5
): string | null => {
  const regional = details.release_dates?.results.find(
    (release) => release.iso_3166_1 === region
  );
  return (
    regional?.release_dates
      .filter((release) => release.type === type)
      .map((release) => release.release_date.slice(0, 10))
      .filter((releaseDate) => validDate(releaseDate))
      .sort()[0] ?? null
  );
};

export const selectMovieAvailabilityDates = (
  details: TmdbMovieDetails,
  region: string
): { digital: string | null; physical: string | null } => ({
  digital: earliestReleaseDate(details, region, 4),
  physical: earliestReleaseDate(details, region, 5),
});

/**
 * Match the observed release class first, then the other home-release date,
 * and finally TMDB's canonical movie date. Unknown source evidence preserves
 * the previous canonical-date behavior. No date is synthesized.
 */
export const eligibilityDateForObservation = (
  media: FreshMedia,
  availability: FreshAvailabilityType
): string | null | undefined => {
  if (media.mediaType === 'tv') return media.mediaDate;
  if (availability === 'digital') {
    return (
      media.digitalReleaseDate ?? media.physicalReleaseDate ?? media.mediaDate
    );
  }
  if (availability === 'physical') {
    return (
      media.physicalReleaseDate ?? media.digitalReleaseDate ?? media.mediaDate
    );
  }
  return (
    media.mediaDate ?? media.digitalReleaseDate ?? media.physicalReleaseDate
  );
};

export const eligibilityForObservation = (
  media: FreshMedia,
  observation: Pick<FreshObservation, 'availabilityType' | 'observedAt'>,
  mediaEligibilityDays: number
): FreshObservationEligibility => {
  const eligibilityDate = eligibilityDateForObservation(
    media,
    observation.availabilityType
  );
  let eligibilityDateSource: FreshEligibilityDateSource = 'unavailable';
  if (media.mediaType === 'tv' && media.mediaDate) {
    eligibilityDateSource = 'tv_first_air_date';
  } else if (
    observation.availabilityType === 'digital' &&
    media.digitalReleaseDate
  ) {
    eligibilityDateSource = 'digital';
  } else if (
    observation.availabilityType === 'physical' &&
    media.physicalReleaseDate
  ) {
    eligibilityDateSource = 'physical';
  } else if (
    observation.availabilityType === 'digital' &&
    media.physicalReleaseDate
  ) {
    eligibilityDateSource = 'physical';
  } else if (
    observation.availabilityType === 'physical' &&
    media.digitalReleaseDate
  ) {
    eligibilityDateSource = 'digital';
  } else if (eligibilityDate) {
    eligibilityDateSource = 'canonical_fallback';
  }
  const released = validDate(eligibilityDate);
  const ageDays = released
    ? (observation.observedAt.getTime() - released.getTime()) / DAY
    : undefined;
  return {
    observation,
    ...(eligibilityDate ? { eligibilityDate } : {}),
    eligibilityDateSource,
    ...(ageDays === undefined ? {} : { ageDays }),
    qualifies: qualifiesAtObservation(
      eligibilityDate,
      observation.observedAt,
      mediaEligibilityDays
    ),
  };
};

export const evaluateAdmissionEvidence = (
  media: FreshMedia,
  observations: Pick<FreshObservation, 'availabilityType' | 'observedAt'>[],
  mediaEligibilityDays: number
): FreshAdmissionEvidence => {
  const evaluated = observations
    .map((observation) =>
      eligibilityForObservation(media, observation, mediaEligibilityDays)
    )
    .sort(
      (left, right) =>
        left.observation.observedAt.getTime() -
        right.observation.observedAt.getTime()
    );
  const qualifying = evaluated.find((result) => result.qualifies);
  const legacyUnknown =
    media.mediaType === 'movie' &&
    observations.some(
      (observation) => observation.availabilityType === 'unknown'
    );
  if (qualifying)
    return { status: 'qualifying', selected: qualifying, legacyUnknown };
  if (legacyUnknown)
    return { status: 'unknown', selected: evaluated[0], legacyUnknown };
  return { status: 'outside', selected: evaluated[0], legacyUnknown };
};

export const observationQualifies = (
  media: FreshMedia,
  observation: Pick<FreshObservation, 'availabilityType' | 'observedAt'>,
  mediaEligibilityDays: number
): boolean =>
  eligibilityForObservation(media, observation, mediaEligibilityDays).qualifies;

const intersects = <T>(values: T[], configured: T[]) =>
  configured.some((value) => values.includes(value));

const ratingKey = (media: FreshMedia) =>
  media.contentRating ? `${media.mediaType}:${media.contentRating}` : '';

export const evaluateFreshMembership = (
  media: FreshMedia,
  settings: FreshSettings,
  now: Date
): FreshMembershipEvaluation => {
  if (!media.admitted) {
    const reason = ['eligibility_unknown', 'season_unknown'].includes(
      media.membershipReason ?? ''
    )
      ? (media.membershipReason as 'eligibility_unknown' | 'season_unknown')
      : 'outside_eligibility_window';
    return {
      active: false,
      reason,
      reasons: [reason],
    };
  }
  if (
    now.getTime() >
    media.firstSeenAt.getTime() + settings.freshVisibilityDays * DAY
  ) {
    return {
      active: false,
      reason: 'visibility_expired',
      reasons: ['visibility_expired'],
    };
  }

  const reasons: FreshMembershipReason[] = [];
  if (intersects(media.genreIds, settings.excludeGenreIds))
    reasons.push('excluded_genre');
  if (
    settings.includeGenreIds.length > 0 &&
    !intersects(media.genreIds, settings.includeGenreIds)
  )
    reasons.push('missing_required_genre');
  if (settings.excludeOriginalLanguages.includes(media.originalLanguage))
    reasons.push('excluded_original_language');
  if (
    settings.includeOriginalLanguages.length > 0 &&
    !settings.includeOriginalLanguages.includes(media.originalLanguage)
  )
    reasons.push('missing_required_original_language');
  const contentRating = ratingKey(media);
  if (contentRating && settings.excludeContentRatings.includes(contentRating))
    reasons.push('excluded_content_rating');
  if (
    settings.includeContentRatings.length > 0 &&
    !settings.includeContentRatings.includes(contentRating)
  )
    reasons.push('missing_required_content_rating');
  if (
    settings.minimumTmdbScore > 0 &&
    media.voteAverage < settings.minimumTmdbScore
  ) {
    reasons.push('below_tmdb_score');
  }
  if (
    settings.minimumTmdbVotes > 0 &&
    media.voteCount < settings.minimumTmdbVotes
  ) {
    reasons.push('below_tmdb_vote_count');
  }
  return reasons.length
    ? { active: false, reason: reasons[0], reasons }
    : { active: true, reason: 'active_fresh', reasons: ['active_fresh'] };
};

export const applyFreshMembership = (
  media: FreshMedia,
  settings: FreshSettings,
  now: Date
): FreshMembershipEvaluation => {
  const result = evaluateFreshMembership(media, settings, now);
  media.active = result.active;
  media.membershipReason = result.reason;
  media.automaticReasons = result.reasons;
  return result;
};

export const selectContentRating = (
  mediaType: 'movie' | 'tv',
  details: TmdbMovieDetails | TmdbTvDetails,
  region: string
): string => {
  if (mediaType === 'tv') {
    return (
      (details as TmdbTvDetails).content_ratings?.results.find(
        (rating) => rating.iso_3166_1 === region
      )?.rating ?? ''
    );
  }
  const regional = (details as TmdbMovieDetails).release_dates?.results.find(
    (release) => release.iso_3166_1 === region
  );
  return (
    [...(regional?.release_dates ?? [])]
      .sort((left, right) => left.type - right.type)
      .find((release) => release.certification)?.certification ?? ''
  );
};
