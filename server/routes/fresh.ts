import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import freshService from '@server/lib/fresh/service';
import { mapMovieResult, mapTvResult } from '@server/models/Search';
import { Router } from 'express';

const freshRoutes = Router();

freshRoutes.get('/', async (req, res, next) => {
  try {
    const projection = await freshService.results();
    const media = await Media.getRelatedMedia(
      req.user,
      projection.map((item) => ({
        tmdbId: item.tmdbId,
        mediaType: item.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
      })),
      { includeActiveRequest: true }
    );

    const results = projection.map((item) => {
      const mediaInfo = media.find(
        (value) =>
          value.tmdbId === item.tmdbId && value.mediaType === item.mediaType
      );
      const result =
        item.mediaType === 'movie'
          ? mapMovieResult(item.result as TmdbMovieResult, mediaInfo)
          : mapTvResult(item.result as TmdbTvResult, mediaInfo);
      return {
        ...result,
        mediaType: item.mediaType,
        freshFirstSeenAt: item.firstSeenAt,
      };
    });

    return res.status(200).json({
      page: 1,
      totalPages: 1,
      totalResults: results.length,
      results,
      status: freshService.status(),
    });
  } catch {
    return next({ status: 500, message: 'Unable to retrieve Fresh media.' });
  }
});

export default freshRoutes;
