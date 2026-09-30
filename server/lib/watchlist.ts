import PlexTvAPI from '@server/api/plextv';
import { MediaType } from '@server/constants/media';
import {
  watchlistCategories,
  watchlistSorts,
  watchlistWatchedFilters,
  type WatchState,
  type WatchlistCategory,
  type WatchlistSort,
  type WatchlistWatchedFilter,
} from '@server/constants/watchlist';
import { getRepository } from '@server/datasource';
import type { User } from '@server/entity/User';
import { UserMediaState } from '@server/entity/UserMediaState';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import type { SelectQueryBuilder } from 'typeorm';

export const WATCHLIST_PAGE_SIZE = 20;
export const WATCHLIST_ANIMATION_GENRE_ID = 16;

export interface WatchlistQuery {
  page: number;
  category: WatchlistCategory;
  sort: WatchlistSort;
  watched?: WatchlistWatchedFilter;
}

export const parseWatchlistQuery = (query: {
  page?: unknown;
  category?: unknown;
  sort?: unknown;
  watched?: unknown;
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
  const watched = watchlistWatchedFilters.includes(
    query.watched as WatchlistWatchedFilter
  )
    ? (query.watched as WatchlistWatchedFilter)
    : 'not_watched';

  return { page, category, sort, watched };
};

export const toWatchState = (played?: boolean | null): WatchState =>
  played === true ? 'watched' : played === false ? 'not_watched' : 'unknown';

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
  allUsers = false,
  query,
}: {
  userId?: number;
  allUsers?: boolean;
  query: WatchlistQuery;
}): Promise<WatchlistResponse> => {
  const queryBuilder = getRepository(Watchlist)
    .createQueryBuilder('watchlist')
    .leftJoinAndSelect('watchlist.requestedBy', 'requestedBy')
    .leftJoinAndSelect('watchlist.media', 'media')
    .leftJoinAndMapOne(
      'watchlist.userMediaState',
      UserMediaState,
      'userMediaState',
      `userMediaState.userId = watchlist.requestedById
        AND userMediaState.mediaType = watchlist.mediaType
        AND userMediaState.tmdbId = watchlist.tmdbId`
    )
    .addSelect('LOWER(watchlist.title)', 'watchlist_sort_title');

  if (allUsers) {
    queryBuilder.where('requestedBy.includeInUserMetrics = :included', {
      included: true,
    });
  } else {
    queryBuilder.where('watchlist.requestedById = :userId', { userId });
  }

  if (query.watched === 'watched') {
    queryBuilder.andWhere('userMediaState.jellyfinPlayed = :played', {
      played: true,
    });
  } else if (query.watched === 'not_watched') {
    queryBuilder.andWhere(
      '(userMediaState.jellyfinPlayed IS NULL OR userMediaState.jellyfinPlayed = :played)',
      { played: false }
    );
  }

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

  const [rows, totalResults] = await queryBuilder.getManyAndCount();
  const unclassifiedQuery = getRepository(Watchlist)
    .createQueryBuilder('watchlist')
    .select('watchlist.id', 'id')
    .where('watchlist.genreIds IS NULL');
  if (!allUsers) {
    unclassifiedQuery.andWhere('watchlist.requestedById = :userId', {
      userId,
    });
  }
  if (allUsers) {
    unclassifiedQuery
      .leftJoin('watchlist.requestedBy', 'requestedBy')
      .andWhere('requestedBy.includeInUserMetrics = :included', {
        included: true,
      });
  }
  const unclassifiedItem = await unclassifiedQuery
    .limit(1)
    .getRawOne<{ id: number }>();
  const hasUnclassifiedItems = Boolean(unclassifiedItem);
  const results = rows.map((row) => ({
    id: row.id,
    ratingKey: row.ratingKey,
    tmdbId: row.tmdbId,
    mediaType: row.mediaType,
    title: row.title,
    genreIds: row.genreIds,
    media: row.media,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    watchState: toWatchState(row.userMediaState?.jellyfinPlayed),
    ...(row.userMediaState?.jellyfinLastPlayedAt && {
      lastPlayedAt: row.userMediaState.jellyfinLastPlayedAt.toISOString(),
    }),
    ...(row.userMediaState?.jellyfinPlayStateSyncedAt && {
      watchStateSyncedAt:
        row.userMediaState.jellyfinPlayStateSyncedAt.toISOString(),
    }),
    requestedBy: {
      id: row.requestedBy.id,
      displayName: row.requestedBy.displayName,
      avatar: row.requestedBy.avatar,
    },
  }));

  return {
    page: query.page,
    totalPages: Math.max(1, Math.ceil(totalResults / WATCHLIST_PAGE_SIZE)),
    totalResults,
    results,
    source: 'local',
    supportsPresentation: true,
    supportsWatchState: true,
    hasUnclassifiedItems,
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
    supportsWatchState: false,
    hasUnclassifiedItems: false,
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
