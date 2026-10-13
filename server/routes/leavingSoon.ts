import type { LibraryService } from '@server/lib/library';
import library from '@server/lib/library';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import { z } from 'zod';

const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
});

export const createLeavingSoonRouter = (
  service: Pick<LibraryService, 'query'> = library
) => {
  const router = Router();
  router.get('/', isAuthenticated(), async (req, res, next) => {
    try {
      const { page } = querySchema.parse(req.query);
      const pageSize = 20;
      const libraryResults = await service.query({
        take: pageSize,
        skip: (page - 1) * pageSize,
        scope: 'current',
        mediaType: 'all',
        watchlist: 'any',
        watched: 'any',
        scheduled: 'yes',
        sort: 'added',
        sortDirection: 'asc',
        locale: req.locale ?? 'en',
      });
      return res.status(200).json({
        pageInfo: libraryResults.pageInfo,
        results: libraryResults.results.map((item) => ({
          canonicalMediaId: item.canonicalMediaId,
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
          title: item.title,
          year: item.year,
          posterPath: item.posterPath,
          schedules: item.removalSchedules ?? [],
        })),
      });
    } catch (error) {
      return next(error);
    }
  });
  return router;
};

export default createLeavingSoonRouter();
