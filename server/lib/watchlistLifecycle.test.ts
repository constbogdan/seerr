import {
  IdentityResolutionState,
  LibraryMediaType,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import {
  UserMediaIntentState,
  UserMediaIntentType,
} from '@server/constants/watchlist';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { UserMediaIntentOccurrence } from '@server/entity/UserMediaIntentOccurrence';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { Watchlist } from '@server/entity/Watchlist';
import {
  ensureActiveWatchlistIntentOccurrences,
  getSeriesSeasonWatchlistScope,
  getWatchlistHistory,
  satisfyConfirmedMovieWatchlistIntents,
} from '@server/lib/watchlistLifecycle';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const tmdb = {
  getMovie: async ({ movieId }: { movieId: number }) => ({
    id: movieId,
    external_ids: {},
    genres: [],
  }),
  getTvShow: async ({ tvId }: { tvId: number }) => ({
    id: tvId,
    external_ids: {},
    genres: [],
  }),
};

const admin = async () =>
  getRepository(User).findOneOrFail({ where: { id: 1 } });

const add = async (mediaType: MediaType, tmdbId: number) =>
  Watchlist.createWatchlist({
    user: await admin(),
    tmdb: tmdb as never,
    watchlistRequest: { mediaType, tmdbId, title: `Item ${tmdbId}` },
  });

const addCompletion = async ({
  tmdbId,
  classification,
  observedAt,
}: {
  tmdbId: number;
  classification: ViewingCompletionClassification;
  observedAt: Date;
}) => {
  const user = await admin();
  const media = await getRepository(Media).findOneByOrFail({
    tmdbId,
    mediaType: MediaType.MOVIE,
  });
  const canonical = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      currentMediaId: media.id,
    })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: canonical.id,
      canonicalMedia: canonical,
      mediaType: LibraryMediaType.MOVIE,
      provider: 'tmdb',
      sourceScope: '',
      value: String(tmdbId),
    })
  );
  const viewer = await getRepository(Viewer).save(
    new Viewer({
      source: 'test',
      sourceScope: 'test',
      sourceUserId: `user-${user.id}`,
      userId: user.id,
    })
  );
  return getRepository(ViewingEvidence).save(
    new ViewingEvidence({
      source: 'test',
      sourceScope: 'test',
      sourceClass: 'native',
      sourceActivityId: `activity-${tmdbId}-${classification}`,
      viewerId: viewer.id,
      canonicalMediaId: canonical.id,
      observedAt,
      identityResolutionState: IdentityResolutionState.RESOLVED,
      completionClassification: classification,
    })
  );
};

describe('Watchlist lifecycle occurrences', () => {
  it('backfills missing active occurrences exactly once', async () => {
    const user = await admin();
    const watchlist = await add(MediaType.MOVIE, 8100);
    await getRepository(UserMediaIntentOccurrence).clear();

    assert.equal(await ensureActiveWatchlistIntentOccurrences(), 1);
    assert.equal(await ensureActiveWatchlistIntentOccurrences(), 0);
    const occurrence = await getRepository(
      UserMediaIntentOccurrence
    ).findOneByOrFail({
      userId: user.id,
      mediaType: MediaType.MOVIE,
      tmdbId: 8100,
      state: UserMediaIntentState.ACTIVE,
    });
    assert.equal(occurrence.startedAt.getTime(), watchlist.createdAt.getTime());
  });

  it('creates, removes, and re-adds separate durable occurrences', async () => {
    const user = await admin();
    await add(MediaType.MOVIE, 8101);
    await assert.rejects(() =>
      getRepository(UserMediaIntentOccurrence).save(
        new UserMediaIntentOccurrence({
          userId: user.id,
          user,
          intentType: UserMediaIntentType.WATCHLIST,
          mediaType: MediaType.MOVIE,
          tmdbId: 8101,
          state: UserMediaIntentState.ACTIVE,
          startedAt: new Date(),
        })
      )
    );
    await assert.rejects(() => add(MediaType.MOVIE, 8101));
    await Watchlist.deleteWatchlist(8101, MediaType.MOVIE, user);
    await assert.rejects(() =>
      Watchlist.deleteWatchlist(8101, MediaType.MOVIE, user)
    );
    await add(MediaType.MOVIE, 8101);

    const history = await getWatchlistHistory({ userId: user.id, page: 1 });
    assert.equal(history.totalResults, 2);
    assert.deepEqual(history.results.map((row) => row.state).sort(), [
      UserMediaIntentState.ACTIVE,
      UserMediaIntentState.REMOVED,
    ]);
    assert.equal(await getRepository(Watchlist).count(), 1);
  });

  it('satisfies only from exact confirmed Movie completion and is idempotent', async () => {
    const user = await admin();
    await add(MediaType.MOVIE, 8102);
    const occurrence = await getRepository(
      UserMediaIntentOccurrence
    ).findOneByOrFail({
      userId: user.id,
      intentType: UserMediaIntentType.WATCHLIST,
      mediaType: MediaType.MOVIE,
      tmdbId: 8102,
      state: UserMediaIntentState.ACTIVE,
    });
    const evidence = await addCompletion({
      tmdbId: 8102,
      classification: ViewingCompletionClassification.CONFIRMED,
      observedAt: new Date(occurrence.startedAt.getTime() + 1_000),
    });
    assert.equal(await satisfyConfirmedMovieWatchlistIntents(), 1);
    assert.equal(await satisfyConfirmedMovieWatchlistIntents(), 0);
    assert.equal(await getRepository(Watchlist).count(), 0);
    const satisfied = await getRepository(
      UserMediaIntentOccurrence
    ).findOneByOrFail({ id: occurrence.id });
    assert.equal(satisfied.state, UserMediaIntentState.SATISFIED);
    assert.equal(satisfied.completionEvidenceId, evidence.id);
  });

  it('does not irreversibly satisfy from LIKELY evidence', async () => {
    const user = await admin();
    await add(MediaType.MOVIE, 8103);
    const occurrence = await getRepository(
      UserMediaIntentOccurrence
    ).findOneByOrFail({ userId: user.id, tmdbId: 8103 });
    await addCompletion({
      tmdbId: 8103,
      classification: ViewingCompletionClassification.LIKELY,
      observedAt: new Date(occurrence.startedAt.getTime() + 1_000),
    });
    assert.equal(await satisfyConfirmedMovieWatchlistIntents(), 0);
    assert.equal(await getRepository(Watchlist).count(), 1);
  });

  it('does not satisfy a new intent from completion before it began', async () => {
    const user = await admin();
    await add(MediaType.MOVIE, 8105);
    const occurrence = await getRepository(
      UserMediaIntentOccurrence
    ).findOneByOrFail({ userId: user.id, tmdbId: 8105 });
    await addCompletion({
      tmdbId: 8105,
      classification: ViewingCompletionClassification.CONFIRMED,
      observedAt: new Date(occurrence.startedAt.getTime() - 1_000),
    });
    assert.equal(await satisfyConfirmedMovieWatchlistIntents(), 0);
    assert.equal(await getRepository(Watchlist).count(), 1);
    assert.equal(
      (
        await getRepository(UserMediaIntentOccurrence).findOneByOrFail({
          id: occurrence.id,
        })
      ).state,
      UserMediaIntentState.ACTIVE
    );
  });

  it('never satisfies a whole Series occurrence from viewing evidence', async () => {
    const user = await admin();
    await add(MediaType.TV, 8104);
    assert.equal(await satisfyConfirmedMovieWatchlistIntents(), 0);
    const active = await getRepository(UserMediaIntentOccurrence).findOneBy({
      userId: user.id,
      mediaType: MediaType.TV,
      tmdbId: 8104,
      state: UserMediaIntentState.ACTIVE,
    });
    assert.ok(active);
    await Watchlist.deleteWatchlist(8104, MediaType.TV, user);
    assert.equal(
      (
        await getRepository(UserMediaIntentOccurrence).findOneByOrFail({
          id: active.id,
        })
      ).state,
      UserMediaIntentState.REMOVED
    );
  });

  it('derives Season scope without satisfying the Series intent', async () => {
    const user = await admin();
    user.includeInUserMetrics = true;
    await getRepository(User).save(user);
    await add(MediaType.TV, 8106);
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({ mediaType: LibraryMediaType.SERIES })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: series.id,
        mediaType: LibraryMediaType.SERIES,
        provider: 'tmdb',
        sourceScope: '',
        value: '8106',
      })
    );
    const [seasonOne, seasonTwo] = await getRepository(CanonicalSeason).save([
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 }),
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 2 }),
    ]);
    const [episodeOne, episodeTwo] = await getRepository(CanonicalEpisode).save(
      [
        new CanonicalEpisode({
          seasonId: seasonOne.id,
          episodeNumber: 1,
          airDate: '2026-01-01',
        }),
        new CanonicalEpisode({
          seasonId: seasonTwo.id,
          episodeNumber: 1,
          airDate: '2026-02-01',
        }),
      ]
    );
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'jellyfin',
        sourceScope: 'test',
        sourceItemId: 'series-8106',
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
        sourceScope: 'test',
        sourceItemId: '8106',
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
        sourceScope: 'test',
        sourceFileId: '8106-file',
        sourceGeneration: '1',
        firstObservedAt: new Date(),
        isCurrent: true,
      })
    );
    await getRepository(LibraryFileEpisode).save([
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: episodeOne.id,
      }),
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: episodeTwo.id,
      }),
    ]);
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'test',
        sourceScope: 'test',
        sourceUserId: `series-user-${user.id}`,
        userId: user.id,
      })
    );
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'test',
        sourceScope: 'test',
        sourceClass: 'native',
        sourceActivityId: 'series-8106-s01e01',
        viewerId: viewer.id,
        canonicalMediaId: series.id,
        canonicalEpisodeId: episodeOne.id,
        observedAt: new Date('2026-03-01T00:00:00.000Z'),
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      })
    );

    assert.deepEqual(
      await getSeriesSeasonWatchlistScope({
        userId: user.id,
        tmdbId: 8106,
        seasonNumber: 1,
      }),
      { activeSeriesIntent: true, availableComplete: true, airedCaughtUp: true }
    );
    assert.deepEqual(
      await getSeriesSeasonWatchlistScope({
        userId: user.id,
        tmdbId: 8106,
        seasonNumber: 2,
      }),
      {
        activeSeriesIntent: true,
        availableComplete: false,
        airedCaughtUp: false,
      }
    );
    assert.equal(await satisfyConfirmedMovieWatchlistIntents(), 0);
    assert.ok(
      await getRepository(UserMediaIntentOccurrence).findOneBy({
        userId: user.id,
        mediaType: MediaType.TV,
        tmdbId: 8106,
        state: UserMediaIntentState.ACTIVE,
      })
    );
  });
});
