import {
  IdentityResolutionState,
  LibraryMediaType,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import {
  aggregateLibraryWatched,
  loadLibraryViewingEvidence,
} from '@server/lib/library';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { In } from 'typeorm';

setupTestDb();

describe('page-bounded Library viewing evidence', () => {
  it('matches full entity hydration with UTC timestamps and minimal safe users', async () => {
    const [selectedMovie, otherMovie] = await getRepository(
      CanonicalMedia
    ).save([
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Selected evidence movie',
      }),
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Other evidence movie',
      }),
    ]);
    const user = await getRepository(User).save(
      new User({
        email: 'evidence-page@example.test',
        username: 'Evidence Viewer',
        avatar: '/evidence-avatar.png',
        includeInUserMetrics: false,
      })
    );
    const viewer = await getRepository(Viewer).save(
      new Viewer({
        source: 'jellyfin',
        sourceScope: 'evidence-page',
        sourceUserId: '11111111111111111111111111111111',
        userId: user.id,
      })
    );
    const saved = await getRepository(ViewingEvidence).save([
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'evidence-page',
        sourceClass: 'native',
        sourceActivityId: 'confirmed',
        viewerId: viewer.id,
        canonicalMediaId: selectedMovie.id,
        observedAt: new Date('2026-03-02T12:00:00.000Z'),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
        identityResolutionState: IdentityResolutionState.RESOLVED,
      }),
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'evidence-page',
        sourceClass: 'native',
        sourceActivityId: 'partial',
        viewerId: viewer.id,
        canonicalMediaId: selectedMovie.id,
        observedAt: new Date('2026-03-03T12:00:00.000Z'),
        observedEndAt: new Date('2026-03-03T12:30:00.000Z'),
        playbackDurationSeconds: 1800,
        progressBasisPoints: 5000,
        completionClassification: ViewingCompletionClassification.PARTIAL,
        identityResolutionState: IdentityResolutionState.RESOLVED,
      }),
      new ViewingEvidence({
        source: 'admin',
        sourceScope: 'manual',
        sourceClass: 'historical-manual-activity',
        sourceActivityId: 'manual-activity',
        viewerId: viewer.id,
        canonicalMediaId: selectedMovie.id,
        observedAt: new Date('2026-03-04T12:00:00.000Z'),
        completionClassification: ViewingCompletionClassification.UNKNOWN,
        identityResolutionState: IdentityResolutionState.RESOLVED,
      }),
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'evidence-page',
        sourceClass: 'native',
        sourceActivityId: 'outside-page',
        viewerId: viewer.id,
        canonicalMediaId: otherMovie.id,
        observedAt: new Date('2026-03-05T12:00:00.000Z'),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
        identityResolutionState: IdentityResolutionState.RESOLVED,
      }),
    ]);

    const full = await getRepository(ViewingEvidence).find({
      where: { canonicalMediaId: In([selectedMovie.id]) },
      relations: { viewer: { user: true } },
    });
    const projected = await loadLibraryViewingEvidence([selectedMovie.id]);

    assert.deepEqual(
      projected
        .map((evidence) => evidence.id)
        .sort((left, right) => left - right),
      saved
        .slice(0, 3)
        .map((evidence) => evidence.id)
        .sort((left, right) => left - right)
    );
    assert.deepEqual(
      aggregateLibraryWatched({
        mediaType: LibraryMediaType.MOVIE,
        states: [],
        evidence: projected,
        episodes: [],
        scope: 'archive',
      }),
      aggregateLibraryWatched({
        mediaType: LibraryMediaType.MOVIE,
        states: [],
        evidence: full,
        episodes: [],
        scope: 'archive',
      })
    );
    assert.equal(
      aggregateLibraryWatched({
        mediaType: LibraryMediaType.MOVIE,
        states: [],
        evidence: projected,
        episodes: [],
        scope: 'archive',
      }).watchedUsers[0].lastViewedAt,
      '2026-03-02T12:00:00.000Z'
    );
    assert.equal(
      projected[0].observedAt?.toISOString(),
      '2026-03-02T12:00:00.000Z'
    );
    assert.equal(
      projected[1].observedEndAt?.toISOString(),
      '2026-03-03T12:30:00.000Z'
    );
    assert.equal(projected[0].viewer?.user?.username, 'Evidence Viewer');
    assert.equal(projected[0].viewer?.user?.avatar, '/evidence-avatar.png');
    assert.equal(projected[0].viewer?.user?.includeInUserMetrics, false);
    assert.equal(projected[0].viewer?.user?.requestCount, undefined);
    assert.deepEqual(await loadLibraryViewingEvidence([]), []);
  });

  it('keeps watched time tied to Played episodes when later activity is partial', () => {
    const user = new User({
      id: 91,
      displayName: 'Claudia',
      username: 'Claudia',
      avatar: '',
    });
    const viewer = new Viewer({ id: 92, userId: user.id, user });
    const episodes = [
      {
        canonicalMediaId: 10,
        canonicalEpisodeId: 101,
        seasonNumber: 1,
        episodeNumber: 3,
        isSpecial: false,
      },
      {
        canonicalMediaId: 10,
        canonicalEpisodeId: 102,
        seasonNumber: 1,
        episodeNumber: 4,
        isSpecial: false,
      },
    ];
    const result = aggregateLibraryWatched({
      mediaType: LibraryMediaType.SERIES,
      states: [
        new CurrentViewingState({
          viewerId: viewer.id,
          viewer,
          canonicalMediaId: 10,
          canonicalEpisodeId: 101,
          played: true,
          progressBasisPoints: 10_000,
          lastPlayedAt: new Date('2026-10-10T20:23:00.000Z'),
        }),
        new CurrentViewingState({
          viewerId: viewer.id,
          viewer,
          canonicalMediaId: 10,
          canonicalEpisodeId: 102,
          played: false,
          progressBasisPoints: 5_000,
          lastPlayedAt: new Date('2026-10-10T20:42:00.000Z'),
        }),
      ],
      evidence: [],
      episodes,
      scope: 'current',
      authoritativeLastActiveAt: '2026-10-10T20:42:00.000Z',
    });

    assert.equal(
      result.watchedUsers[0].lastViewedAt,
      '2026-10-10T20:23:00.000Z'
    );
    assert.deepEqual(
      result.lastActiveUsers.map((candidate) => candidate.displayName),
      ['Claudia']
    );
  });

  it('uses the latest playback time among currently Played episodes', () => {
    const user = new User({ id: 93, displayName: 'Moni', username: 'Moni' });
    const viewer = new Viewer({ id: 94, userId: user.id, user });
    const episodes = [101, 102].map((canonicalEpisodeId, index) => ({
      canonicalMediaId: 10,
      canonicalEpisodeId,
      seasonNumber: 1,
      episodeNumber: index + 1,
      isSpecial: false,
    }));
    const result = aggregateLibraryWatched({
      mediaType: LibraryMediaType.SERIES,
      states: episodes.map(
        (episode, index) =>
          new CurrentViewingState({
            viewerId: viewer.id,
            viewer,
            canonicalMediaId: 10,
            canonicalEpisodeId: episode.canonicalEpisodeId,
            played: true,
            lastPlayedAt: new Date(
              index === 0
                ? '2026-10-10T20:23:00.000Z'
                : '2026-10-11T08:15:00.000Z'
            ),
          })
      ),
      evidence: [],
      episodes,
      scope: 'current',
    });

    assert.equal(
      result.watchedUsers[0].lastViewedAt,
      '2026-10-11T08:15:00.000Z'
    );
  });

  it('omits watched time when a Played item has no trustworthy timestamp', () => {
    const user = new User({ id: 95, displayName: 'No Date' });
    const viewer = new Viewer({ id: 96, userId: user.id, user });
    const result = aggregateLibraryWatched({
      mediaType: LibraryMediaType.MOVIE,
      states: [
        new CurrentViewingState({
          viewerId: viewer.id,
          viewer,
          canonicalMediaId: 11,
          played: true,
          lastPlayedAt: null,
        }),
      ],
      evidence: [],
      episodes: [],
      scope: 'current',
    });

    assert.equal(result.watchedUsers[0].lastViewedAt, null);
  });

  it('preserves regular-Series completion while excluding Specials', async () => {
    const series = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Projected evidence series',
      })
    );
    const [regularSeason, specialsSeason] = await getRepository(
      CanonicalSeason
    ).save([
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 }),
      new CanonicalSeason({ seriesId: series.id, seasonNumber: 0 }),
    ]);
    const [regularEpisode, specialEpisode] = await getRepository(
      CanonicalEpisode
    ).save([
      new CanonicalEpisode({
        seasonId: regularSeason.id,
        episodeNumber: 1,
        isSpecial: false,
      }),
      new CanonicalEpisode({
        seasonId: specialsSeason.id,
        episodeNumber: 1,
        isSpecial: true,
      }),
    ]);
    const [regularUser, specialsUser] = await getRepository(User).save([
      new User({
        email: 'regular-series@example.test',
        username: 'Regular Viewer',
        avatar: '',
      }),
      new User({
        email: 'specials-series@example.test',
        username: 'Specials Viewer',
        avatar: '',
      }),
    ]);
    const [regularViewer, specialsViewer] = await getRepository(Viewer).save([
      new Viewer({
        source: 'jellyfin',
        sourceScope: 'evidence-series',
        sourceUserId: '22222222222222222222222222222222',
        userId: regularUser.id,
      }),
      new Viewer({
        source: 'jellyfin',
        sourceScope: 'evidence-series',
        sourceUserId: '33333333333333333333333333333333',
        userId: specialsUser.id,
      }),
    ]);
    await getRepository(ViewingEvidence).save([
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'evidence-series',
        sourceClass: 'native',
        sourceActivityId: 'regular-complete',
        viewerId: regularViewer.id,
        canonicalMediaId: series.id,
        canonicalEpisodeId: regularEpisode.id,
        observedAt: new Date('2026-04-01T12:00:00.000Z'),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
        identityResolutionState: IdentityResolutionState.RESOLVED,
      }),
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'evidence-series',
        sourceClass: 'native',
        sourceActivityId: 'special-complete',
        viewerId: specialsViewer.id,
        canonicalMediaId: series.id,
        canonicalEpisodeId: specialEpisode.id,
        observedAt: new Date('2026-04-02T12:00:00.000Z'),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
        identityResolutionState: IdentityResolutionState.RESOLVED,
      }),
    ]);
    const episodes = [
      {
        canonicalMediaId: series.id,
        canonicalEpisodeId: regularEpisode.id,
        seasonNumber: 1,
        episodeNumber: 1,
        isSpecial: false,
      },
      {
        canonicalMediaId: series.id,
        canonicalEpisodeId: specialEpisode.id,
        seasonNumber: 0,
        episodeNumber: 1,
        isSpecial: true,
      },
    ];
    const full = await getRepository(ViewingEvidence).find({
      where: { canonicalMediaId: In([series.id]) },
      relations: { viewer: { user: true } },
    });
    const projected = await loadLibraryViewingEvidence([series.id]);
    const expected = aggregateLibraryWatched({
      mediaType: LibraryMediaType.SERIES,
      states: [],
      evidence: full,
      episodes,
      scope: 'archive',
    });
    const actual = aggregateLibraryWatched({
      mediaType: LibraryMediaType.SERIES,
      states: [],
      evidence: projected,
      episodes,
      scope: 'archive',
    });

    assert.deepEqual(actual, expected);
    assert.deepEqual(
      actual.watchedUsers.map((viewer) => viewer.displayName),
      ['Regular Viewer']
    );
    assert.equal(actual.watchedUsers[0].watchedPercentage, 100);
  });
});
