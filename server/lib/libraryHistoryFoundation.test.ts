import {
  HydrationRunStatus,
  IdentityResolutionState,
  LibraryMediaType,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import {
  HydrationRun,
  LibrarySourceObservation,
  SourceCheckpoint,
} from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const canonical = async (
  mediaType: LibraryMediaType,
  title: string,
  currentMediaId?: number
) =>
  getRepository(CanonicalMedia).save(
    new CanonicalMedia({ mediaType, titleSnapshot: title, currentMediaId })
  );

const seriesWithEpisodes = async () => {
  const series = await canonical(LibraryMediaType.SERIES, 'Series');
  const specials = await getRepository(CanonicalSeason).save(
    new CanonicalSeason({
      seriesId: series.id,
      seasonNumber: 0,
    })
  );
  const season = await getRepository(CanonicalSeason).save(
    new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
  );
  const first = await getRepository(CanonicalEpisode).save(
    new CanonicalEpisode({
      seasonId: season.id,
      episodeNumber: 1,
      airDate: '2026-01-01',
    })
  );
  const second = await getRepository(CanonicalEpisode).save(
    new CanonicalEpisode({
      seasonId: season.id,
      episodeNumber: 2,
      airDate: '2028-01-01',
    })
  );
  return { series, specials, season, first, second };
};

describe('Library History Foundation', () => {
  it('keeps typed canonical identities exact and never title-unique', async () => {
    const movie = await canonical(LibraryMediaType.MOVIE, 'Monster');
    const secondMovie = await canonical(LibraryMediaType.MOVIE, 'Monster');
    const series = await canonical(LibraryMediaType.SERIES, 'Monster');

    await getRepository(CanonicalMediaIdentity).save([
      new CanonicalMediaIdentity({
        canonicalMediaId: movie.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        value: '1050035',
      }),
      new CanonicalMediaIdentity({
        canonicalMediaId: series.id,
        mediaType: LibraryMediaType.SERIES,
        provider: 'tmdb',
        value: '1050035',
      }),
    ]);

    assert.notEqual(movie.id, secondMovie.id);
    assert.notEqual(movie.id, series.id);
    assert.equal(await getRepository(CanonicalMedia).count(), 3);
    await assert.rejects(
      getRepository(CanonicalMediaIdentity).save(
        new CanonicalMediaIdentity({
          canonicalMediaId: secondMovie.id,
          mediaType: LibraryMediaType.MOVIE,
          provider: 'tmdb',
          value: '1050035',
        })
      )
    );
    await assert.rejects(
      getRepository(CanonicalMediaIdentity).save(
        new CanonicalMediaIdentity({
          canonicalMediaId: movie.id,
          mediaType: LibraryMediaType.SERIES,
          provider: 'tvdb',
          value: '999',
        })
      )
    );
    await assert.rejects(
      getRepository(CanonicalSeason).save(
        new CanonicalSeason({ seriesId: movie.id, seasonNumber: 1 })
      )
    );

    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: secondMovie.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'jellyfin',
        sourceScope: 'server-b',
        value: 'item-1',
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: movie.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'jellyfin',
        sourceScope: 'server-a',
        value: 'item-1',
      })
    );
  });

  it('models Specials, future Episodes, scoped TV identity, and aliases', async () => {
    const { specials, season, first, second } = await seriesWithEpisodes();
    assert.equal(specials.seasonNumber, 0);
    assert.equal(second.airDate, '2028-01-01');

    await getRepository(CanonicalEpisodeIdentity).save(
      new CanonicalEpisodeIdentity({
        canonicalEpisodeId: first.id,
        provider: 'tvdb',
        value: 'episode-1',
      })
    );
    await assert.rejects(
      getRepository(CanonicalSeason).save(
        new CanonicalSeason({
          seriesId: season.seriesId,
          seasonNumber: season.seasonNumber,
        })
      )
    );
    await assert.rejects(
      getRepository(CanonicalEpisode).save(
        new CanonicalEpisode({
          seasonId: season.id,
          episodeNumber: first.episodeNumber,
        })
      )
    );
  });

  it('retains exact Viewer and resolved evidence when the current User is deleted', async () => {
    const user = await getRepository(User).save(
      new User({
        email: 'history-viewer@example.test',
        username: 'Old Name',
        avatar: '',
      })
    );
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: 'server-a',
        sourceUserId: 'exact-user-id',
        userId: user.id,
      })
    );
    const movie = await canonical(LibraryMediaType.MOVIE, 'Exact movie');
    const evidence = await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'server-a',
        sourceClass: 'native',
        sourceActivityId: 'activity-1',
        sourceUserId: 'exact-user-id',
        sourceItemId: 'missing-item',
        viewerId: viewer.id,
        canonicalMediaId: movie.id,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      })
    );

    await assert.rejects(
      getRepository(Viewer).save(
        new Viewer({
          source: 'jellyfin',
          sourceScope: 'server-a',
          sourceUserId: 'exact-user-id',
        })
      )
    );
    await getRepository(User).remove(user);

    const retainedViewer = await getRepository(Viewer).findOneByOrFail({
      id: viewer.id,
    });
    assert.equal(retainedViewer.userId, null);
    assert.equal(
      await getRepository(ViewingEvidence).countBy({ id: evidence.id }),
      1
    );
  });

  it('keeps resolved source evidence idempotent', async () => {
    const movie = await canonical(LibraryMediaType.MOVIE, 'Resolved');
    const evidence = await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'server-a',
        sourceClass: 'playback-reporting',
        sourceActivityId: '42',
        sourceGeneration: 'import-2026',
        sourceItemId: 'archived-item',
        canonicalMediaId: movie.id,
        playbackDurationSeconds: 1800,
        runtimeTicks: '54000000000',
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.LIKELY,
        completionDerivationVersion: 1,
      })
    );
    await assert.rejects(
      getRepository(ViewingEvidence).save(
        new ViewingEvidence({
          source: evidence.source,
          sourceScope: evidence.sourceScope,
          sourceClass: evidence.sourceClass,
          sourceActivityId: evidence.sourceActivityId,
          sourceGeneration: 'rerun-2027',
        })
      )
    );

    evidence.completionClassification =
      ViewingCompletionClassification.CONFIRMED;
    evidence.completionDerivationVersion = 2;
    const resolved = await getRepository(ViewingEvidence).save(evidence);
    assert.equal(resolved.id, evidence.id);
    assert.equal(resolved.sourceItemId, 'archived-item');

    const classifications = await getRepository(ViewingEvidence).save([
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'server-a',
        sourceClass: 'current-user-data',
        sourceActivityId: 'partial',
        canonicalMediaId: movie.id,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      }),
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'server-a',
        sourceClass: 'current-user-data',
        sourceActivityId: 'not-completed',
        canonicalMediaId: movie.id,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification:
          ViewingCompletionClassification.NO_QUALIFYING_EVIDENCE,
      }),
    ]);
    assert.deepEqual(
      classifications.map(
        ({ completionClassification }) => completionClassification
      ),
      [
        ViewingCompletionClassification.PARTIAL,
        ViewingCompletionClassification.NO_QUALIFYING_EVIDENCE,
      ]
    );
  });

  it('supports repeated presence intervals, roots, large files, and multi-Episode files', async () => {
    const { series, first, second } = await seriesWithEpisodes();
    const root = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'sonarr',
        serviceId: 3,
        sourceRootId: 7,
        nameSnapshot: 'Overflow Shows',
      })
    );
    const firstPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:3',
        sourceItemId: 'series:9',
        sourceGeneration: '1',
        storageRootId: root.id,
        isCurrent: false,
        removedAt: new Date('2026-10-01T00:00:00Z'),
      })
    );
    const currentPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:3',
        sourceItemId: 'series:9',
        sourceGeneration: '2',
        storageRootId: root.id,
      })
    );
    const secondCopy = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:4',
        sourceItemId: 'series:9',
        sourceGeneration: '1',
      })
    );
    assert.equal(secondCopy.storageRootId, null);
    assert.equal(secondCopy.pathSnapshot, null);
    assert.equal(secondCopy.logicalSizeBytes, null);
    assert.equal(secondCopy.addedAt, null);
    await assert.rejects(
      getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId: series.id,
          sourceSystem: 'sonarr',
          sourceScope: 'service:3',
          sourceItemId: 'series:9',
          sourceGeneration: '2',
        })
      )
    );
    const conflictingCanonical = await canonical(
      LibraryMediaType.SERIES,
      'Conflicting source identity'
    );
    await assert.rejects(
      getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId: conflictingCanonical.id,
          sourceSystem: 'sonarr',
          sourceScope: 'service:3',
          sourceItemId: 'series:9',
          sourceGeneration: '2',
        })
      )
    );

    await assert.rejects(
      getRepository(StorageRoot).save(
        new StorageRoot({
          servarrType: root.servarrType,
          serviceId: root.serviceId,
          sourceRootId: root.sourceRootId,
        })
      )
    );

    const file = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: currentPresence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:3',
        sourceFileId: 'episode-file:50',
        sourceGeneration: '1',
        storageRootId: root.id,
        sizeBytes: '10995116277760',
      })
    );
    await getRepository(LibraryFileEpisode).save([
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: first.id,
      }),
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: second.id,
      }),
    ]);
    const reloaded = await getRepository(LibraryFile).findOneByOrFail({
      id: file.id,
    });
    assert.equal(reloaded.sizeBytes, '10995116277760');
    assert.equal(
      await getRepository(LibraryFileEpisode).countBy({
        libraryFileId: file.id,
      }),
      2
    );
    assert.equal(
      await getRepository(LibraryPresence).countBy({
        canonicalMediaId: series.id,
      }),
      3
    );
    await assert.rejects(
      getRepository(LibraryPresence).remove(currentPresence)
    );
    assert.equal(
      await getRepository(LibraryPresence).countBy({ id: firstPresence.id }),
      1
    );
  });

  it('keeps canonical history after current Media deletion', async () => {
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 1203484, mediaType: MediaType.MOVIE })
    );
    const movie = await canonical(
      LibraryMediaType.MOVIE,
      'Current movie',
      media.id
    );
    const presence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: movie.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:0',
        sourceItemId: 'movie:10',
      })
    );
    await getRepository(Media).remove(media);
    const retained = await getRepository(CanonicalMedia).findOneByOrFail({
      id: movie.id,
    });
    assert.equal(retained.currentMediaId, null);
    assert.equal(
      await getRepository(LibraryPresence).countBy({ id: presence.id }),
      1
    );
  });

  it('stores restart-safe runs, checkpoints, and idempotent observations', async () => {
    const movie = await canonical(LibraryMediaType.MOVIE, 'Observed');
    const presence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: movie.id,
        sourceSystem: 'radarr',
        sourceScope: 'service:0',
        sourceItemId: 'movie:1',
      })
    );
    const run = await getRepository(HydrationRun).save(
      new HydrationRun({
        source: 'radarr',
        sourceScope: 'service:0',
        stage: 'current-library',
        status: HydrationRunStatus.SUCCEEDED,
        rowsInspected: 1,
        rowsCreated: 1,
      })
    );
    const checkpoint = await getRepository(SourceCheckpoint).save(
      new SourceCheckpoint({
        source: 'radarr',
        sourceScope: 'service:0',
        stage: 'current-library',
        cursor: 'movie:1',
        lastRunId: run.id,
      })
    );
    const observation = await getRepository(LibrarySourceObservation).save(
      new LibrarySourceObservation({
        libraryPresenceId: presence.id,
        source: 'radarr',
        sourceScope: 'service:0',
        sourceObservationId: 'movie:1:revision:1',
        hydrationRunId: run.id,
        logicalSizeBytes: '1000',
        observedAt: new Date(),
      })
    );
    await assert.rejects(
      getRepository(LibrarySourceObservation).save(
        new LibrarySourceObservation({
          libraryPresenceId: presence.id,
          source: observation.source,
          sourceScope: observation.sourceScope,
          sourceObservationId: observation.sourceObservationId,
          observedAt: new Date(),
        })
      )
    );
    await getRepository(HydrationRun).remove(run);
    assert.equal(
      (
        await getRepository(SourceCheckpoint).findOneByOrFail({
          id: checkpoint.id,
        })
      ).lastRunId,
      null
    );
    assert.equal(
      (
        await getRepository(LibrarySourceObservation).findOneByOrFail({
          id: observation.id,
        })
      ).hydrationRunId,
      null
    );
  });
});
