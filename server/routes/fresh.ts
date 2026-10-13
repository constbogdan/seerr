import type {
  TmdbMovieDetails,
  TmdbMovieResult,
  TmdbTvDetails,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { FRESH_PAGE_SIZE } from '@server/constants/fresh';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import FreshMedia from '@server/entity/FreshMedia';
import Media from '@server/entity/Media';
import type { FreshSort } from '@server/lib/fresh';
import {
  freshPresentationKey,
  resolveFreshPagePresentation,
} from '@server/lib/fresh/presentation';
import freshService from '@server/lib/fresh/service';
import logger from '@server/logger';
import { mapMovieResult, mapTvResult } from '@server/models/Search';
import { Router } from 'express';

const freshRoutes = Router();
const sorts = new Set<FreshSort>([
  'freshest',
  'oldest',
  'title',
  'year',
  'vote_average.desc',
  'vote_average.asc',
]);

freshRoutes.get('/', async (req, res, next) => {
  let stage = 'status';
  try {
    const status = await freshService.status();
    if (status.status === 'disabled') {
      return res.status(200).json({
        page: 1,
        totalPages: 0,
        totalResults: 0,
        results: [],
        status,
      });
    }
    const page = Math.max(1, Number(req.query.page) || 1);
    const mediaType = ['movie', 'tv'].includes(String(req.query.mediaType))
      ? String(req.query.mediaType)
      : 'all';
    const requestedSort = String(req.query.sort || 'freshest') as FreshSort;
    const sort = sorts.has(requestedSort) ? requestedSort : 'freshest';
    stage = 'query';
    const repository = getRepository(FreshMedia);
    const query = repository
      .createQueryBuilder('fresh')
      .where('fresh.active = :active', { active: true });
    if (mediaType !== 'all')
      query.andWhere('fresh.mediaType = :mediaType', { mediaType });

    if (sort === 'freshest') query.orderBy('fresh.firstSeenAt', 'DESC');
    else if (sort === 'oldest') query.orderBy('fresh.firstSeenAt', 'ASC');
    else if (sort === 'title') query.orderBy('fresh.sortTitle', 'ASC');
    else if (sort === 'year')
      query
        .orderBy('CASE WHEN fresh.mediaDate IS NULL THEN 1 ELSE 0 END', 'ASC')
        .addOrderBy('fresh.mediaDate', 'DESC');
    else
      query.orderBy(
        'fresh.voteAverage',
        sort === 'vote_average.desc' ? 'DESC' : 'ASC'
      );
    query
      .addOrderBy('fresh.mediaType', 'ASC')
      .addOrderBy('fresh.tmdbId', 'ASC');

    const [projection, totalResults] = await query
      .skip((page - 1) * FRESH_PAGE_SIZE)
      .take(FRESH_PAGE_SIZE)
      .getManyAndCount();
    stage = 'enrichment';
    const [related, presentations] = await Promise.all([
      Media.getRelatedMedia(
        req.user,
        projection.map((item) => ({
          tmdbId: item.tmdbId,
          mediaType:
            item.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
        })),
        { includeActiveRequest: true }
      ),
      resolveFreshPagePresentation(projection, req.locale ?? 'en'),
    ]);
    stage = 'mapping';
    const results = projection.map((item) => {
      const mediaInfo = related.find(
        (value) =>
          value.tmdbId === item.tmdbId && value.mediaType === item.mediaType
      );
      const presentation = presentations.get(freshPresentationKey(item));
      const fallback = {
        id: item.tmdbId,
        media_type: item.mediaType,
        genre_ids: item.genreIds,
        original_language: item.originalLanguage,
        overview: '',
        popularity: 0,
        vote_average: item.voteAverage,
        vote_count: item.voteCount,
      };
      const result =
        item.mediaType === 'movie'
          ? mapMovieResult(
              (presentation
                ? {
                    ...(presentation as TmdbMovieDetails),
                    genre_ids:
                      (presentation as TmdbMovieDetails).genres?.map(
                        (genre) => genre.id
                      ) ?? [],
                    media_type: 'movie',
                  }
                : {
                    ...fallback,
                    media_type: 'movie',
                    adult: false,
                    title: item.displayTitle,
                    original_title: item.displayTitle,
                    release_date: item.mediaDate ?? '',
                    video: false,
                  }) as TmdbMovieResult,
              mediaInfo
            )
          : mapTvResult(
              (presentation
                ? {
                    ...(presentation as TmdbTvDetails),
                    genre_ids:
                      (presentation as TmdbTvDetails).genres?.map(
                        (genre) => genre.id
                      ) ?? [],
                    media_type: 'tv',
                  }
                : {
                    ...fallback,
                    media_type: 'tv',
                    name: item.displayTitle,
                    original_name: item.displayTitle,
                    first_air_date: item.mediaDate ?? '',
                    origin_country: [],
                  }) as TmdbTvResult,
              mediaInfo
            );
      return {
        ...result,
        freshFirstSeenAt: item.firstSeenAt.toISOString(),
      };
    });

    return res.status(200).json({
      page,
      totalPages: Math.ceil(totalResults / FRESH_PAGE_SIZE),
      totalResults,
      results,
      status,
    });
  } catch (error) {
    logger.error('Unable to retrieve Fresh media', {
      label: 'Fresh',
      stage,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    });
    return next({ status: 500, message: 'Unable to retrieve Fresh media.' });
  }
});

export default freshRoutes;
