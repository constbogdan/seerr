import PlexTvAPI from '@server/api/plextv';
import { MediaType } from '@server/constants/media';
import {
  watchlistCategories,
  watchlistSorts,
  type WatchlistCategory,
  type WatchlistSort,
} from '@server/constants/watchlist';
import { getRepository } from '@server/datasource';
import type { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import type { SelectQueryBuilder } from 'typeorm';

export const WATCHLIST_PAGE_SIZE = 20;
export const WATCHLIST_ANIMATION_GENRE_ID = 16;

export interface WatchlistQuery {
  page: number;
  category: WatchlistCategory;
  sort: WatchlistSort;
}

export const parseWatchlistQuery = (query: {
  page?: unknown;
  category?: unknown;
  sort?: unknown;
}): WatchlistQuery => {
  const parsedPage = Number(query.page ?? 1);
  const page =
    Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const category = watchlistCategories.includes(
    query.category as WatchlistCategory
  )
    ? (query.category as WatchlistCategory)
    : 'all';
  const sort = watchlistSorts.includes(query.sort as WatchlistSort)
    ? (query.sort as WatchlistSort)
    : 'added_desc';

  return { page, category, sort };
};

export const hasUsablePlexWatchlistIdentity = (
  user: Pick<User, 'plexToken'>
): boolean => Boolean(user.plexToken?.trim());

const addAnimationPredicate = (
  queryBuilder: SelectQueryBuilder<Watchlist>,
  negate = false
) => {
  const predicate = `(watchlist.genreIds = :onlyAnimation
    OR watchlist.genreIds LIKE :animationFirst
    OR watchlist.genreIds LIKE :animationMiddle
    OR watchlist.genreIds LIKE :animationLast)`;

  queryBuilder.andWhere(negate ? `NOT ${predicate}` : predicate, {
    onlyAnimation: `[${WATCHLIST_ANIMATION_GENRE_ID}]`,
    animationFirst: `[${WATCHLIST_ANIMATION_GENRE_ID},%`,
    animationMiddle: `%,${WATCHLIST_ANIMATION_GENRE_ID},%`,
    animationLast: `%,${WATCHLIST_ANIMATION_GENRE_ID}]`,
  });
};

export const getLocalWatchlist = async ({
  userId,
  query,
}: {
  userId: number;
  query: WatchlistQuery;
}): Promise<WatchlistResponse> => {
  const queryBuilder = getRepository(Watchlist)
    .createQueryBuilder('watchlist')
    .leftJoinAndSelect('watchlist.requestedBy', 'requestedBy')
    .leftJoinAndSelect('watchlist.media', 'media')
    .addSelect('LOWER(watchlist.title)', 'watchlist_sort_title')
    .where('watchlist.requestedById = :userId', { userId });

  if (query.category === 'animation') {
    addAnimationPredicate(queryBuilder);
  } else if (query.category === 'movies' || query.category === 'series') {
    queryBuilder
      .andWhere('watchlist.mediaType = :mediaType', {
        mediaType: query.category === 'movies' ? MediaType.MOVIE : MediaType.TV,
      })
      .andWhere('watchlist.genreIds IS NOT NULL');
    addAnimationPredicate(queryBuilder, true);
  }

  if (query.sort === 'added_desc' || query.sort === 'added_asc') {
    queryBuilder
      .orderBy(
        'watchlist.createdAt',
        query.sort === 'added_desc' ? 'DESC' : 'ASC'
      )
      .addOrderBy('watchlist_sort_title', 'ASC');
  } else {
    queryBuilder.orderBy(
      'watchlist_sort_title',
      query.sort === 'title_asc' ? 'ASC' : 'DESC'
    );
  }

  queryBuilder
    .addOrderBy('watchlist.mediaType', 'ASC')
    .addOrderBy('watchlist.tmdbId', 'ASC')
    .addOrderBy('watchlist.id', 'ASC')
    .skip((query.page - 1) * WATCHLIST_PAGE_SIZE)
    .take(WATCHLIST_PAGE_SIZE);

  const [results, totalResults] = await queryBuilder.getManyAndCount();

  return {
    page: query.page,
    totalPages: Math.max(1, Math.ceil(totalResults / WATCHLIST_PAGE_SIZE)),
    totalResults,
    results,
    source: 'local',
    supportsPresentation: true,
  };
};

export const getPlexWatchlist = async ({
  plexToken,
  page,
}: {
  plexToken: string;
  page: number;
}): Promise<WatchlistResponse> => {
  const plexTV = new PlexTvAPI(plexToken);
  const watchlist = await plexTV.getWatchlist({
    offset: (page - 1) * WATCHLIST_PAGE_SIZE,
  });

  return {
    page,
    totalPages: Math.max(
      1,
      Math.ceil(watchlist.totalSize / WATCHLIST_PAGE_SIZE)
    ),
    totalResults: watchlist.totalSize,
    results: watchlist.items.map((item) => ({
      id: item.tmdbId,
      ratingKey: item.ratingKey,
      title: item.title,
      mediaType: item.type === 'show' ? 'tv' : 'movie',
      tmdbId: item.tmdbId,
    })),
    source: 'plex',
    supportsPresentation: false,
  };
};

export const getWatchlistForUser = async ({
  user,
  query,
}: {
  user: Pick<User, 'id' | 'plexToken'>;
  query: WatchlistQuery;
}): Promise<WatchlistResponse> => {
  const plexToken = user.plexToken?.trim();
  if (hasUsablePlexWatchlistIdentity(user) && plexToken) {
    return getPlexWatchlist({
      plexToken,
      page: query.page,
    });
  }

  return getLocalWatchlist({ userId: user.id, query });
};
