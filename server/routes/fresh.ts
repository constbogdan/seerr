import { FRESH_PAGE_SIZE } from '@server/constants/fresh';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import FreshMedia from '@server/entity/FreshMedia';
import Media from '@server/entity/Media';
import type { FreshSort } from '@server/lib/fresh';
import freshService from '@server/lib/fresh/service';
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
    const related = await Media.getRelatedMedia(
      req.user,
      projection.map((item) => ({
        tmdbId: item.tmdbId,
        mediaType: item.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
      })),
      { includeActiveRequest: true }
    );
    const results = projection.map((item) => {
      const mediaInfo = related.find(
        (value) =>
          value.tmdbId === item.tmdbId && value.mediaType === item.mediaType
      );
      const common = {
        id: item.tmdbId,
        media_type: item.mediaType,
        genre_ids: item.genreIds,
        original_language: item.originalLanguage,
        overview: item.overview,
        popularity: item.popularity,
        vote_average: item.voteAverage,
        vote_count: item.voteCount,
        backdrop_path: item.backdropPath ?? undefined,
        poster_path: item.posterPath ?? undefined,
      };
      const result =
        item.mediaType === 'movie'
          ? mapMovieResult(
              {
                ...common,
                media_type: 'movie',
                adult: item.adult ?? false,
                title: item.displayTitle,
                original_title: item.originalTitle,
                release_date: item.mediaDate ?? '',
                video: item.video ?? false,
              },
              mediaInfo
            )
          : mapTvResult(
              {
                ...common,
                media_type: 'tv',
                name: item.displayTitle,
                original_name: item.originalTitle,
                first_air_date: item.mediaDate ?? '',
                origin_country: item.originCountries,
              },
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
  } catch {
    return next({ status: 500, message: 'Unable to retrieve Fresh media.' });
  }
});

export default freshRoutes;
