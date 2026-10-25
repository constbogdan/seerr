import { freshContentFilterSchema } from '@server/lib/fresh/contentFilters';
import freshService, {
  normalizeFreshSettings,
  publicFreshSettings,
} from '@server/lib/fresh/service';
import { getSettings, type FreshSettings } from '@server/lib/settings';
import { Router } from 'express';
import { z } from 'zod';

const freshSettingsRoutes = Router();
const updateSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().max(2048),
    apiToken: z.string().max(4096).optional(),
    filterId: z.number().int().nonnegative(),
    cachedFilterName: z.string().max(200),
    freshVisibilityDays: z.number().int().min(1).max(90),
    ...freshContentFilterSchema,
  })
  .strict();
const connectionSchema = z
  .object({
    baseUrl: z.string().max(2048).optional(),
    apiToken: z.string().max(4096).optional(),
  })
  .strict();

export const mergeFreshSettingsUpdate = (
  current: FreshSettings,
  body: unknown
): FreshSettings => {
  const update = updateSchema.parse(body);
  return normalizeFreshSettings({
    ...current,
    ...update,
    apiToken: update.apiToken?.trim() ? update.apiToken : current.apiToken,
  });
};
const connection = (body: unknown): FreshSettings => {
  const current = getSettings().fresh;
  const value = connectionSchema.parse(body);
  return {
    ...current,
    baseUrl: value.baseUrl?.trim() || current.baseUrl,
    apiToken: value.apiToken?.trim() || current.apiToken,
  };
};

freshSettingsRoutes.get('/', (_req, res) =>
  res.json(publicFreshSettings(getSettings().fresh))
);
freshSettingsRoutes.put('/', async (req, res, next) => {
  const settings = getSettings();
  const previous = { ...settings.fresh };
  try {
    settings.fresh = mergeFreshSettingsUpdate(previous, req.body);
    await settings.save();
    freshService.configure(settings.fresh);
    return res.json(publicFreshSettings(settings.fresh));
  } catch {
    settings.fresh = previous;
    return next({ status: 400, message: 'Unable to save Fresh settings.' });
  }
});
freshSettingsRoutes.post('/test', async (req, res, next) => {
  try {
    await freshService.test(connection(req.body));
    return res.json({ success: true });
  } catch {
    return next({ status: 502, message: 'Unable to connect to autobrr.' });
  }
});
freshSettingsRoutes.post('/filters', async (req, res, next) => {
  try {
    return res.json(await freshService.filters(connection(req.body)));
  } catch {
    return next({
      status: 502,
      message: 'Unable to retrieve autobrr filters.',
    });
  }
});
freshSettingsRoutes.get('/status', async (_req, res, next) => {
  try {
    return res.json(await freshService.status());
  } catch {
    return next({
      status: 503,
      message: 'Fresh status temporarily unavailable.',
    });
  }
});
export default freshSettingsRoutes;
