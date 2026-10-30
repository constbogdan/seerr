import { LibraryRemovalSource } from '@server/constants/libraryHistory';
import type { RemovalTargetType } from '@server/constants/removal';
import type {
  LibraryActivityFilter,
  LibraryAnimationFilter,
  LibraryBulkActionRequest,
  LibraryCollectionCompletenessFilter,
  LibraryCollectionMembershipFilter,
  LibraryCollectionSort,
  LibraryLikedFilter,
  LibraryMediaTypeFilter,
  LibraryRequestedFilter,
  LibraryScheduledFilter,
  LibraryScope,
  LibrarySort,
  LibrarySortDirection,
  LibraryWatchedFilter,
  LibraryWatchlistFilter,
} from '@server/interfaces/api/libraryInterfaces';
import library, { type LibraryService } from '@server/lib/library';
import libraryBulkActions, {
  LibraryBulkActionValidationError,
  type LibraryBulkActionService,
} from '@server/lib/libraryBulkActions';
import libraryCollections, {
  type LibraryCollectionsService,
} from '@server/lib/libraryCollections';
import libraryPresentation, {
  type LibraryPresentationCoordinator,
} from '@server/lib/libraryPresentation';
import librarySelectionSize, {
  type LibrarySelectionSizeService,
} from '@server/lib/librarySelectionSize';
import mediaRemoval, { MediaRemovalError } from '@server/lib/mediaRemoval';
import { Permission } from '@server/lib/permissions';
import removalScheduler, {
  RemovalScheduleConflictError,
} from '@server/lib/removalScheduler';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';
import { z } from 'zod';

const commaSeparatedPositiveIntegers = z
  .string()
  .transform((value) => value.split(',').filter(Boolean).map(Number))
  .pipe(z.array(z.number().int().positive()).max(100))
  .optional();

const commaSeparatedRemovalSources = z
  .string()
  .transform((value) => value.split(',').filter(Boolean))
  .pipe(z.array(z.enum(['manual', 'scheduled', 'external', 'unknown'])).max(4))
  .optional();

const dateBound = z.string().date().optional();

const collectionsQuery = z.object({
  take: z.coerce.number().int().min(1).max(100).default(20),
  skip: z.coerce.number().int().nonnegative().default(0),
  completeness: z.enum(['all', 'complete', 'incomplete']).default('all'),
  sort: z.enum(['name', 'completeness', 'available']).default('name'),
  sortDirection: z.enum(['asc', 'desc']).default('asc'),
});

const listQuery = z.object({
  take: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().nonnegative().default(0),
  scope: z.enum(['current', 'archive', 'all']).default('current'),
  search: z.string().trim().max(300).optional(),
  mediaType: z.enum(['all', 'movie', 'series']).default('all'),
  collectionMembership: z.enum(['any', 'in', 'none']).default('any'),
  animation: z.enum(['any', 'yes', 'no']).default('any'),
  storageRootId: z.coerce.number().int().positive().optional(),
  storageRootIds: commaSeparatedPositiveIntegers,
  watchlist: z.enum(['any', 'yes', 'no']).default('any'),
  watched: z.enum(['any', 'yes', 'no']).default('any'),
  requested: z.enum(['any', 'yes', 'no']).default('any'),
  liked: z.enum(['any', 'yes', 'no']).default('any'),
  userId: z.coerce.number().int().positive().optional(),
  userIds: commaSeparatedPositiveIntegers,
  addedFrom: dateBound,
  addedTo: dateBound,
  activity: z.enum(['any', 'present', 'none']).default('any'),
  activityFrom: dateBound,
  activityTo: dateBound,
  sort: z
    .enum(['title', 'added', 'lastActive', 'size', 'removed', 'watchedUsers'])
    .default('size'),
  sortDirection: z.enum(['asc', 'desc']).default('desc'),
  scheduled: z.enum(['any', 'yes', 'no']).default('any'),
  removalDueFrom: dateBound,
  removalDueTo: dateBound,
  removedFrom: dateBound,
  removedTo: dateBound,
  removalSources: commaSeparatedRemovalSources,
});

const removalTarget = z
  .object({
    targetType: z.enum(['movie', 'series', 'season']),
    seasonNumber: z.number().int().nonnegative().optional(),
    sourceScope: z.string().trim().max(128).optional(),
  })
  .superRefine((value, context) => {
    if (value.targetType === 'season' && value.seasonNumber === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'seasonNumber is required for Season removal',
      });
    }
    if (value.targetType !== 'season' && value.seasonNumber !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'seasonNumber is valid only for Season removal',
      });
    }
  });

const bulkActionTarget = z
  .object({
    canonicalMediaId: z.number().int().positive(),
    targetType: z.enum(['movie', 'series', 'season']),
    seasonNumber: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.targetType === 'season' && value.seasonNumber === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'seasonNumber is required for a Season target',
      });
    }
    if (value.targetType !== 'season' && value.seasonNumber !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'seasonNumber is valid only for a Season target',
      });
    }
  });

const libraryTargetSelection = (maxItems: number) =>
  z
    .array(bulkActionTarget)
    .min(1)
    .max(maxItems)
    .superRefine((targets, context) => {
      const seen = new Set<string>();
      const seriesIds = new Set<number>();
      const seasonSeriesIds = new Set<number>();
      targets.forEach((target, index) => {
        const key =
          target.targetType === 'season'
            ? `season:${target.canonicalMediaId}:${target.seasonNumber}`
            : `${target.targetType}:${target.canonicalMediaId}`;
        if (seen.has(key)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Duplicate bulk-action target',
            path: [index],
          });
        }
        seen.add(key);
        if (target.targetType === 'series')
          seriesIds.add(target.canonicalMediaId);
        if (target.targetType === 'season')
          seasonSeriesIds.add(target.canonicalMediaId);
      });
      if ([...seriesIds].some((id) => seasonSeriesIds.has(id))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Whole-Series and Season targets cannot overlap',
        });
      }
    });

const bulkActionTargets = libraryTargetSelection(100);

const bulkActionEligibilityRequest = z
  .object({ targets: bulkActionTargets })
  .strict();

const selectionSizeRequest = z
  .object({ targets: libraryTargetSelection(5000) })
  .strict();

const bulkActionRequest = z
  .object({
    action: z.enum(['schedule', 'cancel_schedule', 'remove_now']),
    targets: bulkActionTargets,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === 'remove_now' && value.targets.length > 10) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Remove Now supports at most 10 targets per batch',
        path: ['targets'],
      });
    }
  });

export const createLibraryRouter = (
  service: Pick<
    LibraryService,
    'query' | 'seriesDetail' | 'userAvailability'
  > = library,
  bulkService: Pick<
    LibraryBulkActionService,
    'execute' | 'previewEligibility'
  > = libraryBulkActions,
  selectionSizeService: Pick<
    LibrarySelectionSizeService,
    'project'
  > = librarySelectionSize,
  presentationCoordinator: Pick<
    LibraryPresentationCoordinator,
    'status'
  > = libraryPresentation,
  collectionsService: Pick<
    LibraryCollectionsService,
    'query'
  > = libraryCollections
) => {
  const router = Router();

  router.get('/', isAuthenticated(Permission.ADMIN), async (req, res, next) => {
    try {
      const query = listQuery.parse(req.query);
      return res.status(200).json(
        await service.query({
          ...query,
          locale: req.locale ?? 'en',
          scope: query.scope as LibraryScope,
          mediaType: query.mediaType as LibraryMediaTypeFilter,
          collectionMembership:
            query.collectionMembership as LibraryCollectionMembershipFilter,
          animation: query.animation as LibraryAnimationFilter,
          requested: query.requested as LibraryRequestedFilter,
          liked: query.liked as LibraryLikedFilter,
          activity: query.activity as LibraryActivityFilter,
          watchlist: query.watchlist as LibraryWatchlistFilter,
          watched: query.watched as LibraryWatchedFilter,
          sort: query.sort as LibrarySort,
          sortDirection: query.sortDirection as LibrarySortDirection,
          scheduled: query.scheduled as LibraryScheduledFilter,
          removalSources: query.removalSources as
            | LibraryRemovalSource[]
            | undefined,
        })
      );
    } catch (error) {
      return next(error);
    }
  });

  router.get(
    '/collections',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      try {
        const query = collectionsQuery.parse(req.query);
        return res.status(200).json(
          await collectionsService.query({
            ...query,
            locale: req.locale ?? 'en',
            completeness:
              query.completeness as LibraryCollectionCompletenessFilter,
            sort: query.sort as LibraryCollectionSort,
            sortDirection: query.sortDirection as LibrarySortDirection,
          })
        );
      } catch (error) {
        return next(error);
      }
    }
  );

  router.get(
    '/user-availability',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      try {
        const query = listQuery.parse(req.query);
        return res.status(200).json(
          await service.userAvailability({
            ...query,
            locale: req.locale ?? 'en',
            scope: query.scope as LibraryScope,
            mediaType: query.mediaType as LibraryMediaTypeFilter,
            collectionMembership:
              query.collectionMembership as LibraryCollectionMembershipFilter,
            animation: query.animation as LibraryAnimationFilter,
            requested: query.requested as LibraryRequestedFilter,
            liked: query.liked as LibraryLikedFilter,
            activity: query.activity as LibraryActivityFilter,
            watchlist: query.watchlist as LibraryWatchlistFilter,
            watched: query.watched as LibraryWatchedFilter,
            sort: query.sort as LibrarySort,
            sortDirection: query.sortDirection as LibrarySortDirection,
            scheduled: query.scheduled as LibraryScheduledFilter,
            removalSources: query.removalSources as
              | LibraryRemovalSource[]
              | undefined,
          })
        );
      } catch (error) {
        return next(error);
      }
    }
  );

  router.post(
    '/bulk-actions/eligibility',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      const parsed = bulkActionEligibilityRequest.safeParse(req.body);
      if (!parsed.success) {
        return next({
          status: 400,
          message: 'Invalid Library bulk-action eligibility request.',
        });
      }
      try {
        return res
          .status(200)
          .json(await bulkService.previewEligibility(parsed.data.targets));
      } catch (error) {
        if (error instanceof LibraryBulkActionValidationError) {
          return next({ status: 400, message: error.message });
        }
        return next(error);
      }
    }
  );

  router.post(
    '/selection-size',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      const parsed = selectionSizeRequest.safeParse(req.body);
      if (!parsed.success) {
        return next({
          status: 400,
          message: 'Invalid Library selection-size request.',
        });
      }
      try {
        return res
          .status(200)
          .json(await selectionSizeService.project(parsed.data.targets));
      } catch (error) {
        if (error instanceof LibraryBulkActionValidationError) {
          return next({ status: 400, message: error.message });
        }
        return next(error);
      }
    }
  );

  router.post(
    '/bulk-actions',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      const parsed = bulkActionRequest.safeParse(req.body);
      if (!parsed.success) {
        return next({
          status: 400,
          message: 'Invalid Library bulk-action request.',
        });
      }
      try {
        return res
          .status(200)
          .json(
            await bulkService.execute(parsed.data as LibraryBulkActionRequest)
          );
      } catch (error) {
        if (error instanceof LibraryBulkActionValidationError) {
          return next({ status: 400, message: error.message });
        }
        return next(error);
      }
    }
  );

  router.get(
    '/presentation-status/:batchId',
    isAuthenticated(Permission.ADMIN),
    (req, res, next) => {
      try {
        const batchId = z.string().uuid().parse(req.params.batchId);
        return res.status(200).json(presentationCoordinator.status(batchId));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return next({
            status: 400,
            message: 'Invalid Library presentation batch.',
          });
        }
        return next(error);
      }
    }
  );

  router.get(
    '/:canonicalMediaId/series-detail',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      try {
        const canonicalMediaId = z.coerce
          .number()
          .int()
          .positive()
          .parse(req.params.canonicalMediaId);
        const detail = await service.seriesDetail(canonicalMediaId);
        if (!detail) return res.status(404).json({ message: 'Not found.' });
        return res.status(200).json(detail);
      } catch (error) {
        return next(error);
      }
    }
  );

  router.post(
    '/:canonicalMediaId/remove',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      try {
        const canonicalMediaId = z.coerce
          .number()
          .int()
          .positive()
          .parse(req.params.canonicalMediaId);
        const target = removalTarget.parse(req.body);
        const result = await mediaRemoval.remove({
          canonicalMediaId,
          targetType: target.targetType as RemovalTargetType,
          seasonNumber: target.seasonNumber,
          sourceScope: target.sourceScope,
          removalSource: LibraryRemovalSource.MANUAL,
        });
        const response = { ...result };
        delete response.affectedSchedules;
        return res.status(200).json(response);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return next({ status: 400, message: 'Invalid removal target.' });
        }
        if (error instanceof MediaRemovalError) {
          return next({
            status:
              error.code === 'NOT_FOUND' ? 404 : error.retryable ? 503 : 409,
            message: error.message,
          });
        }
        return next(error);
      }
    }
  );

  router.post(
    '/:canonicalMediaId/removal-schedules',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      try {
        const canonicalMediaId = z.coerce
          .number()
          .int()
          .positive()
          .parse(req.params.canonicalMediaId);
        const target = removalTarget.parse(req.body);
        return res.status(201).json(
          await removalScheduler.createManual({
            canonicalMediaId,
            targetType: target.targetType as RemovalTargetType,
            seasonNumber: target.seasonNumber,
            sourceScope: target.sourceScope,
          })
        );
      } catch (error) {
        if (error instanceof z.ZodError) {
          return next({ status: 400, message: 'Invalid removal target.' });
        }
        if (error instanceof RemovalScheduleConflictError) {
          return next({ status: 409, message: error.message });
        }
        if (error instanceof MediaRemovalError) {
          return next({
            status: error.code === 'NOT_FOUND' ? 404 : 409,
            message: error.message,
          });
        }
        return next(error);
      }
    }
  );

  router.delete(
    '/removal-schedules/:scheduleId',
    isAuthenticated(Permission.ADMIN),
    async (req, res, next) => {
      try {
        const id = z.coerce
          .number()
          .int()
          .positive()
          .parse(req.params.scheduleId);
        const schedule = await removalScheduler.cancelActionableById(id);
        if (!schedule)
          return res.status(404).json({ message: 'Schedule not found.' });
        return res.status(200).json(schedule);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return next({ status: 400, message: 'Invalid removal schedule.' });
        }
        if (error instanceof RemovalScheduleConflictError) {
          return next({ status: 409, message: error.message });
        }
        return next(error);
      }
    }
  );

  return router;
};

export default createLibraryRouter();
