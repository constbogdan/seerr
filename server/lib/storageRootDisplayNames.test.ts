import { getRepository } from '@server/datasource';
import { StorageRoot } from '@server/entity/LibraryHistory';
import {
  saveStorageRootDisplayNames,
  storageRootConfigurations,
  storageRootDisplayLabel,
  storageRootDisplayNames,
} from '@server/lib/storageRootDisplayNames';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('Storage root display names', () => {
  it('persists optional Radarr and Sonarr names by stable root identity', async () => {
    await saveStorageRootDisplayNames('radarr', 4, [
      {
        sourceRootId: 11,
        path: '/media/movies',
        displayName: '  Movies  ',
        isAnimation: true,
        color: '#60a5fa',
      },
    ]);
    await saveStorageRootDisplayNames('sonarr', 4, [
      {
        sourceRootId: 11,
        path: '/media/shows',
        displayName: 'Shows',
      },
    ]);

    assert.equal(
      (
        await getRepository(StorageRoot).findOneByOrFail({
          servarrType: 'radarr',
          serviceId: 4,
          sourceRootId: 11,
        })
      ).displayName,
      'Movies'
    );
    assert.equal(
      (
        await getRepository(StorageRoot).findOneByOrFail({
          servarrType: 'radarr',
          serviceId: 4,
          sourceRootId: 11,
        })
      ).isAnimation,
      true
    );
    assert.equal(
      (
        await getRepository(StorageRoot).findOneByOrFail({
          servarrType: 'radarr',
          serviceId: 4,
          sourceRootId: 11,
        })
      ).color,
      '#60a5fa'
    );
    const sonarrRoot = await getRepository(StorageRoot).findOneByOrFail({
      servarrType: 'sonarr',
      serviceId: 4,
      sourceRootId: 11,
    });
    assert.equal(sonarrRoot.displayName, 'Shows');
    assert.equal(sonarrRoot.isAnimation, false);
    assert.deepEqual(
      await storageRootDisplayNames('radarr', 4, [11]),
      new Map([[11, 'Movies']])
    );
    assert.deepEqual(
      await storageRootConfigurations('radarr', 4, [11]),
      new Map([
        [11, { displayName: 'Movies', isAnimation: true, color: '#60a5fa' }],
      ])
    );
  });

  it('clears blank overrides and falls back without changing discovered facts', async () => {
    const root = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 5,
        sourceRootId: 12,
        nameSnapshot: 'Discovered Movies',
        pathSnapshot: '/old/path',
        displayName: 'Old Name',
        isAnimation: true,
        color: '#f87171',
      })
    );

    await saveStorageRootDisplayNames('radarr', 5, [
      { sourceRootId: 12, path: '/new/path', displayName: '   ' },
    ]);
    const stored = await getRepository(StorageRoot).findOneByOrFail({
      id: root.id,
    });
    assert.equal(stored.displayName, null);
    assert.equal(stored.isAnimation, true);
    assert.equal(stored.color, '#f87171');
    assert.equal(stored.pathSnapshot, '/old/path');
    assert.equal(storageRootDisplayLabel(stored), 'Discovered Movies');
    assert.equal(
      storageRootDisplayLabel(
        new StorageRoot({
          id: 99,
          servarrType: 'sonarr',
          pathSnapshot: '/media/shows/',
        })
      ),
      'shows'
    );
  });

  it('clears colors and rejects values outside the configured palette', async () => {
    await saveStorageRootDisplayNames('sonarr', 8, [
      {
        sourceRootId: 20,
        path: '/media/shows',
        color: '#c084fc',
      },
      {
        sourceRootId: 21,
        path: '/media/anime',
        color: '#c084fc',
      },
    ]);
    assert.deepEqual(
      (
        await getRepository(StorageRoot).findBy({
          servarrType: 'sonarr',
          serviceId: 8,
        })
      ).map((root) => root.color),
      ['#c084fc', '#c084fc']
    );

    await saveStorageRootDisplayNames('sonarr', 8, [
      { sourceRootId: 20, path: '/media/shows', color: null },
      { sourceRootId: 21, path: '/media/anime', color: '#ffffff' },
    ]);
    assert.deepEqual(
      (
        await getRepository(StorageRoot).findBy({
          servarrType: 'sonarr',
          serviceId: 8,
        })
      ).map((root) => root.color),
      [null, null]
    );
  });

  it('reports an invalid legacy color as unset without rewriting the record', async () => {
    const root = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 9,
        sourceRootId: 22,
        pathSnapshot: '/media/movies',
        displayName: 'Movies',
        isAnimation: true,
        color: '#ffffff',
      })
    );

    assert.deepEqual(
      await storageRootConfigurations('radarr', 9, [22]),
      new Map([[22, { displayName: 'Movies', isAnimation: true, color: null }]])
    );
    assert.equal(
      (await getRepository(StorageRoot).findOneByOrFail({ id: root.id })).color,
      '#ffffff'
    );
  });
});
