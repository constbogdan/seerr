import type { LibraryService } from '@server/lib/library';
import library from '@server/lib/library';
import libraryPresentation, {
  type LibraryPresentationCoordinator,
} from '@server/lib/libraryPresentation';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import { z } from 'zod';

const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
});

export const createLeavingSoonRouter = (
  service: Pick<LibraryService, 'query'> = library,
  presentationCoordinator: Pick<
    LibraryPresentationCoordinator,
    'grantStatusAccess' | 'statusFor'
  > = libraryPresentation
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
      if (
        libraryResults.presentation?.state === 'pending' &&
        libraryResults.presentation.batchId
      ) {
        presentationCoordinator.grantStatusAccess(
          libraryResults.presentation.batchId,
          req.user!.id
        );
      }
      return res.status(200).json({
        pageInfo: libraryResults.pageInfo,
        presentation: libraryResults.presentation,
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
  router.get(
    '/presentation-status/:batchId',
    isAuthenticated(),
    (req, res, next) => {
      try {
        const batchId = z.string().uuid().parse(req.params.batchId);
        const status = presentationCoordinator.statusFor(batchId, req.user!.id);
        if (!status) {
          return res
            .status(404)
            .json({ message: 'Presentation batch not found.' });
        }
        return res.status(200).json(status);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return next({
            status: 400,
            message: 'Invalid Leaving Soon presentation batch.',
          });
        }
        return next(error);
      }
    }
  );
  return router;
};

export default createLeavingSoonRouter();
