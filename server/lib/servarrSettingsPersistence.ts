import { STORAGE_ROOT_COLOR_PALETTE } from '@server/constants/storageRoot';
import dataSource from '@server/datasource';
import type Settings from '@server/lib/settings';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import {
  saveStorageRootDisplayNames,
  type ServarrType,
  type StorageRootDisplayNameInput,
} from '@server/lib/storageRootDisplayNames';
import AsyncLock from '@server/utils/asyncLock';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';

const storageRootInput = z
  .object({
    sourceRootId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    path: z.string(),
    displayName: z
      .string()
      .transform((value) => value.trim())
      .pipe(z.string().max(120))
      .nullable()
      .optional(),
    isAnimation: z.boolean().optional(),
    color: z.preprocess(
      (value) =>
        typeof value === 'string' ? value.trim().toLowerCase() : value,
      z.enum(STORAGE_ROOT_COLOR_PALETTE).nullable().optional()
    ),
  })
  .strict();

const commonServarrSettings = z
  .object({
    id: z.number().int().nonnegative().optional(),
    name: z.string().min(1),
    hostname: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    apiKey: z.string().min(1),
    useSsl: z.boolean(),
    baseUrl: z.string().optional(),
    activeProfileId: z.number().int(),
    activeProfileName: z.string(),
    activeDirectory: z.string().min(1),
    tags: z.array(z.number().int()).optional(),
    is4k: z.boolean(),
    isDefault: z.boolean(),
    externalUrl: z.string().optional(),
    syncEnabled: z.boolean().optional(),
    preventSearch: z.boolean().optional(),
    tagRequests: z.boolean().optional(),
    overrideRule: z.array(z.number().int()).optional(),
    downloadQueueSize: z.number().int().min(10).max(1000).optional(),
    rootFolderNames: z.array(storageRootInput).optional(),
  })
  .strict();

const radarrSettings = commonServarrSettings.extend({
  minimumAvailability: z.string(),
});

const sonarrSettings = commonServarrSettings.extend({
  seriesType: z.enum(['standard', 'daily', 'anime']),
  animeSeriesType: z.enum(['standard', 'daily', 'anime']),
  activeAnimeProfileId: z.number().int().optional(),
  activeAnimeProfileName: z.string().optional(),
  activeAnimeDirectory: z.string().optional(),
  activeAnimeLanguageProfileId: z.number().int().optional(),
  activeLanguageProfileId: z.number().int().optional(),
  animeTags: z.array(z.number().int()).optional(),
  enableSeasonFolders: z.boolean(),
  monitorNewItems: z.enum(['all', 'none']),
});

export class ServarrSettingsPersistenceError extends Error {
  constructor(
    message: string,
    public readonly persistenceState: 'preserved' | 'partial',
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

interface ServarrSettingsStore {
  radarr: RadarrSettings[];
  sonarr: SonarrSettings[];
  save(): Promise<void>;
}

export interface PersistenceDependencies {
  transaction<T>(callback: (manager: EntityManager) => Promise<T>): Promise<T>;
  saveRoots(
    servarrType: ServarrType,
    serviceId: number,
    roots: StorageRootDisplayNameInput[],
    manager: EntityManager
  ): Promise<void>;
  saveSettings(settings: ServarrSettingsStore): Promise<void>;
}

const defaultDependencies: PersistenceDependencies = {
  transaction: (callback) => dataSource.transaction(callback),
  saveRoots: (servarrType, serviceId, roots, manager) =>
    saveStorageRootDisplayNames(servarrType, serviceId, roots, manager),
  saveSettings: (settings) => settings.save(),
};

const persistenceLock = new AsyncLock();

const cloneSettings = <T>(settings: T[]): T[] =>
  settings.map((item) => ({ ...item }));

export function parseServarrSettingsUpdate(
  servarrType: 'radarr',
  value: unknown
): {
  settings: RadarrSettings;
  rootFolderNames: StorageRootDisplayNameInput[];
};
export function parseServarrSettingsUpdate(
  servarrType: 'sonarr',
  value: unknown
): {
  settings: SonarrSettings;
  rootFolderNames: StorageRootDisplayNameInput[];
};
export function parseServarrSettingsUpdate(
  servarrType: ServarrType,
  value: unknown
): {
  settings: RadarrSettings | SonarrSettings;
  rootFolderNames: StorageRootDisplayNameInput[];
} {
  const parsed =
    servarrType === 'radarr'
      ? radarrSettings.parse(value)
      : sonarrSettings.parse(value);
  const { rootFolderNames = [], ...settings } = parsed;
  const seen = new Set<number>();
  for (const root of rootFolderNames) {
    if (seen.has(root.sourceRootId)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['rootFolderNames'],
          message: 'Storage root identifiers must be unique.',
        },
      ]);
    }
    seen.add(root.sourceRootId);
  }
  return {
    settings: settings as unknown as RadarrSettings | SonarrSettings,
    rootFolderNames,
  };
}

export const persistServarrSettingsUpdate = async ({
  servarrType,
  nextSettings,
  expectedSettings,
  serviceId,
  rootFolderNames,
  settings,
  dependencies = defaultDependencies,
}: {
  servarrType: ServarrType;
  nextSettings: (RadarrSettings | SonarrSettings)[];
  expectedSettings?: (RadarrSettings | SonarrSettings)[];
  serviceId: number;
  rootFolderNames: StorageRootDisplayNameInput[];
  settings: Settings | ServarrSettingsStore;
  dependencies?: PersistenceDependencies;
}): Promise<void> =>
  persistenceLock.dispatch('servarr-settings-persistence', async () => {
    const currentSettings = cloneSettings(
      (servarrType === 'radarr' ? settings.radarr : settings.sonarr) as (
        | RadarrSettings
        | SonarrSettings
      )[]
    );
    if (
      expectedSettings &&
      JSON.stringify(currentSettings) !== JSON.stringify(expectedSettings)
    ) {
      throw new ServarrSettingsPersistenceError(
        'Servarr settings changed while this update was pending. Refresh and retry.',
        'preserved'
      );
    }
    const previousSettings = currentSettings;
    const assignSettings = (
      values: (RadarrSettings | SonarrSettings)[]
    ): void => {
      if (servarrType === 'radarr') {
        settings.radarr = cloneSettings(values as RadarrSettings[]);
      } else {
        settings.sonarr = cloneSettings(values as SonarrSettings[]);
      }
    };
    let settingsFilePersisted = false;
    try {
      await dependencies.transaction(async (manager) => {
        await dependencies.saveRoots(
          servarrType,
          serviceId,
          rootFolderNames,
          manager
        );
        assignSettings(nextSettings);
        try {
          await dependencies.saveSettings(settings);
          settingsFilePersisted = true;
        } catch (error) {
          assignSettings(previousSettings);
          throw error;
        }
      });
    } catch (error) {
      assignSettings(previousSettings);
      if (settingsFilePersisted) {
        try {
          await dependencies.saveSettings(settings);
        } catch (compensationError) {
          throw new ServarrSettingsPersistenceError(
            'Servarr settings and Storage Root configuration may be inconsistent. Retry the same update after storage is available.',
            'partial',
            { cause: compensationError }
          );
        }
      }
      throw new ServarrSettingsPersistenceError(
        'The Servarr settings update was not applied. It is safe to retry.',
        'preserved',
        { cause: error }
      );
    }
  });
