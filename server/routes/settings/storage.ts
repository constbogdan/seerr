import {
  MIN_OVERFLOW_THRESHOLD_GB,
  MIN_SERIES_SEASON_THRESHOLD,
  MIN_TORRENT_RELOCATION_DELAY_HOURS,
  normalizeOverflowSettings,
  type OverflowSettings,
} from '@server/constants/overflow';
import seriesRelocation, {
  type SeriesRelocationPreviewResult,
} from '@server/lib/seriesRelocation';
import { getSettings } from '@server/lib/settings';
import {
  discoverStorageLocations,
  validateOverflowRouteLocations,
  validateOverflowThresholds,
  validateSeriesPlacementVolumes,
} from '@server/lib/storageSettings';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

const volumeId = z.string().regex(/^(physical|location):[^\s]+$/);
export const OVERFLOW_ROUTE_REQUIRED_MESSAGE =
  'Configure at least one enabled storage route before enabling Overflow Routing.';
const overflowRouteSchema = z
  .object({
    sourceVolumeId: volumeId,
    destinationVolumeId: volumeId,
    thresholdGb: z.number().int().min(MIN_OVERFLOW_THRESHOLD_GB),
    enabled: z.boolean(),
  })
  .strict()
  .refine((route) => route.sourceVolumeId !== route.destinationVolumeId, {
    message: 'Source and destination volumes must be different.',
  });

export const overflowSettingsSchema = z
  .object({
    enabled: z.boolean(),
    freeSpaceThreshold: z.union([
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(20),
    ]),
    automaticSeriesPlacement: z.boolean(),
    defaultSeriesVolumeId: volumeId.nullable(),
    expansionSeriesVolumeId: volumeId.nullable(),
    seriesSeasonThreshold: z.number().int().min(MIN_SERIES_SEASON_THRESHOLD),
    torrentRelocationDelayHours: z
      .number()
      .int()
      .min(MIN_TORRENT_RELOCATION_DELAY_HOURS),
    routes: z.array(overflowRouteSchema),
  })
  .strict()
  .superRefine((settings, context) => {
    if (settings.enabled && !settings.routes.some((route) => route.enabled)) {
      context.addIssue({
        code: 'custom',
        path: ['routes'],
        message: OVERFLOW_ROUTE_REQUIRED_MESSAGE,
      });
    }
    if (
      settings.automaticSeriesPlacement &&
      (!settings.defaultSeriesVolumeId ||
        !settings.expansionSeriesVolumeId ||
        settings.defaultSeriesVolumeId === settings.expansionSeriesVolumeId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['automaticSeriesPlacement'],
        message:
          'Automatic Series Placement requires two different preferred volumes.',
      });
    }
    const seenSources = new Set<string>();
    settings.routes.forEach((route, index) => {
      if (seenSources.has(route.sourceVolumeId)) {
        context.addIssue({
          code: 'custom',
          path: ['routes', index],
          message: 'A source volume can have only one Overflow route.',
        });
      }
      seenSources.add(route.sourceVolumeId);
    });
  });

const storageRoutes = Router();

export const createSeriesRelocationPreviewHandler =
  (
    preview: () => Promise<SeriesRelocationPreviewResult> = () =>
      seriesRelocation.previewNextCandidate()
  ): RequestHandler =>
  async (_req, res, next) => {
    try {
      return res.status(200).json(await preview());
    } catch (error) {
      return next(error);
    }
  };

storageRoutes.get('/', async (_req, res, next) => {
  try {
    const settings = getSettings();
    const discovery = await discoverStorageLocations(settings);
    return res.status(200).json({
      settings: settings.overflow,
      ...discovery,
    });
  } catch (error) {
    return next(error);
  }
});

storageRoutes.get(
  '/series-relocation/next-candidate',
  createSeriesRelocationPreviewHandler()
);

storageRoutes.post('/', async (req, res, next) => {
  const parsed = overflowSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    const activationIssue = parsed.error.issues.find(
      (issue) => issue.message === OVERFLOW_ROUTE_REQUIRED_MESSAGE
    );
    return next({
      status: 400,
      message: activationIssue?.message ?? 'Invalid Overflow settings.',
    });
  }

  try {
    const settings = getSettings();
    const discovery = await discoverStorageLocations(settings);
    const validation = validateOverflowRouteLocations(
      parsed.data.routes,
      discovery
    );
    if (!validation.valid) {
      return next({ status: validation.status, message: validation.message });
    }
    const thresholdValidation = validateOverflowThresholds(
      parsed.data.routes,
      discovery
    );
    if (!thresholdValidation.valid) {
      return next({
        status: thresholdValidation.status,
        message: thresholdValidation.message,
      });
    }
    const seriesValidation = validateSeriesPlacementVolumes(
      parsed.data,
      discovery,
      parsed.data.automaticSeriesPlacement ||
        settings.jobs['series-relocation'].enabled === true
    );
    if (!seriesValidation.valid) {
      return next({
        status: seriesValidation.status,
        message: seriesValidation.message,
      });
    }

    const previous = settings.overflow;
    const nextSettings: OverflowSettings = normalizeOverflowSettings(
      parsed.data
    );
    settings.overflow = nextSettings;
    try {
      await settings.save();
    } catch (error) {
      settings.overflow = previous;
      throw error;
    }
    return res.status(200).json(settings.overflow);
  } catch (error) {
    return next(error);
  }
});

export default storageRoutes;
