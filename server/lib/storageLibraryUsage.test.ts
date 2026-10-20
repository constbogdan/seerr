import { LibraryMediaType } from '@server/constants/libraryHistory';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import { loadLibraryStorageUsage } from '@server/lib/storageSettings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('Storage settings Library usage', () => {
  it('counts each current physical file once even when linked to multiple Episodes', async () => {
    const root = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'sonarr',
        serviceId: 2,
        sourceRootId: 21,
        pathSnapshot: '/volume4/media-shows',
      })
    );
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Shared file series',
      })
    );
    const presence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:2',
        sourceItemId: 'series:42',
        sourceGeneration: '1',
        storageRootId: root.id,
        isCurrent: true,
      })
    );
    const file = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:2',
        sourceFileId: 'episode-file:7',
        sourceGeneration: '1',
        storageRootId: root.id,
        sizeBytes: '700',
        isCurrent: true,
      })
    );
    const season = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
    );
    const episodes = await getRepository(CanonicalEpisode).save([
      new CanonicalEpisode({ seasonId: season.id, episodeNumber: 1 }),
      new CanonicalEpisode({ seasonId: season.id, episodeNumber: 2 }),
    ]);
    await getRepository(LibraryFileEpisode).save(
      episodes.map(
        (episode) =>
          new LibraryFileEpisode({
            libraryFileId: file.id,
            canonicalEpisodeId: episode.id,
          })
      )
    );

    assert.deepEqual(await loadLibraryStorageUsage(), [
      {
        provider: 'sonarr',
        serviceId: 2,
        sourceRootId: 21,
        sizeBytes: '700',
        pendingRemovalBytes: '0',
      },
    ]);
  });
});
