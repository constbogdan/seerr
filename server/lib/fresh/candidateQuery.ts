import type { FreshMediaType } from '@server/api/autobrr';
import type TheMovieDb from '@server/api/themoviedb';
import {
  FreshMovieCriteriaSchema,
  FreshTvCriteriaSchema,
  movieDiscoverOptions,
  tvDiscoverOptions,
  type FreshMovieCriteria,
  type FreshTvCriteria,
} from '@server/lib/discoverCriteria';

type DiscoverMovieOptions = NonNullable<
  Parameters<TheMovieDb['getDiscoverMovies']>[0]
>;
type DiscoverTvOptions = NonNullable<
  Parameters<TheMovieDb['getDiscoverTv']>[0]
>;

export const DEFAULT_FRESH_WINDOW_DAYS = 90;
export const MIN_FRESH_WINDOW_DAYS = 1;
export const MAX_FRESH_WINDOW_DAYS = 3650;

export const normalizeFreshCriteria = (
  criteria: unknown,
  mediaType: FreshMediaType
): FreshMovieCriteria | FreshTvCriteria =>
  mediaType === 'movie'
    ? FreshMovieCriteriaSchema.parse(criteria)
    : FreshTvCriteriaSchema.parse(criteria);

export function candidateQueryOptions(
  criteria: FreshMovieCriteria,
  mediaType: 'movie',
  start: string,
  end: string
): DiscoverMovieOptions;
export function candidateQueryOptions(
  criteria: FreshTvCriteria,
  mediaType: 'tv',
  start: string,
  end: string
): DiscoverTvOptions;
export function candidateQueryOptions(
  criteria: FreshMovieCriteria | FreshTvCriteria,
  mediaType: FreshMediaType,
  start: string,
  end: string
): DiscoverMovieOptions | DiscoverTvOptions {
  if (mediaType === 'movie') {
    return movieDiscoverOptions({
      ...FreshMovieCriteriaSchema.parse(criteria),
      primaryReleaseDateGte: start,
      primaryReleaseDateLte: end,
    });
  }

  return tvDiscoverOptions({
    ...FreshTvCriteriaSchema.parse(criteria),
    firstAirDateGte: start,
    firstAirDateLte: end,
  });
}
