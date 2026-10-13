import SonarrAPI from '@server/api/servarr/sonarr';
import {
  parseServarrSettingsUpdate,
  persistServarrSettingsUpdate,
  ServarrSettingsPersistenceError,
} from '@server/lib/servarrSettingsPersistence';
import type { SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { storageRootConfigurations } from '@server/lib/storageRootDisplayNames';
import logger from '@server/logger';
import { Router } from 'express';
import { ZodError } from 'zod';

const sonarrRoutes = Router();

sonarrRoutes.get('/', (_req, res) => {
  const settings = getSettings();

  res.status(200).json(settings.sonarr);
});

sonarrRoutes.post('/', async (req, res, next) => {
  try {
    const settings = getSettings();
    const currentSonarr = settings.sonarr.map((instance) => ({ ...instance }));
    const parsed = parseServarrSettingsUpdate('sonarr', req.body);
    const nextId =
      currentSonarr.reduce((maximum, item) => Math.max(maximum, item.id), -1) +
      1;
    const newSonarr = { ...parsed.settings, id: nextId } as SonarrSettings;
    const nextSonarr = currentSonarr.map((instance) => ({
      ...instance,
      isDefault:
        newSonarr.isDefault && instance.is4k === newSonarr.is4k
          ? false
          : instance.isDefault,
    }));
    nextSonarr.push(newSonarr);
    await persistServarrSettingsUpdate({
      servarrType: 'sonarr',
      nextSettings: nextSonarr,
      expectedSettings: currentSonarr,
      serviceId: nextId,
      rootFolderNames: parsed.rootFolderNames,
      settings,
    });
    return res.status(201).json(newSonarr);
  } catch (error) {
    if (error instanceof ZodError) {
      return next({ status: 400, message: 'Invalid Sonarr settings.' });
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

sonarrRoutes.post('/test', async (req, res, next) => {
  try {
    const sonarr = new SonarrAPI({
      apiKey: req.body.apiKey,
      url: SonarrAPI.buildUrl(req.body, '/api/v3'),
    });

    const systemStatus = await sonarr.getSystemStatus();
    const sonarrMajorVersion = Number(systemStatus.version.split('.')[0]);

    const urlBase = systemStatus.urlBase;
    const profiles = await sonarr.getProfiles();
    const folders = await sonarr.getRootFolders();
    const languageProfiles =
      sonarrMajorVersion <= 3 ? await sonarr.getLanguageProfiles() : null;
    const tags = await sonarr.getTags();
    const rootConfigurations = await storageRootConfigurations(
      'sonarr',
      Number.isSafeInteger(req.body.serviceId)
        ? Number(req.body.serviceId)
        : Number.NaN,
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
      languageProfiles,
      tags,
      urlBase,
    });
  } catch (e) {
    logger.error('Failed to test Sonarr', {
      label: 'Sonarr',
      message: e.message,
    });

    next({ status: 500, message: 'Failed to connect to Sonarr' });
  }
});

sonarrRoutes.put<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const settings = getSettings();
    const currentSonarr = settings.sonarr.map((instance) => ({ ...instance }));
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 0) {
      return next({ status: 400, message: 'Invalid Sonarr identifier.' });
    }
    const sonarrIndex = currentSonarr.findIndex((r) => r.id === id);
    if (sonarrIndex === -1) {
      return next({ status: 404, message: 'Settings instance not found' });
    }
    const parsed = parseServarrSettingsUpdate('sonarr', req.body);
    const updatedSonarr = { ...parsed.settings, id } as SonarrSettings;
    const nextSonarr = currentSonarr.map((instance, index) => ({
      ...(index === sonarrIndex ? updatedSonarr : instance),
      isDefault:
        updatedSonarr.isDefault &&
        index !== sonarrIndex &&
        instance.is4k === updatedSonarr.is4k
          ? false
          : index === sonarrIndex
            ? updatedSonarr.isDefault
            : instance.isDefault,
    }));
    await persistServarrSettingsUpdate({
      servarrType: 'sonarr',
      nextSettings: nextSonarr,
      expectedSettings: currentSonarr,
      serviceId: id,
      rootFolderNames: parsed.rootFolderNames,
      settings,
    });
    return res.status(200).json(nextSonarr[sonarrIndex]);
  } catch (error) {
    if (error instanceof ZodError) {
      return next({ status: 400, message: 'Invalid Sonarr settings.' });
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

sonarrRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  try {
    const settings = getSettings();
    const currentSonarr = settings.sonarr.map((instance) => ({ ...instance }));
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 0) {
      return next({ status: 400, message: 'Invalid Sonarr identifier.' });
    }
    const sonarrIndex = currentSonarr.findIndex((r) => r.id === id);
    if (sonarrIndex === -1) {
      return next({ status: 404, message: 'Settings instance not found' });
    }
    const removed = currentSonarr[sonarrIndex];
    await persistServarrSettingsUpdate({
      servarrType: 'sonarr',
      nextSettings: currentSonarr.filter((_, index) => index !== sonarrIndex),
      expectedSettings: currentSonarr,
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

export default sonarrRoutes;
