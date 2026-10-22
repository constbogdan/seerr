import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import {
  HydrationRunStatus,
  IdentityResolutionState,
  LibraryMediaType,
  SourceCheckpointStatus,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import {
  UserMediaIntentState,
  UserMediaIntentType,
} from '@server/constants/watchlist';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import {
  HydrationRun,
  SourceCheckpoint,
} from '@server/entity/LibraryHydration';
import { User } from '@server/entity/User';
import { UserMediaIntentOccurrence } from '@server/entity/UserMediaIntentOccurrence';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { Watchlist } from '@server/entity/Watchlist';
import { CurrentJellyfinViewingService } from '@server/lib/currentJellyfinViewing';
import { CurrentViewingLibraryIncompleteError } from '@server/lib/currentViewingRunCoordinator';
import {
  getBatchedUserItems,
  normalizeJellyfinActivityDate,
  runBounded,
} from '@server/lib/jellyfinViewingSource';
import {
  CurrentLibraryGenerationService,
  LibraryHydrationEpochService,
} from '@server/lib/libraryHydrationEpoch';
import {
  getMovieViewingProjection,
  getSeasonViewingProjection,
  getSeriesViewingProjection,
} from '@server/lib/libraryViewingProjection';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const SCOPE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USER_A = '11111111111111111111111111111111';
const USER_B = '22222222222222222222222222222222';
const MOVIE_ID = '33333333333333333333333333333333';
const NEW_MOVIE_ID = '88888888888888888888888888888888';
const EPISODE_ID = '44444444444444444444444444444444';
const EPISODE_TWO_ID = '55555555555555555555555555555555';

setupTestDb();

const jellyfinItem = ({
  id,
  type,
  played,
  progress = 0,
  playCount = played ? 1 : 0,
  lastPlayedDate,
}: {
  id: string;
  type: 'Movie' | 'Episode';
  played: boolean;
  progress?: number;
  playCount?: number;
  lastPlayedDate?: string;
}): JellyfinLibraryItemExtended =>
  ({
    Id: id,
    Name: 'Fixture',
    Type: type,
    LocationType: 'FileSystem',
    HasSubtitles: false,
    MediaType: 'Video',
    ProviderIds: {},
    RunTimeTicks: 10_000,
    UserData: {
      Played: played,
      PlayedPercentage: progress,
      PlaybackPositionTicks: progress * 100,
      PlayCount: playCount,
      LastPlayedDate: lastPlayedDate,
      IsFavorite: false,
      Key: id,
      ItemId: id,
    },
  }) as JellyfinLibraryItemExtended;

const createCurrentLibrary = async () => {
  const movie = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: 'Movie',
    })
  );
  const series = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.SERIES,
      titleSnapshot: 'Series',
    })
  );
  const season = await getRepository(CanonicalSeason).save(
    new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
  );
  const episode = await getRepository(CanonicalEpisode).save(
    new CanonicalEpisode({
      seasonId: season.id,
      episodeNumber: 1,
      airDate: '2026-01-01',
    })
  );
  const episodeTwo = await getRepository(CanonicalEpisode).save(
    new CanonicalEpisode({
      seasonId: season.id,
      episodeNumber: 2,
      airDate: '2026-02-01',
    })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: movie.id,
      mediaType: LibraryMediaType.MOVIE,
      provider: 'jellyfin',
      sourceScope: SCOPE,
      value: MOVIE_ID,
    })
  );
  await getRepository(CanonicalEpisodeIdentity).save([
    new CanonicalEpisodeIdentity({
      canonicalEpisodeId: episode.id,
      provider: 'jellyfin',
      sourceScope: SCOPE,
      value: EPISODE_ID,
      lastSeenSourceGeneration: '1',
    }),
    new CanonicalEpisodeIdentity({
      canonicalEpisodeId: episodeTwo.id,
      provider: 'jellyfin',
      sourceScope: SCOPE,
      value: EPISODE_TWO_ID,
      lastSeenSourceGeneration: '1',
    }),
  ]);
  await getRepository(LibraryPresence).save([
    new LibraryPresence({
      canonicalMediaId: movie.id,
      sourceSystem: 'jellyfin',
      sourceScope: SCOPE,
      sourceItemId: `movie:${MOVIE_ID}`,
      sourceGeneration: '1',
      firstObservedAt: new Date(),
      jellyfinVisible: true,
      isCurrent: true,
    }),
    new LibraryPresence({
      canonicalMediaId: series.id,
      sourceSystem: 'jellyfin',
      sourceScope: SCOPE,
      sourceItemId: '66666666666666666666666666666666',
      sourceGeneration: '1',
      firstObservedAt: new Date(),
      jellyfinVisible: true,
      isCurrent: true,
    }),
  ]);
  const sonarrPresence = await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: series.id,
      sourceSystem: 'sonarr',
      sourceScope: 'service:1',
      sourceItemId: '1',
      sourceGeneration: '1',
      firstObservedAt: new Date(),
      servarrHasFile: true,
      isCurrent: true,
    })
  );
  const file = await getRepository(LibraryFile).save(
    new LibraryFile({
      libraryPresenceId: sonarrPresence.id,
      sourceSystem: 'sonarr',
      sourceScope: 'service:1',
      sourceFileId: '10',
      sourceGeneration: '1',
      firstObservedAt: new Date(),
      isCurrent: true,
    })
  );
  await getRepository(LibraryFileEpisode).save([
    new LibraryFileEpisode({
      libraryFileId: file.id,
      canonicalEpisodeId: episode.id,
    }),
    new LibraryFileEpisode({
      libraryFileId: file.id,
      canonicalEpisodeId: episodeTwo.id,
    }),
  ]);
  await getRepository(SourceCheckpoint).save(
    new SourceCheckpoint({
      source: 'jellyfin',
      sourceScope: SCOPE,
      sourceGeneration: '1',
      stage: 'current-library',
      status: SourceCheckpointStatus.CURRENT,
      lastSuccessfulAt: new Date(),
    })
  );
  return { movie, series, season, episode, episodeTwo };
};

describe('shared Jellyfin viewing retrieval', () => {
  it('normalizes only exact Unix-epoch activity sentinels', () => {
    assert.equal(normalizeJellyfinActivityDate('1970-01-01T00:00:00Z'), null);
    assert.equal(normalizeJellyfinActivityDate(new Date(0)), null);
    assert.equal(
      normalizeJellyfinActivityDate('1969-12-31T23:59:59Z')?.toISOString(),
      '1969-12-31T23:59:59.000Z'
    );
  });
  it('batches exact item lookups at 100 IDs', async () => {
    const sizes: number[] = [];
    const ids = Array.from({ length: 205 }, (_, index) =>
      index.toString(16).padStart(32, '0')
    );
    const result = await getBatchedUserItems({
      client: {
        getUserItems: async ({ ids: batch }) => {
          sizes.push(batch.length);
          return batch.map((id) =>
            jellyfinItem({ id, type: 'Movie', played: false })
          );
        },
      },
      ids,
      userId: USER_A,
      fields: ['RunTimeTicks'],
    });
    assert.deepEqual(sizes, [100, 100, 5]);
    assert.equal(result.size, 205);
  });

  it('bounds concurrent workers', async () => {
    let active = 0;
    let peak = 0;
    await runBounded([1, 2, 3, 4, 5], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
    });
    assert.equal(peak, 2);
  });
});

describe('current Jellyfin viewing synchronization', () => {
  it('preserves completion while treating the exact Unix epoch as unknown activity', async () => {
    const { movie } = await createCurrentLibrary();
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: id === MOVIE_ID,
              lastPlayedDate: '1970-01-01T00:00:00.000Z',
            })
          ),
      }),
    });

    await service.run();

    const state = await getRepository(CurrentViewingState).findOneByOrFail({
      canonicalMediaId: movie.id,
      mediaType: 'movie',
    });
    assert.equal(state.played, true);
    assert.equal(state.lastPlayedAt, null);
    const evidence = await getRepository(ViewingEvidence).findOneByOrFail({
      canonicalMediaId: movie.id,
      completionClassification: ViewingCompletionClassification.CONFIRMED,
    });
    assert.equal(evidence.observedAt, null);
    assert.equal(evidence.observedEndAt, null);
    assert.equal(
      (
        await getRepository(CurrentViewingState).findBy({
          played: false,
        })
      ).every((item) => item.lastPlayedAt === null),
      true
    );
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        completionClassification: ViewingCompletionClassification.PARTIAL,
      }),
      0
    );
  });

  beforeEach(async () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    settings.jellyfin.serverId = SCOPE;
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    admin.jellyfinUserId = USER_A;
    admin.includeInUserMetrics = true;
    await getRepository(User).save(admin);
  });

  it('repairs persisted sentinel timing narrowly and reuses completion evidence', async () => {
    const { movie } = await createCurrentLibrary();
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceUserId: USER_A,
        userId: admin.id,
      })
    );
    await getRepository(CurrentViewingState).save(
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: SCOPE,
        sourceItemId: MOVIE_ID,
        mediaType: MediaType.MOVIE,
        canonicalMediaId: movie.id,
        played: true,
        playCount: 5,
        lastPlayedAt: new Date(0),
        progressBasisPoints: 10_000,
        observedAt: new Date('2026-09-01T00:00:00.000Z'),
      })
    );
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceClass: 'current-user-data',
        sourceActivityId: `${USER_A}:${MOVIE_ID}:1970-01-01T00:00:00.000Z`,
        sourceUserId: USER_A,
        sourceItemId: MOVIE_ID,
        viewerId: viewer.id,
        canonicalMediaId: movie.id,
        observedAt: new Date(0),
        observedEndAt: new Date(0),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
        provenance: 'jellyfin-current-user-data',
      })
    );
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: id === MOVIE_ID,
              lastPlayedDate:
                id === MOVIE_ID ? '1970-01-01T00:00:00.000Z' : undefined,
            })
          ),
      }),
    });
    const summary = await service.run();
    assert.equal(summary.sentinelStatesNormalized, 1);
    assert.equal(summary.sentinelEvidenceNormalized, 1);
    const evidence = await getRepository(ViewingEvidence).findBy({
      canonicalMediaId: movie.id,
      completionClassification: ViewingCompletionClassification.CONFIRMED,
    });
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].sourceActivityId, `${USER_A}:${MOVIE_ID}:played`);
    assert.equal(evidence[0].observedAt, null);
    assert.equal(evidence[0].observedEndAt, null);
  });

  it('persists Movie/Episode state and idempotent confirmed evidence', async () => {
    const { movie, episode } = await createCurrentLibrary();
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const watchlist = await getRepository(Watchlist).save(
      new Watchlist({
        ratingKey: 'viewing-retained-watchlist',
        tmdbId: 44001,
        mediaType: MediaType.MOVIE,
        title: 'Retained after viewing',
        requestedBy: user,
      })
    );
    const occurrence = await getRepository(UserMediaIntentOccurrence).save(
      new UserMediaIntentOccurrence({
        userId: user.id,
        user,
        intentType: UserMediaIntentType.WATCHLIST,
        mediaType: MediaType.MOVIE,
        tmdbId: watchlist.tmdbId,
        state: UserMediaIntentState.ACTIVE,
        startedAt: new Date('2026-09-01T00:00:00.000Z'),
      })
    );
    const observed = new Date('2026-10-01T12:00:00.000Z');
    const service = new CurrentJellyfinViewingService({
      now: () => observed,
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            id === MOVIE_ID
              ? jellyfinItem({
                  id,
                  type: 'Movie',
                  played: true,
                  playCount: 3,
                  lastPlayedDate: '2026-09-30T10:00:00.000Z',
                })
              : jellyfinItem({
                  id,
                  type: 'Episode',
                  played: id === EPISODE_ID,
                  progress: id === EPISODE_ID ? 100 : 42,
                  lastPlayedDate:
                    id === EPISODE_ID ? '2026-09-29T10:00:00.000Z' : undefined,
                })
          ),
      }),
    });

    const first = await service.run();
    assert.equal(first.complete, true);
    assert.equal(first.moviesTargeted, 1);
    assert.equal(first.episodesTargeted, 2);
    assert.equal(first.stateCreated, 3);
    assert.equal(first.confirmedEvidenceCreated, 2);
    assert.equal(first.partialEvidenceCreated, 1);
    assert.equal(first.partialEpisodes, 1);
    assert.equal(await getRepository(CurrentViewingState).count(), 3);
    assert.equal(await getRepository(ViewingEvidence).count(), 3);
    const movieState = await getRepository(CurrentViewingState).findOneByOrFail(
      {
        canonicalMediaId: movie.id,
        mediaType: 'movie',
      }
    );
    assert.equal(movieState.played, true);
    assert.equal(movieState.playCount, 3);
    const episodeEvidence = await getRepository(
      ViewingEvidence
    ).findOneByOrFail({
      canonicalEpisodeId: episode.id,
      completionClassification: ViewingCompletionClassification.CONFIRMED,
    });
    assert.equal(
      episodeEvidence.identityResolutionState,
      IdentityResolutionState.RESOLVED
    );

    const second = await service.run();
    assert.equal(second.stateCreated, 0);
    assert.equal(second.stateUpdated, 3);
    assert.equal(second.confirmedEvidenceCreated, 0);
    assert.equal(second.confirmedEvidenceReused, 2);
    assert.equal(second.partialEvidenceCreated, 0);
    assert.equal(second.partialEvidenceReused, 1);
    assert.equal(await getRepository(CurrentViewingState).count(), 3);
    assert.equal(await getRepository(ViewingEvidence).count(), 3);
    assert.ok(await getRepository(Watchlist).findOneBy({ id: watchlist.id }));
    assert.equal(
      (
        await getRepository(UserMediaIntentOccurrence).findOneByOrFail({
          id: occurrence.id,
        })
      ).state,
      UserMediaIntentState.ACTIVE
    );
  });

  it('persists one strongest native partial observation and lets completion dominate', async () => {
    const { movie } = await createCurrentLibrary();
    let progress = 42;
    let played = false;
    let lastPlayedDate = '2026-09-30T10:00:00.000Z';
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: id === MOVIE_ID ? played : false,
              progress: id === MOVIE_ID ? progress : 0,
              lastPlayedDate: id === MOVIE_ID ? lastPlayedDate : undefined,
            })
          ),
      }),
    });

    const first = await service.run();
    assert.equal(first.partialEvidenceCreated, 1);
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        canonicalMediaId: movie.id,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      }),
      1
    );
    const identical = await service.run();
    assert.equal(identical.partialEvidenceCreated, 0);
    assert.equal(identical.partialEvidenceUpdated, 0);
    assert.equal(identical.partialEvidenceReused, 1);

    progress = 55;
    lastPlayedDate = '2026-10-01T10:00:00.000Z';
    const changed = await service.run();
    assert.equal(changed.partialEvidenceUpdated, 1);
    const partial = await getRepository(ViewingEvidence).findOneByOrFail({
      canonicalMediaId: movie.id,
      completionClassification: ViewingCompletionClassification.PARTIAL,
    });
    assert.equal(partial.progressBasisPoints, 5500);
    assert.equal(
      partial.observedEndAt?.toISOString(),
      '2026-10-01T10:00:00.000Z'
    );

    played = true;
    progress = 100;
    const completed = await service.run();
    assert.equal(completed.confirmedEvidenceCreated, 1);
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        canonicalMediaId: movie.id,
      }),
      2
    );
    const projection = await getMovieViewingProjection(movie.id);
    assert.equal(projection.watchedCount, 1);
    assert.equal(
      projection.currentUserStates[0].strongestCompletion,
      ViewingCompletionClassification.CONFIRMED
    );
  });

  it('prunes obsolete complete, partial, and zero state only after authoritative completeness', async () => {
    const { movie, series } = await createCurrentLibrary();
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: id === EPISODE_ID,
              progress: id === MOVIE_ID ? 42 : 0,
              lastPlayedDate:
                id === MOVIE_ID || id === EPISODE_ID
                  ? '2026-09-30T10:00:00.000Z'
                  : undefined,
            })
          ),
      }),
    });
    await service.run();
    assert.equal(await getRepository(CurrentViewingState).count(), 3);
    assert.equal(await getRepository(ViewingEvidence).count(), 2);

    const presences = await getRepository(LibraryPresence).findBy({
      sourceSystem: 'jellyfin',
      sourceScope: SCOPE,
      isCurrent: true,
    });
    for (const presence of presences) {
      presence.isCurrent = false;
      presence.jellyfinVisible = false;
      presence.removedAt = new Date('2026-10-02T00:00:00.000Z');
    }
    await getRepository(LibraryPresence).save(presences);
    const removed = await service.run();
    assert.equal(removed.complete, true);
    assert.equal(removed.currentStatesPruned, 3);
    assert.equal(removed.currentStatesPruneBlocked, 0);
    assert.equal(await getRepository(CurrentViewingState).count(), 0);
    assert.equal(await getRepository(ViewingEvidence).count(), 2);
    assert.ok(await getRepository(CanonicalMedia).findOneBy({ id: movie.id }));
    assert.ok(await getRepository(CanonicalMedia).findOneBy({ id: series.id }));
  });

  it('does not prune when the current Library checkpoint is unavailable', async () => {
    await createCurrentLibrary();
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: false,
            })
          ),
      }),
    });
    await service.run();
    await getRepository(LibraryPresence).update(
      { sourceSystem: 'jellyfin', sourceScope: SCOPE },
      { isCurrent: false, jellyfinVisible: false }
    );
    await getRepository(SourceCheckpoint).update(
      {
        source: 'jellyfin',
        sourceScope: SCOPE,
        stage: 'current-library',
      },
      { status: SourceCheckpointStatus.STALE }
    );
    await assert.rejects(service.run(), CurrentViewingLibraryIncompleteError);
    assert.equal(await getRepository(CurrentViewingState).count(), 3);
  });

  it('uses the changed-ID current item while retaining historical completion', async () => {
    const { movie } = await createCurrentLibrary();
    let currentId = MOVIE_ID;
    let played = true;
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === currentId ? 'Movie' : 'Episode',
              played: id === currentId ? played : false,
              lastPlayedDate:
                id === currentId && played
                  ? '2026-09-30T10:00:00.000Z'
                  : undefined,
            })
          ),
      }),
    });
    await service.run();

    const oldPresence = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'jellyfin',
      sourceScope: SCOPE,
      sourceItemId: `movie:${MOVIE_ID}`,
    });
    oldPresence.isCurrent = false;
    oldPresence.jellyfinVisible = false;
    oldPresence.removedAt = new Date('2026-10-02T00:00:00.000Z');
    await getRepository(LibraryPresence).save(oldPresence);
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: movie.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'jellyfin',
        sourceScope: SCOPE,
        value: NEW_MOVIE_ID,
      })
    );
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: movie.id,
        sourceSystem: 'jellyfin',
        sourceScope: SCOPE,
        sourceItemId: `movie:${NEW_MOVIE_ID}`,
        sourceGeneration: '1',
        firstObservedAt: new Date('2026-10-02T00:00:00.000Z'),
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    currentId = NEW_MOVIE_ID;
    played = false;
    const readded = await service.run();
    assert.equal(readded.currentStatesPruned, 1);
    assert.equal(
      await getRepository(CurrentViewingState).countBy({
        canonicalMediaId: movie.id,
      }),
      1
    );
    const projection = await getMovieViewingProjection(movie.id);
    assert.equal(projection.currentUserStates[0].currentPlayed, false);
    assert.equal(projection.currentUserStates[0].everCompleted, true);
    assert.equal(projection.watchedCount, 0);
    assert.equal(projection.completedBy.length, 1);
  });

  it('uses a same-ID re-add as new current truth without losing history', async () => {
    const { movie } = await createCurrentLibrary();
    let played = true;
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: id === MOVIE_ID ? played : false,
              lastPlayedDate:
                id === MOVIE_ID && played
                  ? '2026-09-30T10:00:00.000Z'
                  : undefined,
            })
          ),
      }),
    });
    await service.run();

    const firstPresence = await getRepository(LibraryPresence).findOneByOrFail({
      sourceSystem: 'jellyfin',
      sourceScope: SCOPE,
      sourceItemId: `movie:${MOVIE_ID}`,
      isCurrent: true,
    });
    firstPresence.isCurrent = false;
    firstPresence.jellyfinVisible = false;
    firstPresence.removedAt = new Date('2026-10-02T00:00:00.000Z');
    await getRepository(LibraryPresence).save(firstPresence);
    const removed = await service.run();
    assert.equal(removed.currentStatesPruned, 1);

    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: movie.id,
        sourceSystem: 'jellyfin',
        sourceScope: SCOPE,
        sourceItemId: `movie:${MOVIE_ID}`,
        sourceGeneration: '2',
        firstObservedAt: new Date('2026-10-03T00:00:00.000Z'),
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    played = false;
    await service.run();

    const presences = await getRepository(LibraryPresence).findBy({
      sourceSystem: 'jellyfin',
      sourceScope: SCOPE,
      sourceItemId: `movie:${MOVIE_ID}`,
    });
    assert.equal(presences.length, 2);
    assert.equal(presences.filter((presence) => presence.isCurrent).length, 1);
    const state = await getRepository(CurrentViewingState).findOneByOrFail({
      canonicalMediaId: movie.id,
      sourceItemId: MOVIE_ID,
    });
    assert.equal(state.played, false);
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        canonicalMediaId: movie.id,
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      }),
      1
    );
    const projection = await getMovieViewingProjection(movie.id);
    assert.equal(projection.watchedCount, 0);
    assert.equal(projection.completedBy.length, 1);
  });

  it('retains historical completion when current Jellyfin says unplayed', async () => {
    const { movie } = await createCurrentLibrary();
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: false,
            })
          ),
      }),
    });
    await service.run();
    const viewer = await getRepository(Viewer).findOneByOrFail({
      sourceUserId: USER_A,
    });
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceClass: 'native',
        sourceActivityId: 'historical-completion',
        sourceUserId: USER_A,
        sourceItemId: MOVIE_ID,
        viewerId: viewer.id,
        canonicalMediaId: movie.id,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.LIKELY,
        observedEndAt: new Date('2026-08-12T10:00:00.000Z'),
      })
    );
    await service.run();
    assert.equal(user.jellyfinUserId, USER_A);
    assert.equal(await getRepository(ViewingEvidence).count(), 1);
    assert.equal(
      (
        await getRepository(CurrentViewingState).findOneByOrFail({
          canonicalMediaId: movie.id,
        })
      ).played,
      false
    );
  });

  it('preserves last-good state and freshness on a failed user fetch', async () => {
    const { movie } = await createCurrentLibrary();
    let fail = false;
    let now = new Date('2026-10-01T12:00:00.000Z');
    const service = new CurrentJellyfinViewingService({
      now: () => now,
      createClient: async () => ({
        getUserItems: async ({ ids }) => {
          if (fail) throw new Error('provider unavailable');
          return ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: true,
              lastPlayedDate: '2026-09-30T10:00:00.000Z',
            })
          );
        },
      }),
    });
    await service.run();
    const prior = await getRepository(CurrentViewingState).findOneByOrFail({
      canonicalMediaId: movie.id,
    });
    const priorObserved = prior.observedAt.toISOString();
    await getRepository(LibraryPresence).update(
      {
        sourceSystem: 'jellyfin',
        sourceScope: SCOPE,
        sourceItemId: `movie:${MOVIE_ID}`,
      },
      { isCurrent: false, jellyfinVisible: false }
    );
    fail = true;
    now = new Date('2026-10-01T13:00:00.000Z');
    const failed = await service.run();
    assert.equal(failed.complete, false);
    assert.equal(failed.usersFailed, 1);
    assert.equal(
      (
        await getRepository(CurrentViewingState).findOneByOrFail({
          id: prior.id,
        })
      ).observedAt.toISOString(),
      priorObserved
    );
    const checkpoint = await getRepository(SourceCheckpoint).findOneByOrFail({
      source: 'jellyfin',
      sourceScope: `${SCOPE}:${USER_A}`,
      stage: 'current-viewing-user',
    });
    assert.equal(checkpoint.status, SourceCheckpointStatus.FAILED);
    assert.equal(
      checkpoint.lastSuccessfulAt?.toISOString(),
      '2026-10-01T12:00:00.000Z'
    );
    const overallCheckpoint = await getRepository(
      SourceCheckpoint
    ).findOneByOrFail({
      source: 'jellyfin',
      sourceScope: SCOPE,
      stage: 'current-viewing',
    });
    assert.equal(overallCheckpoint.status, SourceCheckpointStatus.FAILED);
    assert.equal(
      overallCheckpoint.lastSuccessfulAt?.toISOString(),
      '2026-10-01T12:00:00.000Z'
    );
  });

  it('fails source completeness when a returned item omits UserData', async () => {
    await createCurrentLibrary();
    let omitUserData = false;
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id, index) => {
            const item = jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: false,
            });
            if (omitUserData && index === 0) delete item.UserData;
            return item;
          }),
      }),
    });
    const complete = await service.run();
    assert.equal(complete.complete, true);
    assert.equal(await getRepository(CurrentViewingState).count(), 3);
    await getRepository(LibraryPresence).update(
      {
        sourceSystem: 'jellyfin',
        sourceScope: SCOPE,
        sourceItemId: `movie:${MOVIE_ID}`,
      },
      { isCurrent: false, jellyfinVisible: false }
    );
    omitUserData = true;
    const summary = await service.run();
    assert.equal(summary.complete, false);
    assert.equal(summary.usersIncomplete, 1);
    assert.equal(summary.missingItems, 1);
    assert.equal(summary.currentStatesPruned, 0);
    assert.equal(await getRepository(CurrentViewingState).count(), 3);
    assert.equal(
      (
        await getRepository(SourceCheckpoint).findOneByOrFail({
          source: 'jellyfin',
          sourceScope: `${SCOPE}:${USER_A}`,
          stage: 'current-viewing-user',
        })
      ).status,
      SourceCheckpointStatus.FAILED
    );
  });

  it('discards provider results when Library membership changes during fetch and permits a newer run', async () => {
    await createCurrentLibrary();
    const generation = new CurrentLibraryGenerationService(
      new LibraryHydrationEpochService(dataSource)
    );
    let advanceDuringFetch = true;
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) => {
          if (advanceDuringFetch) {
            advanceDuringFetch = false;
            await dataSource.transaction('SERIALIZABLE', async (manager) => {
              await generation.advance(manager);
            });
          }
          return ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: true,
              lastPlayedDate: '2026-09-30T10:00:00.000Z',
            })
          );
        },
      }),
    });

    const stale = await service.run();
    assert.equal(stale.complete, false);
    assert.equal(await getRepository(CurrentViewingState).count(), 0);
    const staleRun = await getRepository(HydrationRun).findOneByOrFail({
      stage: 'current-viewing',
      status: HydrationRunStatus.RUNNING,
    });

    const current = await service.run();
    assert.equal(current.complete, true);
    assert.equal(await getRepository(CurrentViewingState).count(), 3);
    const superseded = await getRepository(HydrationRun).findOneByOrFail({
      id: staleRun.id,
    });
    assert.equal(superseded.status, HydrationRunStatus.CANCELLED);
    assert.equal(superseded.failureCode, 'SupersededGeneration');
  });

  it('commits successful users while rolling back every write for a failing user', async () => {
    await createCurrentLibrary();
    await getRepository(User).save(
      new User({
        email: 'viewing-second@example.test',
        username: 'Viewing Second',
        avatar: '',
        jellyfinUserId: USER_B,
        includeInUserMetrics: true,
      })
    );
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: true,
              lastPlayedDate: '2026-09-30T10:00:00.000Z',
            })
          ),
      }),
      beforeUserCommit: async (sourceUserId) => {
        if (sourceUserId === USER_B) throw new Error('injected write failure');
      },
    });

    const summary = await service.run();
    assert.equal(summary.complete, false);
    assert.equal(summary.usersSucceeded, 1);
    assert.equal(summary.usersFailed, 1);
    const viewers = await getRepository(Viewer).findBy({
      source: 'jellyfin',
      sourceScope: SCOPE,
    });
    const viewerBySource = new Map(
      viewers.map((viewer) => [viewer.sourceUserId, viewer])
    );
    assert.equal(
      await getRepository(CurrentViewingState).countBy({
        viewerId: viewerBySource.get(USER_A)!.id,
      }),
      3
    );
    assert.equal(
      await getRepository(CurrentViewingState).countBy({
        viewerId: viewerBySource.get(USER_B)!.id,
      }),
      0
    );
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        viewerId: viewerBySource.get(USER_B)!.id,
      }),
      0
    );
    assert.equal(
      (
        await getRepository(SourceCheckpoint).findOneByOrFail({
          source: 'jellyfin',
          sourceScope: `${SCOPE}:${USER_A}`,
          stage: 'current-viewing-user',
        })
      ).status,
      SourceCheckpointStatus.CURRENT
    );
    assert.equal(
      (
        await getRepository(SourceCheckpoint).findOneByOrFail({
          source: 'jellyfin',
          sourceScope: `${SCOPE}:${USER_B}`,
          stage: 'current-viewing-user',
        })
      ).status,
      SourceCheckpointStatus.FAILED
    );
  });
});

describe('library viewing projections', () => {
  beforeEach(async () => {
    const settings = getSettings();
    settings.main.mediaServerType = MediaServerType.JELLYFIN;
    settings.jellyfin.serverId = SCOPE;
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    admin.jellyfinUserId = USER_A;
    admin.includeInUserMetrics = true;
    await getRepository(User).save(admin);
  });

  it('reconciles Movie certainty and applies metrics inclusion dynamically', async () => {
    const { movie } = await createCurrentLibrary();
    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: id === MOVIE_ID,
              lastPlayedDate:
                id === MOVIE_ID ? '2026-09-30T10:00:00.000Z' : undefined,
            })
          ),
      }),
    });
    await service.run();
    const viewer = await getRepository(Viewer).findOneByOrFail({
      sourceUserId: USER_A,
    });
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceClass: 'native',
        sourceActivityId: 'older-likely',
        viewerId: viewer.id,
        canonicalMediaId: movie.id,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.LIKELY,
        observedEndAt: new Date('2026-08-01T00:00:00.000Z'),
      })
    );

    let projection = await getMovieViewingProjection(movie.id);
    assert.equal(projection.watchedCount, 1);
    assert.deepEqual(projection.watchedBy, [viewer.id]);
    assert.equal(
      projection.lastCompletedWatch?.toISOString(),
      '2026-09-30T10:00:00.000Z'
    );
    assert.equal(
      projection.lastCompletedWatchClassification,
      ViewingCompletionClassification.CONFIRMED
    );
    assert.equal(await getRepository(ViewingEvidence).count(), 2);

    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    admin.includeInUserMetrics = false;
    await getRepository(User).save(admin);
    projection = await getMovieViewingProjection(movie.id);
    assert.equal(projection.watchedCount, 0);
    assert.equal(await getRepository(CurrentViewingState).count(), 3);
    assert.equal(await getRepository(ViewingEvidence).count(), 2);
    admin.includeInUserMetrics = true;
    await getRepository(User).save(admin);
    assert.equal((await getMovieViewingProjection(movie.id)).watchedCount, 1);
  });

  it('ignores inactive stale state before pruning catches up', async () => {
    const { movie } = await createCurrentLibrary();
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceUserId: USER_A,
        userId: admin.id,
      })
    );
    await getRepository(CurrentViewingState).save([
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: SCOPE,
        sourceItemId: MOVIE_ID,
        mediaType: 'movie',
        canonicalMediaId: movie.id,
        played: false,
        progressBasisPoints: 0,
        observedAt: new Date('2026-10-02T00:00:00.000Z'),
      }),
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: SCOPE,
        sourceItemId: NEW_MOVIE_ID,
        mediaType: 'movie',
        canonicalMediaId: movie.id,
        played: true,
        progressBasisPoints: 10_000,
        observedAt: new Date('2026-10-01T00:00:00.000Z'),
      }),
    ]);
    const projection = await getMovieViewingProjection(movie.id);
    assert.equal(projection.currentUserStates[0].currentPlayed, false);
    assert.equal(projection.watchedCount, 0);
  });

  it('derives available/aired Season and Series completion episode-by-episode', async () => {
    const { series, season, episode, episodeTwo } =
      await createCurrentLibrary();
    const unavailableAired = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: season.id,
        episodeNumber: 3,
        airDate: '2026-03-01',
      })
    );
    await getRepository(CanonicalEpisode).save([
      new CanonicalEpisode({
        seasonId: season.id,
        episodeNumber: 4,
        airDate: '2027-01-01',
      }),
      new CanonicalEpisode({ seasonId: season.id, episodeNumber: 5 }),
    ]);
    const specials = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 0 })
    );
    await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: specials.id,
        episodeNumber: 1,
        airDate: '2026-01-01',
        isSpecial: true,
      })
    );

    const service = new CurrentJellyfinViewingService({
      now: () => new Date('2026-10-01T12:00:00.000Z'),
      createClient: async () => ({
        getUserItems: async ({ ids }) =>
          ids.map((id) =>
            jellyfinItem({
              id,
              type: id === MOVIE_ID ? 'Movie' : 'Episode',
              played: id === EPISODE_ID,
              progress: id === EPISODE_TWO_ID ? 50 : 0,
              lastPlayedDate:
                id === EPISODE_ID ? '2026-09-29T10:00:00.000Z' : undefined,
            })
          ),
      }),
    });
    await service.run();
    const viewer = await getRepository(Viewer).findOneByOrFail({
      sourceUserId: USER_A,
    });
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceClass: 'native',
        sourceActivityId: 'unavailable-aired-completion',
        viewerId: viewer.id,
        canonicalMediaId: series.id,
        canonicalEpisodeId: unavailableAired.id,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.LIKELY,
        observedEndAt: new Date('2026-09-20T00:00:00.000Z'),
      })
    );

    const projection = await getSeasonViewingProjection(
      season.id,
      new Date('2026-10-01T00:00:00.000Z')
    );
    assert.equal(projection.availableEpisodeCount, 2);
    assert.equal(projection.airedEpisodeCount, 3);
    assert.equal(projection.unknownAirDateCount, 1);
    assert.equal(projection.perViewer[0].watchedEpisodeCount, 2);
    assert.equal(projection.perViewer[0].availableCompletionPercent, 50);
    assert.equal(projection.perViewer[0].airedCompletionPercent, 66.67);
    assert.equal(projection.perViewer[0].hasCurrentProgress, true);
    assert.equal(projection.perViewer[0].incomplete, true);
    assert.deepEqual(projection.completedByAvailable, []);
    assert.deepEqual(projection.caughtUpByAired, []);
    assert.equal(episode.id !== episodeTwo.id, true);

    const seriesProjection = await getSeriesViewingProjection(
      series.id,
      new Date('2026-10-01T00:00:00.000Z')
    );
    assert.deepEqual(seriesProjection.viewers, [viewer.id]);
    assert.deepEqual(seriesProjection.caughtUpUsers, []);
    assert.deepEqual(seriesProjection.incompleteUsers, [viewer.id]);
    assert.equal(seriesProjection.seasons.length, 2);
    assert.equal(
      seriesProjection.seasons.find((value) => value.isSpecial)?.seasonNumber,
      0
    );
  });

  it('distinguishes 0/8, 6/8, and 8/8 without inflating unique viewers', async () => {
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Eight Episodes',
      })
    );
    const season = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
    );
    const episodes = await getRepository(CanonicalEpisode).save(
      Array.from(
        { length: 8 },
        (_, index) =>
          new CanonicalEpisode({
            seasonId: season.id,
            episodeNumber: index + 1,
            airDate: `2026-01-${String(index + 1).padStart(2, '0')}`,
          })
      )
    );
    const episodeItemIds = episodes.map((_, index) =>
      (index + 10).toString(16).padStart(32, '0')
    );
    await getRepository(CanonicalEpisodeIdentity).save(
      episodes.map(
        (episode, index) =>
          new CanonicalEpisodeIdentity({
            canonicalEpisodeId: episode.id,
            provider: 'jellyfin',
            sourceScope: SCOPE,
            value: episodeItemIds[index],
            lastSeenSourceGeneration: '1',
          })
      )
    );
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'jellyfin',
        sourceScope: SCOPE,
        sourceItemId: 'series-eight',
        sourceGeneration: '1',
        firstObservedAt: new Date(),
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    const sonarrPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:1',
        sourceItemId: '8',
        sourceGeneration: '1',
        firstObservedAt: new Date(),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const file = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: sonarrPresence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'service:1',
        sourceFileId: '8',
        sourceGeneration: '1',
        firstObservedAt: new Date(),
        isCurrent: true,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      episodes.map(
        (episode) =>
          new LibraryFileEpisode({
            libraryFileId: file.id,
            canonicalEpisodeId: episode.id,
          })
      )
    );
    await getRepository(SourceCheckpoint).save(
      new SourceCheckpoint({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceGeneration: '1',
        stage: 'current-library',
        status: SourceCheckpointStatus.CURRENT,
        lastSuccessfulAt: new Date(),
      })
    );
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    const second = await getRepository(User).save(
      new User({
        email: 'six@example.test',
        username: 'six',
        avatar: '',
        includeInUserMetrics: true,
      })
    );
    const third = await getRepository(User).save(
      new User({
        email: 'eight@example.test',
        username: 'eight',
        avatar: '',
        includeInUserMetrics: true,
      })
    );
    const viewers = await getRepository(Viewer).save([
      new Viewer({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceUserId: USER_A,
        userId: admin.id,
      }),
      new Viewer({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceUserId: USER_B,
        userId: second.id,
      }),
      new Viewer({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceUserId: '77777777777777777777777777777777',
        userId: third.id,
      }),
    ]);
    await getRepository(CurrentViewingState).save(
      viewers.flatMap((viewer) =>
        episodes.map(
          (episode, episodeIndex) =>
            new CurrentViewingState({
              viewerId: viewer.id,
              sourceScope: SCOPE,
              sourceItemId: episodeItemIds[episodeIndex],
              mediaType: 'episode',
              canonicalMediaId: series.id,
              canonicalEpisodeId: episode.id,
              played: false,
              playCount: 0,
              observedAt: new Date('2026-10-01T00:00:00.000Z'),
            })
        )
      )
    );
    const evidence: ViewingEvidence[] = [];
    for (const [viewerIndex, count] of [0, 6, 8].entries()) {
      for (let index = 0; index < count; index++) {
        evidence.push(
          new ViewingEvidence({
            source: 'jellyfin',
            sourceScope: SCOPE,
            sourceClass: 'fixture',
            sourceActivityId: `${viewerIndex}:${index}`,
            viewerId: viewers[viewerIndex].id,
            canonicalMediaId: series.id,
            canonicalEpisodeId: episodes[index].id,
            identityResolutionState: IdentityResolutionState.RESOLVED,
            completionClassification: ViewingCompletionClassification.CONFIRMED,
            observedEndAt: new Date(
              `2026-09-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
            ),
          })
        );
      }
    }
    evidence.push(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceClass: 'rewatch',
        sourceActivityId: 'rewatch-does-not-inflate',
        viewerId: viewers[2].id,
        canonicalMediaId: series.id,
        canonicalEpisodeId: episodes[0].id,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.LIKELY,
        observedEndAt: new Date('2026-09-20T00:00:00.000Z'),
      })
    );
    await getRepository(ViewingEvidence).save(evidence);

    const projection = await getSeasonViewingProjection(
      season.id,
      new Date('2026-10-01T00:00:00.000Z')
    );
    assert.deepEqual(
      projection.perViewer.map((viewer) => viewer.watchedEpisodeCount),
      [0, 6, 8]
    );
    assert.deepEqual(projection.completedByAvailable, [viewers[2].id]);
    assert.deepEqual(projection.caughtUpByAired, [viewers[2].id]);
    assert.deepEqual(projection.incompleteViewers, [viewers[1].id]);
    assert.equal(projection.viewers.length, 2);
  });
});
