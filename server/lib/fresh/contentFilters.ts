import type { FreshProviderPresentation } from '@server/lib/fresh/presentation';
import type { FreshSettings } from '@server/lib/settings';
import { z } from 'zod';

export const freshContentFilterSchema = {
  excludeGenreIds: z
    .array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
    .max(1000)
    .optional(),
  excludeOriginalLanguages: z
    .array(z.string().regex(/^[a-z]{2}$/))
    .max(300)
    .optional(),
  minimumTmdbScore: z.number().min(0).max(10).optional(),
  minimumTmdbVotes: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
};

export const normalizeFreshContentFilters = (settings: FreshSettings) => {
  const value = z.object(freshContentFilterSchema).parse({
    excludeGenreIds: settings.excludeGenreIds,
    excludeOriginalLanguages: settings.excludeOriginalLanguages,
    minimumTmdbScore: settings.minimumTmdbScore,
    minimumTmdbVotes: settings.minimumTmdbVotes,
  });
  return {
    excludeGenreIds: [...new Set(value.excludeGenreIds ?? [])],
    excludeOriginalLanguages: [
      ...new Set(value.excludeOriginalLanguages ?? []),
    ],
    minimumTmdbScore: value.minimumTmdbScore ?? 0,
    minimumTmdbVotes: value.minimumTmdbVotes ?? 0,
  };
};
export const hasFreshContentFilters = (settings: FreshSettings) =>
  Boolean(
    settings.excludeGenreIds?.length ||
    settings.excludeOriginalLanguages?.length ||
    settings.minimumTmdbScore ||
    settings.minimumTmdbVotes
  );

export const matchesFreshContentFilters = (
  metadata: Partial<FreshProviderPresentation>,
  settings: FreshSettings
): boolean => {
  if (settings.excludeGenreIds?.length) {
    if (
      !Array.isArray(metadata.genres) ||
      metadata.genres.some((genre) => !Number.isSafeInteger(genre.id))
    )
      return false;
    if (
      metadata.genres.some((genre) =>
        settings.excludeGenreIds!.includes(genre.id)
      )
    )
      return false;
  }
  if (settings.excludeOriginalLanguages?.length) {
    if (
      typeof metadata.original_language !== 'string' ||
      !metadata.original_language
    )
      return false;
    if (settings.excludeOriginalLanguages.includes(metadata.original_language))
      return false;
  }
  if (
    (settings.minimumTmdbScore ?? 0) > 0 &&
    (typeof metadata.vote_average !== 'number' ||
      !Number.isFinite(metadata.vote_average) ||
      metadata.vote_average < settings.minimumTmdbScore! ||
      metadata.vote_average > 10)
  )
    return false;
  if (
    (settings.minimumTmdbVotes ?? 0) > 0 &&
    (!Number.isSafeInteger(metadata.vote_count) ||
      metadata.vote_count! < settings.minimumTmdbVotes!)
  )
    return false;
  return true;
};
