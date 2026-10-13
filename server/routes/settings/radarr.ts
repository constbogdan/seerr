import RadarrAPI from '@server/api/servarr/radarr';
import {
  parseServarrSettingsUpdate,
  persistServarrSettingsUpdate,
  ServarrSettingsPersistenceError,
} from '@server/lib/servarrSettingsPersistence';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { storageRootConfigurations } from '@server/lib/storageRootDisplayNames';
import logger from '@server/logger';
import { Router } from 'express';
import { ZodError } from 'zod';

const radarrRoutes = Router();

radarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.radarr);
});

radarrRoutes.post('/', async (req, res, next) => {
  try {
    const settings = getSettings();
    const currentRadarr = settings.radarr.map((instance) => ({ ...instance }));
    const parsed = parseServarrSettingsUpdate('radarr', req.body);
    const nextId =
      currentRadarr.reduce((maximum, item) => Math.max(maximum, item.id), -1) +
      1;
    const newRadarr = { ...parsed.settings, id: nextId } as RadarrSettings;
    const nextRadarr = currentRadarr.map((instance) => ({
      ...instance,
      isDefault:
        newRadarr.isDefault && instance.is4k === newRadarr.is4k
          ? false
          : instance.isDefault,
    }));
    nextRadarr.push(newRadarr);
    await persistServarrSettingsUpdate({
      servarrType: 'radarr',
      nextSettings: nextRadarr,
      expectedSettings: currentRadarr,
      serviceId: nextId,
      rootFolderNames: parsed.rootFolderNames,
      settings,
    });
    return res.status(201).json(newRadarr);
  } catch (error) {
    if (error instanceof ZodError) {
      return next({ status: 400, message: 'Invalid Radarr settings.' });
    }
    if (error instanceof ServarrSettingsPersistenceError) {
      return res.status(error.persistenceState === 'partial' ? 500 : 503).json({
        message: error.message,
        persistenceState: error.persistenceState,
        retryable: true,
      });
    }
    return next(error);
  }
});

radarrRoutes.post<
  undefined,
  Record<string, unknown>,
  RadarrSettings & { serviceId?: number; tagLabel?: string }
>('/test', async (req, res, next) => {
  try {
    const radarr = new RadarrAPI({
      apiKey: req.body.apiKey,
      url: RadarrAPI.buildUrl(req.body, '/api/v3'),
    });

    const urlBase = await radarr
      .getSystemStatus()
      .then((value) => value.urlBase)
      .catch(() => req.body.baseUrl);
    const profiles = await radarr.getProfiles();
    const folders = await radarr.getRootFolders();
    const tags = await radarr.getTags();
    const rootConfigurations = await storageRootConfigurations(
      'radarr',
      req.body.serviceId ?? Number.NaN,
      folders.map((folder) => folder.id)
    );

    return res.status(200).json({
      profiles,
      rootFolders: folders.map((folder) => ({
        id: folder.id,
        path: folder.path,
        displayName: rootConfigurations.get(folder.id)?.displayName ?? null,
        isAnimation: rootConfigurations.get(folder.id)?.isAnimation ?? false,
        color: rootConfigurations.get(folder.id)?.color ?? null,
      })),
      tags,
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Radarr', {
      label: 'Radarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Radarr' });
  }
});

radarrRoutes.put<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const settings = getSettings();
    const currentRadarr = settings.radarr.map((instance) => ({ ...instance }));
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 0) {
      return next({ status: 400, message: 'Invalid Radarr identifier.' });
    }
    const radarrIndex = currentRadarr.findIndex((r) => r.id === id);
    if (radarrIndex === -1) {
      return next({ status: 404, message: 'Settings instance not found' });
    }
    const parsed = parseServarrSettingsUpdate('radarr', req.body);
    const updatedRadarr = { ...parsed.settings, id } as RadarrSettings;
    const nextRadarr = currentRadarr.map((instance, index) => ({
      ...(index === radarrIndex ? updatedRadarr : instance),
      isDefault:
        updatedRadarr.isDefault &&
        index !== radarrIndex &&
        instance.is4k === updatedRadarr.is4k
          ? false
          : index === radarrIndex
            ? updatedRadarr.isDefault
            : instance.isDefault,
    }));
    await persistServarrSettingsUpdate({
      servarrType: 'radarr',
      nextSettings: nextRadarr,
      expectedSettings: currentRadarr,
      serviceId: id,
      rootFolderNames: parsed.rootFolderNames,
      settings,
    });
    return res.status(200).json(nextRadarr[radarrIndex]);
  } catch (error) {
    if (error instanceof ZodError) {
      return next({ status: 400, message: 'Invalid Radarr settings.' });
    }
    if (error instanceof ServarrSettingsPersistenceError) {
      return res.status(error.persistenceState === 'partial' ? 500 : 503).json({
        message: error.message,
        persistenceState: error.persistenceState,
        retryable: true,
      });
    }
    return next(error);
  }
});

radarrRoutes.get<{ id: string }>('/:id/profiles', async (req, res, next) => {
  const settings = getSettings();

  const radarrSettings = settings.radarr.find(
    (r) => r.id === Number(req.params.id)
  );

  if (!radarrSettings) {
    return next({ status: '404', message: 'Settings instance not found' });
  }

  const radarr = new RadarrAPI({
    apiKey: radarrSettings.apiKey,
    url: RadarrAPI.buildUrl(radarrSettings, '/api/v3'),
  });

  const profiles = await radarr.getProfiles();

  return res.status(200).json(
    profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
    }))
  );
});

radarrRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const settings = getSettings();
    const currentRadarr = settings.radarr.map((instance) => ({ ...instance }));
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 0) {
      return next({ status: 400, message: 'Invalid Radarr identifier.' });
    }
    const radarrIndex = currentRadarr.findIndex((r) => r.id === id);
    if (radarrIndex === -1) {
      return next({ status: 404, message: 'Settings instance not found' });
    }
    const removed = currentRadarr[radarrIndex];
    await persistServarrSettingsUpdate({
      servarrType: 'radarr',
      nextSettings: currentRadarr.filter((_, index) => index !== radarrIndex),
      expectedSettings: currentRadarr,
      serviceId: id,
      rootFolderNames: [],
      settings,
    });
    return res.status(200).json(removed);
  } catch (error) {
    if (error instanceof ServarrSettingsPersistenceError) {
      return res.status(error.persistenceState === 'partial' ? 500 : 503).json({
        message: error.message,
        persistenceState: error.persistenceState,
        retryable: true,
      });
    }
    return next(error);
  }
});

export default radarrRoutes;
