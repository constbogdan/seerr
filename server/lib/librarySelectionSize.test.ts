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
} from '@server/entity/LibraryHistory';
import {
  LibrarySelectionSizeService,
  type LibrarySelectionSizeDependencies,
} from '@server/lib/librarySelectionSize';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('Library selected storage size', () => {
  it('deduplicates durable files across selected Seasons and reports unknown sizes', async () => {
    const service = new LibrarySelectionSizeService({
      validateTargets: async () => undefined,
      loadRows: async () => [
        {
          canonicalMediaId: 10,
          fileId: 1,
          sizeBytes: '100',
          seasonNumber: 1,
        },
        {
          canonicalMediaId: 10,
          fileId: 1,
          sizeBytes: '100',
          seasonNumber: 2,
        },
        {
          canonicalMediaId: 10,
          fileId: 2,
          sizeBytes: '250',
          seasonNumber: 2,
        },
        {
          canonicalMediaId: 10,
          fileId: 3,
          sizeBytes: null,
          seasonNumber: 1,
        },
      ],
    });

    const result = await service.project([
      { canonicalMediaId: 10, targetType: 'season', seasonNumber: 1 },
      { canonicalMediaId: 10, targetType: 'season', seasonNumber: 2 },
    ]);

    assert.equal(result.fileCount, 3);
    assert.equal(result.unknownFileCount, 1);
    assert.equal(result.sizeBytes, '350');
  });

  it('includes only explicit Seasons for a partial Series selection', async () => {
    const loadRows: LibrarySelectionSizeDependencies['loadRows'] = async () => [
      {
        canonicalMediaId: 20,
        fileId: 1,
        sizeBytes: '100',
        seasonNumber: 1,
      },
      {
        canonicalMediaId: 20,
        fileId: 2,
        sizeBytes: '200',
        seasonNumber: 2,
      },
    ];
    const service = new LibrarySelectionSizeService({
      validateTargets: async () => undefined,
      loadRows,
    });

    const partial = await service.project([
      { canonicalMediaId: 20, targetType: 'season', seasonNumber: 2 },
    ]);
    assert.equal(partial.sizeBytes, '200');
    assert.equal(partial.fileCount, 1);

    const whole = await service.project([
      { canonicalMediaId: 20, targetType: 'series' },
    ]);
    assert.equal(whole.sizeBytes, '300');
    assert.equal(whole.fileCount, 2);
  });

  it('returns unavailable when no applicable file has a reliable size', async () => {
    const service = new LibrarySelectionSizeService({
      validateTargets: async () => undefined,
      loadRows: async () => [
        {
          canonicalMediaId: 30,
          fileId: 1,
          sizeBytes: null,
          seasonNumber: null,
        },
      ],
    });
    const result = await service.project([
      { canonicalMediaId: 30, targetType: 'movie' },
    ]);
    assert.equal(result.sizeBytes, null);
    assert.equal(result.fileCount, 1);
    assert.equal(result.unknownFileCount, 1);
  });

  it('loads only authoritative current Servarr files in the default projection', async () => {
    const movie = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Selected Movie',
      })
    );
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Selected Series',
      })
    );
    const seasonOne = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
    );
    const seasonTwo = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 2 })
    );
    const episodeOne = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: seasonOne.id, episodeNumber: 1 })
    );
    const episodeTwo = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({ seasonId: seasonTwo.id, episodeNumber: 1 })
    );

    const savePresence = (
      canonicalMediaId: number,
      sourceItemId: string,
      values: Partial<LibraryPresence> = {}
    ) =>
      getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId,
          sourceSystem: 'sonarr',
          sourceScope: '1',
          sourceItemId,
          servarrHasFile: true,
          isCurrent: true,
          ...values,
        })
      );
    const moviePresence = await savePresence(movie.id, 'movie');
    moviePresence.sourceSystem = 'radarr';
    await getRepository(LibraryPresence).save(moviePresence);
    const seriesPresence = await savePresence(series.id, 'series');
    const archivedPresence = await savePresence(series.id, 'archive', {
      isCurrent: false,
    });
    const missingPresence = await savePresence(series.id, 'missing', {
      servarrHasFile: false,
    });

    const saveFile = (
      presence: LibraryPresence,
      sourceFileId: string,
      sizeBytes: string | null,
      isCurrent = true
    ) =>
      getRepository(LibraryFile).save(
        new LibraryFile({
          libraryPresenceId: presence.id,
          sourceSystem: presence.sourceSystem,
          sourceScope: presence.sourceScope,
          sourceFileId,
          sizeBytes,
          isCurrent,
        })
      );
    const movieFile = await saveFile(moviePresence, 'movie-file', '100');
    const sharedFile = await saveFile(seriesPresence, 'shared-file', '200');
    const seasonTwoFile = await saveFile(
      seriesPresence,
      'season-two-file',
      '300'
    );
    const archivedFile = await saveFile(
      archivedPresence,
      'archive-file',
      '900',
      false
    );
    const missingFile = await saveFile(missingPresence, 'missing-file', '800');
    await getRepository(LibraryFileEpisode).save([
      new LibraryFileEpisode({
        libraryFileId: sharedFile.id,
        canonicalEpisodeId: episodeOne.id,
      }),
      new LibraryFileEpisode({
        libraryFileId: sharedFile.id,
        canonicalEpisodeId: episodeTwo.id,
      }),
      new LibraryFileEpisode({
        libraryFileId: seasonTwoFile.id,
        canonicalEpisodeId: episodeTwo.id,
      }),
      new LibraryFileEpisode({
        libraryFileId: archivedFile.id,
        canonicalEpisodeId: episodeOne.id,
      }),
      new LibraryFileEpisode({
        libraryFileId: missingFile.id,
        canonicalEpisodeId: episodeOne.id,
      }),
    ]);

    const service = new LibrarySelectionSizeService();
    const result = await service.project([
      { canonicalMediaId: movie.id, targetType: 'movie' },
      {
        canonicalMediaId: series.id,
        targetType: 'season',
        seasonNumber: 1,
      },
    ]);
    assert.equal(result.sizeBytes, '300');
    assert.equal(result.fileCount, 2);
    assert.equal(result.unknownFileCount, 0);
    assert.ok(movieFile.id > 0);
  });
});
