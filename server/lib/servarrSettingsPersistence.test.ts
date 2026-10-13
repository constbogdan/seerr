import dataSource, { getRepository } from '@server/datasource';
import { StorageRoot } from '@server/entity/LibraryHistory';
import {
  ServarrSettingsPersistenceError,
  parseServarrSettingsUpdate,
  persistServarrSettingsUpdate,
  type PersistenceDependencies,
} from '@server/lib/servarrSettingsPersistence';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { saveStorageRootDisplayNames } from '@server/lib/storageRootDisplayNames';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const radarr = (id: number, name: string): RadarrSettings =>
  ({
    id,
    name,
    hostname: 'radarr.local',
    port: 7878,
    apiKey: 'test-key',
    useSsl: false,
    activeProfileId: 1,
    activeProfileName: 'HD',
    activeDirectory: '/movies',
    tags: [],
    is4k: false,
    isDefault: true,
    syncEnabled: true,
    preventSearch: false,
    tagRequests: false,
    overrideRule: [],
    minimumAvailability: 'released',
  }) as RadarrSettings;

const settingsStore = (initial: RadarrSettings[]) => ({
  radarr: initial,
  sonarr: [],
  async save() {},
});

const sonarr = (): SonarrSettings => {
  const common: Partial<RadarrSettings> = { ...radarr(0, 'Sonarr') };
  delete common.minimumAvailability;
  return {
    ...common,
    port: 8989,
    activeDirectory: '/series',
    seriesType: 'standard',
    animeSeriesType: 'anime',
    enableSeasonFolders: true,
    monitorNewItems: 'all',
  } as SonarrSettings;
};

const roots = [
  {
    sourceRootId: 7,
    path: '/movies',
    displayName: 'Movies',
    isAnimation: true,
    color: '#60a5fa',
  },
] as const;

describe('Servarr settings persistence', () => {
  it('validates the complete payload and rejects duplicate or invalid roots', () => {
    const valid = { ...radarr(0, 'Main'), rootFolderNames: roots };
    assert.equal(
      parseServarrSettingsUpdate('radarr', valid).settings.name,
      'Main'
    );
    assert.throws(() =>
      parseServarrSettingsUpdate('radarr', {
        ...valid,
        rootFolderNames: [roots[0], roots[0]],
      })
    );
    assert.throws(() =>
      parseServarrSettingsUpdate('radarr', {
        ...valid,
        rootFolderNames: [{ ...roots[0], color: '#ffffff' }],
      })
    );
    assert.equal(
      parseServarrSettingsUpdate('sonarr', sonarr()).settings.monitorNewItems,
      'all'
    );
    assert.throws(() =>
      parseServarrSettingsUpdate('sonarr', {
        ...sonarr(),
        monitorNewItems: 'future',
      })
    );
  });

  it('commits JSON state and Storage Roots as one coordinated update', async () => {
    const store = settingsStore([radarr(1, 'Old')]);
    let saves = 0;
    await persistServarrSettingsUpdate({
      servarrType: 'radarr',
      nextSettings: [radarr(1, 'New')],
      serviceId: 1,
      rootFolderNames: [...roots],
      settings: store,
      dependencies: {
        transaction: (callback) => dataSource.transaction(callback),
        saveRoots: (type, id, values, manager) =>
          saveStorageRootDisplayNames(type, id, values, manager),
        saveSettings: async () => {
          saves += 1;
        },
      },
    });
    assert.equal(store.radarr[0].name, 'New');
    assert.equal(saves, 1);
    const stored = await getRepository(StorageRoot).findOneByOrFail({
      servarrType: 'radarr',
      serviceId: 1,
      sourceRootId: 7,
    });
    assert.equal(stored.displayName, 'Movies');
    assert.equal(stored.isAnimation, true);
    assert.equal(stored.color, '#60a5fa');
  });

  it('rolls back Storage Roots and restores memory when JSON persistence fails', async () => {
    const store = settingsStore([radarr(2, 'Old')]);
    await assert.rejects(
      () =>
        persistServarrSettingsUpdate({
          servarrType: 'radarr',
          nextSettings: [radarr(2, 'New')],
          serviceId: 2,
          rootFolderNames: [...roots],
          settings: store,
          dependencies: {
            transaction: (callback) => dataSource.transaction(callback),
            saveRoots: (type, id, values, manager) =>
              saveStorageRootDisplayNames(type, id, values, manager),
            saveSettings: async () => {
              throw new Error('disk unavailable');
            },
          },
        }),
      (error: unknown) =>
        error instanceof ServarrSettingsPersistenceError &&
        error.persistenceState === 'preserved'
    );
    assert.equal(store.radarr[0].name, 'Old');
    assert.equal(
      await getRepository(StorageRoot).countBy({
        servarrType: 'radarr',
        serviceId: 2,
      }),
      0
    );
  });

  it('compensates JSON after a database commit-boundary failure', async () => {
    const store = settingsStore([radarr(3, 'Old')]);
    const savedNames: string[] = [];
    await assert.rejects(
      () =>
        persistServarrSettingsUpdate({
          servarrType: 'radarr',
          nextSettings: [radarr(3, 'New')],
          serviceId: 3,
          rootFolderNames: [...roots],
          settings: store,
          dependencies: {
            transaction: (callback) =>
              dataSource.transaction(async (manager) => {
                await callback(manager);
                throw new Error('commit failed');
              }),
            saveRoots: (type, id, values, manager) =>
              saveStorageRootDisplayNames(type, id, values, manager),
            saveSettings: async (current) => {
              savedNames.push(current.radarr[0].name);
            },
          },
        }),
      (error: unknown) =>
        error instanceof ServarrSettingsPersistenceError &&
        error.persistenceState === 'preserved'
    );
    assert.deepEqual(savedNames, ['New', 'Old']);
    assert.equal(store.radarr[0].name, 'Old');
  });

  it('reports partial persistence when compensation cannot be written', async () => {
    const store = settingsStore([radarr(4, 'Old')]);
    let saves = 0;
    await assert.rejects(
      () =>
        persistServarrSettingsUpdate({
          servarrType: 'radarr',
          nextSettings: [radarr(4, 'New')],
          serviceId: 4,
          rootFolderNames: [...roots],
          settings: store,
          dependencies: {
            transaction: (callback) =>
              dataSource.transaction(async (manager) => {
                await callback(manager);
                throw new Error('commit failed');
              }),
            saveRoots: (type, id, values, manager) =>
              saveStorageRootDisplayNames(type, id, values, manager),
            saveSettings: async () => {
              saves += 1;
              if (saves === 2) throw new Error('compensation failed');
            },
          },
        }),
      (error: unknown) =>
        error instanceof ServarrSettingsPersistenceError &&
        error.persistenceState === 'partial'
    );
    assert.equal(store.radarr[0].name, 'Old');
  });

  it('rejects a queued stale Save instead of overwriting the first update', async () => {
    const original = [radarr(5, 'Old')];
    const store = settingsStore(original);
    let markFirstSaveReached: (() => void) | undefined;
    const firstSaveReached = new Promise<void>((resolve) => {
      markFirstSaveReached = resolve;
    });
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveRelease = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let first = true;
    const dependencies: PersistenceDependencies = {
      transaction: (callback) => dataSource.transaction(callback),
      saveRoots: (type, id, values, manager) =>
        saveStorageRootDisplayNames(type, id, values, manager),
      saveSettings: async () => {
        if (first) {
          first = false;
          markFirstSaveReached?.();
          await firstSaveRelease;
        }
      },
    };
    const firstUpdate = persistServarrSettingsUpdate({
      servarrType: 'radarr',
      nextSettings: [radarr(5, 'First')],
      expectedSettings: original,
      serviceId: 5,
      rootFolderNames: [],
      settings: store,
      dependencies,
    });
    await firstSaveReached;
    const staleUpdate = persistServarrSettingsUpdate({
      servarrType: 'radarr',
      nextSettings: [radarr(5, 'Stale')],
      expectedSettings: original,
      serviceId: 5,
      rootFolderNames: [],
      settings: store,
      dependencies,
    });
    releaseFirstSave?.();
    await firstUpdate;
    await assert.rejects(
      staleUpdate,
      (error: unknown) =>
        error instanceof ServarrSettingsPersistenceError &&
        error.persistenceState === 'preserved'
    );
    assert.equal(store.radarr[0].name, 'First');
  });
});
