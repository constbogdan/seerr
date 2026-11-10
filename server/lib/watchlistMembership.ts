import type { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistMembershipResponse } from '@server/interfaces/api/discoverInterfaces';
import { z } from 'zod';

export const WATCHLIST_MEMBERSHIP_MAX_ITEMS = 100;

const identity = z
  .string()
  .regex(/^(movie|tv):[1-9]\d{0,15}$/)
  .transform((value) => {
    const [mediaType, id] = value.split(':');
    return { mediaType: mediaType as MediaType, tmdbId: Number(id) };
  })
  .refine(({ tmdbId }) => Number.isSafeInteger(tmdbId));

export const watchlistMembershipQuery = z
  .object({
    items: z
      .string()
      .max(WATCHLIST_MEMBERSHIP_MAX_ITEMS * 23)
      .transform((value) => value.split(','))
      .pipe(z.array(identity).min(1).max(WATCHLIST_MEMBERSHIP_MAX_ITEMS))
      .transform((items) => [
        ...new Map(
          items.map((item) => [`${item.mediaType}:${item.tmdbId}`, item])
        ).values(),
      ]),
  })
  .strict();

export const getWatchlistMembership = async (
  userId: number,
  items: z.infer<typeof watchlistMembershipQuery>['items']
): Promise<WatchlistMembershipResponse> => {
  // One bounded query, independent of the optional/reconstructable Media link.
  const rows = await getRepository(Watchlist)
    .createQueryBuilder('watchlist')
    .select('watchlist.mediaType', 'mediaType')
    .addSelect('watchlist.tmdbId', 'tmdbId')
    .where('watchlist.requestedById = :userId', { userId })
    // PostgreSQL's integer column must not narrow a valid safe-integer input.
    .andWhere('CAST(watchlist.tmdbId AS BIGINT) IN (:...ids)', {
      ids: [...new Set(items.map((item) => item.tmdbId))],
    })
    .getRawMany<{ mediaType: MediaType; tmdbId: number }>();
  const present = new Set(rows.map((row) => `${row.mediaType}:${row.tmdbId}`));
  return {
    results: items.map((item) => ({
      ...item,
      onWatchlist: present.has(`${item.mediaType}:${item.tmdbId}`),
    })),
  };
};
