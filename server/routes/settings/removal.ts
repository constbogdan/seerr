import removalScheduler, {
  RemovalScheduleConflictError,
} from '@server/lib/removalScheduler';
import { getSettings } from '@server/lib/settings';
import { Router } from 'express';
import { z } from 'zod';

const removalDelayDays = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(30),
  z.literal(60),
  z.literal(90),
]);

const policy = z
  .object({
    enabled: z.boolean(),
    minimumAgeMonths: z.number().int().min(0).max(120),
    inactivityMonths: z.number().int().min(0).max(120),
    itemsPerRun: z.number().int().min(0).max(1000),
  })
  .strict();

export const removalSettingsSchema = z
  .object({
    removalDelayDays,
    removalScanEnabled: z.boolean(),
    removalProcessingEnabled: z.boolean(),
    movie: policy,
    series: policy,
  })
  .strict();

const routes = Router();

const nextRemovalError = (error: unknown, next: (error: unknown) => void) => {
  if (error instanceof RemovalScheduleConflictError) {
    return next({ status: 409, message: error.message });
  }
  return next(error);
};

routes.get('/', (_req, res) => res.status(200).json(getSettings().removal));

routes.post('/', async (req, res, next) => {
  try {
    const settings = getSettings();
    settings.removal = removalSettingsSchema.parse(req.body);
    await settings.save();
    return res.status(200).json(settings.removal);
  } catch (error) {
    return nextRemovalError(error, next);
  }
});

routes.post('/preview', async (req, res, next) => {
  try {
    const proposed = removalSettingsSchema.parse(req.body);
    return res.status(200).json(await removalScheduler.preview(proposed));
  } catch (error) {
    return nextRemovalError(error, next);
  }
});

routes.post('/clear', async (_req, res, next) => {
  try {
    return res
      .status(200)
      .json(await removalScheduler.clearAllScheduledRemovals());
  } catch (error) {
    return nextRemovalError(error, next);
  }
});

export default routes;
