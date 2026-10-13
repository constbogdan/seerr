import { MediaType } from '@server/constants/media';
import { z } from 'zod';

const tmdbIdentifier = z.preprocess(
  (value) =>
    typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : value,
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
);

export const watchlistCreate = z.object({
  ratingKey: z.coerce.string().optional(),
  tmdbId: tmdbIdentifier,
  mediaType: z.nativeEnum(MediaType),
  title: z.coerce.string().optional(),
});
