import {
  FreshMovieCriteriaSchema,
  FreshTvCriteriaSchema,
} from '@server/lib/discoverCriteria';
import freshService, {
  normalizeFreshSettings,
  publicFreshSettings,
} from '@server/lib/fresh/service';
import { getSettings, type FreshSettings } from '@server/lib/settings';
import { Router } from 'express';
import { z } from 'zod';

const freshSettingsRoutes = Router();

const FreshSettingsUpdateSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().max(2048),
    apiToken: z.string().max(4096).optional(),
    filterId: z.number().int().nonnegative(),
    candidateWindowDays: z.number().int().min(1).max(3650),
    maximumItems: z.number().int().min(1).max(100),
    movieCriteria: FreshMovieCriteriaSchema,
    tvCriteria: FreshTvCriteriaSchema,
  })
  .strict();

const FreshConnectionSchema = z
  .object({
    baseUrl: z.string().max(2048).optional(),
    apiToken: z.string().max(4096).optional(),
  })
  .strict();

const mergedConnectionSettings = (body: unknown): FreshSettings => {
  const settings = getSettings().fresh;
  const value = FreshConnectionSchema.parse(body);
  return {
    ...settings,
    baseUrl: value.baseUrl?.trim() || settings.baseUrl,
    apiToken: value.apiToken?.trim() ? value.apiToken : settings.apiToken,
  };
};

export const mergeFreshSettingsUpdate = (
  current: FreshSettings,
  body: unknown
): FreshSettings => {
  const update = FreshSettingsUpdateSchema.parse(body);
  return normalizeFreshSettings({
    ...update,
    apiToken: update.apiToken?.trim() ? update.apiToken : current.apiToken,
  });
};

freshSettingsRoutes.get('/', (_req, res) => {
  return res.status(200).json(publicFreshSettings(getSettings().fresh));
});

freshSettingsRoutes.put('/', async (req, res, next) => {
  try {
    const settings = getSettings();
    const fresh = mergeFreshSettingsUpdate(settings.fresh, req.body);
    settings.fresh = fresh;
    await settings.save();
    freshService.configure(settings.fresh);
    return res.status(200).json(publicFreshSettings(settings.fresh));
  } catch {
    return next({ status: 400, message: 'Invalid Fresh settings.' });
  }
});

freshSettingsRoutes.post('/test', async (req, res, next) => {
  try {
    await freshService.test(mergedConnectionSettings(req.body));
    return res.status(200).json({ success: true });
  } catch {
    return next({ status: 500, message: 'Unable to connect to autobrr.' });
  }
});

freshSettingsRoutes.post('/filters', async (req, res, next) => {
  try {
    const filters = await freshService.filters(
      mergedConnectionSettings(req.body)
    );
    return res.status(200).json(filters);
  } catch {
    return next({
      status: 500,
      message: 'Unable to retrieve autobrr filters.',
    });
  }
});

freshSettingsRoutes.get('/status', (_req, res) => {
  return res.status(200).json(freshService.status());
});

freshSettingsRoutes.get('/diagnostics', (_req, res) => {
  return res.status(200).json(freshService.diagnostics());
});

freshSettingsRoutes.post('/refresh', async (_req, res, next) => {
  try {
    await freshService.refresh();
    return res.status(200).json(freshService.status());
  } catch {
    return next({ status: 500, message: 'Unable to refresh Fresh.' });
  }
});

export default freshSettingsRoutes;
