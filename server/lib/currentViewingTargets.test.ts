import { LibraryMediaType } from '@server/constants/libraryHistory';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMedia,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import {
  filterActiveCurrentViewingStates,
  loadActiveCurrentViewingStatesForMedia,
} from '@server/lib/currentViewingTargets';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SCOPE = 'library-current-state-scope';
const MOVIE_ID = '11111111111111111111111111111111';
const OTHER_MOVIE_ID = '22222222222222222222222222222222';
const OLD_EPISODE_ID = '33333333333333333333333333333333';
const EPISODE_ID = '44444444444444444444444444444444';
const UNAVAILABLE_EPISODE_ID = '55555555555555555555555555555555';

setupTestDb();

describe('page-scoped active current viewing states', () => {
  it('matches the authoritative global target filter without hydrating User relations', async () => {
    const movie = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Selected movie',
      })
    );
    const otherMovie = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Other movie',
      })
    );
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Selected series',
      })
    );
    const season = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
    );
    const [episode, unavailableEpisode] = await getRepository(
      CanonicalEpisode
    ).save([
      new CanonicalEpisode({ seasonId: season.id, episodeNumber: 1 }),
      new CanonicalEpisode({ seasonId: season.id, episodeNumber: 2 }),
    ]);
    await getRepository(CanonicalEpisodeIdentity).save([
      new CanonicalEpisodeIdentity({
        canonicalEpisodeId: episode.id,
        provider: 'jellyfin',
        sourceScope: SCOPE,
        value: OLD_EPISODE_ID,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
      new CanonicalEpisodeIdentity({
        canonicalEpisodeId: episode.id,
        provider: 'jellyfin',
        sourceScope: SCOPE,
        value: EPISODE_ID,
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
      new CanonicalEpisodeIdentity({
        canonicalEpisodeId: unavailableEpisode.id,
        provider: 'jellyfin',
        sourceScope: SCOPE,
        value: UNAVAILABLE_EPISODE_ID,
      }),
    ]);
    await getRepository(LibraryPresence).save([
      new LibraryPresence({
        canonicalMediaId: movie.id,
        sourceSystem: 'jellyfin',
        sourceScope: SCOPE,
        sourceItemId: `movie:${MOVIE_ID}`,
        firstObservedAt: new Date(),
        jellyfinVisible: true,
        isCurrent: true,
      }),
      new LibraryPresence({
        canonicalMediaId: otherMovie.id,
        sourceSystem: 'jellyfin',
        sourceScope: SCOPE,
        sourceItemId: `movie:${OTHER_MOVIE_ID}`,
        firstObservedAt: new Date(),
        jellyfinVisible: true,
        isCurrent: true,
      }),
      new LibraryPresence({
        canonicalMediaId: series.id,
        sourceSystem: 'jellyfin',
        sourceScope: SCOPE,
        sourceItemId: 'series:selected',
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
        sourceFileId: '1',
        firstObservedAt: new Date(),
        isCurrent: true,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: episode.id,
      })
    );

    const user = await getRepository(User).save(
      new User({
        email: 'page-state@example.test',
        username: 'Page State',
        avatar: '/avatar.png',
        includeInUserMetrics: false,
      })
    );
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: SCOPE,
        sourceUserId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        userId: user.id,
      })
    );
    const states = await getRepository(CurrentViewingState).save([
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: SCOPE,
        sourceItemId: MOVIE_ID,
        mediaType: 'movie',
        canonicalMediaId: movie.id,
        played: true,
        lastPlayedAt: new Date('2026-03-01T00:00:00.000Z'),
        observedAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: SCOPE,
        sourceItemId: OTHER_MOVIE_ID,
        mediaType: 'movie',
        canonicalMediaId: otherMovie.id,
        played: true,
        observedAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: SCOPE,
        sourceItemId: OLD_EPISODE_ID,
        mediaType: 'episode',
        canonicalMediaId: series.id,
        canonicalEpisodeId: episode.id,
        played: true,
        observedAt: new Date('2026-03-01T00:00:00.000Z'),
      }),
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: SCOPE,
        sourceItemId: EPISODE_ID,
        mediaType: 'episode',
        canonicalMediaId: series.id,
        canonicalEpisodeId: episode.id,
        played: false,
        progressBasisPoints: 2500,
        lastPlayedAt: new Date('2026-03-02T00:00:00.000Z'),
        observedAt: new Date('2026-03-02T00:00:00.000Z'),
      }),
      new CurrentViewingState({
        viewerId: viewer.id,
        sourceScope: SCOPE,
        sourceItemId: UNAVAILABLE_EPISODE_ID,
        mediaType: 'episode',
        canonicalMediaId: series.id,
        canonicalEpisodeId: unavailableEpisode.id,
        played: true,
        observedAt: new Date('2026-03-03T00:00:00.000Z'),
      }),
    ]);

    const selectedIds = [movie.id, series.id];
    const expected = await filterActiveCurrentViewingStates(
      (
        await getRepository(CurrentViewingState).find({
          relations: { viewer: { user: true } },
        })
      ).filter((state) => selectedIds.includes(state.canonicalMediaId))
    );
    const actual = await loadActiveCurrentViewingStatesForMedia(selectedIds);

    assert.deepEqual(
      actual.map((state) => state.id).sort((left, right) => left - right),
      expected.map((state) => state.id).sort((left, right) => left - right)
    );
    assert.deepEqual(
      actual.map((state) => state.id).sort((left, right) => left - right),
      [states[0].id, states[3].id].sort((left, right) => left - right)
    );
    assert.equal(actual[0].viewer.user?.username, 'Page State');
    assert.equal(actual[0].viewer.user?.avatar, '/avatar.png');
    assert.equal(actual[0].viewer.user?.includeInUserMetrics, false);
    assert.equal(actual[0].viewer.user?.requestCount, undefined);
    assert.deepEqual(await loadActiveCurrentViewingStatesForMedia([]), []);
  });
});
