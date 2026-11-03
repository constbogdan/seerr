import type TheMovieDb from '@server/api/themoviedb';
import {
  MovieSortOptionsIterable,
  TvSortOptionsIterable,
} from '@server/api/themoviedb';
import { z } from 'zod';

type DiscoverMovieOptions = NonNullable<
  Parameters<TheMovieDb['getDiscoverMovies']>[0]
>;
type DiscoverTvOptions = NonNullable<
  Parameters<TheMovieDb['getDiscoverTv']>[0]
>;

export const DiscoverCriteriaSchema = z.object({
  page: z.coerce.string().optional(),
  primaryReleaseDateGte: z.coerce.string().optional(),
  primaryReleaseDateLte: z.coerce.string().optional(),
  firstAirDateGte: z.coerce.string().optional(),
  firstAirDateLte: z.coerce.string().optional(),
  studio: z.coerce.string().optional(),
  genre: z.coerce.string().optional(),
  keywords: z.coerce.string().optional(),
  excludeKeywords: z.coerce.string().optional(),
  language: z.coerce.string().optional(),
  withRuntimeGte: z.coerce.string().optional(),
  withRuntimeLte: z.coerce.string().optional(),
  voteAverageGte: z.coerce.string().optional(),
  voteAverageLte: z.coerce.string().optional(),
  voteCountGte: z.coerce.string().optional(),
  voteCountLte: z.coerce.string().optional(),
  network: z.coerce.string().optional(),
  watchProviders: z.coerce.string().optional(),
  watchRegion: z.coerce.string().optional(),
  status: z.coerce.string().optional(),
  certification: z.coerce.string().optional(),
  certificationGte: z.coerce.string().optional(),
  certificationLte: z.coerce.string().optional(),
  certificationCountry: z.coerce.string().optional(),
  certificationMode: z.enum(['exact', 'range']).optional(),
});

export const MovieDiscoverCriteriaSchema = DiscoverCriteriaSchema.omit({
  certificationMode: true,
}).extend({
  sortBy: z.enum(MovieSortOptionsIterable).optional().catch(undefined),
});

export const TvDiscoverCriteriaSchema = DiscoverCriteriaSchema.omit({
  certificationMode: true,
}).extend({
  sortBy: z.enum(TvSortOptionsIterable).optional().catch(undefined),
});

const freshOmissions = {
  page: true,
  primaryReleaseDateGte: true,
  primaryReleaseDateLte: true,
  firstAirDateGte: true,
  firstAirDateLte: true,
} as const;

export const FreshMovieCriteriaSchema = MovieDiscoverCriteriaSchema.omit({
  ...freshOmissions,
  network: true,
  status: true,
}).strict();
export const FreshTvCriteriaSchema = TvDiscoverCriteriaSchema.omit({
  ...freshOmissions,
  studio: true,
}).strict();

export type MovieDiscoverCriteria = z.infer<typeof MovieDiscoverCriteriaSchema>;
export type TvDiscoverCriteria = z.infer<typeof TvDiscoverCriteriaSchema>;
export type FreshMovieCriteria = z.infer<typeof FreshMovieCriteriaSchema>;
export type FreshTvCriteria = z.infer<typeof FreshTvCriteriaSchema>;

const date = (value?: string) =>
  value ? new Date(value).toISOString().split('T')[0] : undefined;

const commonOptions = (
  criteria: MovieDiscoverCriteria | TvDiscoverCriteria,
  language?: string
) => ({
  page: Number(criteria.page),
  language: language ?? criteria.language,
  originalLanguage: criteria.language,
  genre: criteria.genre,
  keywords: criteria.keywords,
  excludeKeywords: criteria.excludeKeywords,
  withRuntimeGte: criteria.withRuntimeGte,
  withRuntimeLte: criteria.withRuntimeLte,
  voteAverageGte: criteria.voteAverageGte,
  voteAverageLte: criteria.voteAverageLte,
  voteCountGte: criteria.voteCountGte,
  voteCountLte: criteria.voteCountLte,
  watchProviders: criteria.watchProviders,
  watchRegion: criteria.watchRegion,
  certification: criteria.certification,
  certificationGte: criteria.certificationGte,
  certificationLte: criteria.certificationLte,
  certificationCountry: criteria.certificationCountry,
});

export const movieDiscoverOptions = (
  criteria: MovieDiscoverCriteria,
  language?: string
): DiscoverMovieOptions => ({
  ...commonOptions(criteria, language),
  sortBy: criteria.sortBy,
  studio: criteria.studio,
  primaryReleaseDateGte: date(criteria.primaryReleaseDateGte),
  primaryReleaseDateLte: date(criteria.primaryReleaseDateLte),
});

export const tvDiscoverOptions = (
  criteria: TvDiscoverCriteria,
  language?: string
): DiscoverTvOptions => ({
  ...commonOptions(criteria, language),
  sortBy: criteria.sortBy,
  network: criteria.network ? Number(criteria.network) : undefined,
  withStatus: criteria.status,
  firstAirDateGte: date(criteria.firstAirDateGte),
  firstAirDateLte: date(criteria.firstAirDateLte),
});
