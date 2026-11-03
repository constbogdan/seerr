import {
  ViewingCompletionClassification as Completion,
  LibraryMediaType,
} from '@server/constants/libraryHistory';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { aggregateLibraryWatched } from '@server/lib/library';
import { projectLibraryLastActiveEpisodes } from '@server/lib/libraryLastActiveEpisode';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const AT = '2026-10-29T13:16:00.000Z';
const users = [1, 2].map((id) => ({
  id,
  displayName: `Viewer ${id}`,
  avatar: null,
}));
const viewer = (id = 1) =>
  new Viewer({
    id,
    userId: id,
    user: new User({ id, username: `Viewer ${id}` }),
  });
const episodes = [4, 5].map((id) => ({
  canonicalMediaId: 10,
  canonicalEpisodeId: id,
  seasonNumber: 1,
  episodeNumber: id,
  isSpecial: false,
}));
const evidence = (
  id = 4,
  classification = Completion.PARTIAL,
  userId = 1,
  at = AT
) =>
  new ViewingEvidence({
    viewerId: userId,
    viewer: viewer(userId),
    canonicalMediaId: 10,
    canonicalEpisodeId: id,
    observedAt: new Date(at),
    completionClassification: classification,
  });
const state = (id = 4, played = true) =>
  new CurrentViewingState({
    viewerId: 1,
    viewer: viewer(),
    canonicalMediaId: 10,
    canonicalEpisodeId: id,
    mediaType: 'episode',
    played,
    progressBasisPoints: played ? 10000 : 5000,
    lastPlayedAt: new Date(AT),
  });
const base = {
  canonicalMediaId: 10,
  mediaType: LibraryMediaType.SERIES,
  users,
  lastActiveAt: AT,
  states: [] as CurrentViewingState[],
  evidence: [] as ViewingEvidence[],
  episodes,
  scope: 'current' as const,
};

describe('Library Last Active Episode annotation', () => {
  for (const [classification, label] of [
    [Completion.PARTIAL, 'partial'],
    [Completion.CONFIRMED, 'watched'],
    [Completion.LIKELY, undefined],
  ] as const)
    it(`uses exact activity coordinates and explicit classification ${classification}`, () => {
      const result = projectLibraryLastActiveEpisodes({
        ...base,
        evidence: [evidence(4, classification)],
      });
      assert.deepEqual(result[0].episode, {
        seasonNumber: 1,
        episodeNumber: 4,
        ...(label ? { classification: label } : {}),
      });
      assert.equal(result[1], users[1]);
      assert.deepEqual(users[0], {
        id: 1,
        displayName: 'Viewer 1',
        avatar: null,
      });
    });
  it('uses observedEndAt, not the start timestamp', () => {
    const row = evidence(4, Completion.CONFIRMED, 1, '2026-10-29T12:00:00Z');
    row.observedEndAt = new Date(AT);
    assert.equal(
      projectLibraryLastActiveEpisodes({ ...base, evidence: [row] })[0].episode
        ?.episodeNumber,
      4
    );
  });
  it('uses fresh current identity without pretending the played snapshot classifies the last event', () => {
    for (const played of [true, false])
      assert.deepEqual(
        projectLibraryLastActiveEpisodes({
          ...base,
          states: [state(4, played)],
        })[0].episode,
        { seasonNumber: 1, episodeNumber: 4 }
      );
  });
  it('does not substitute the older Last Watched or highest Episode', () => {
    const rows = [
      evidence(5, Completion.CONFIRMED, 1, '2026-10-28T12:00:00Z'),
      evidence(4),
    ];
    const aggregated = aggregateLibraryWatched({
      mediaType: LibraryMediaType.SERIES,
      states: [],
      evidence: rows,
      episodes,
      authoritativeLastActiveAt: AT,
      scope: 'archive',
    });
    const before = JSON.stringify(aggregated);
    const result = projectLibraryLastActiveEpisodes({
      ...base,
      users: aggregated.lastActiveUsers,
      evidence: rows,
      scope: 'archive',
    });
    assert.equal(result[0].episode?.episodeNumber, 4);
    assert.equal(
      aggregated.watchedUsers[0].lastViewedAt,
      '2026-10-28T12:00:00.000Z'
    );
    assert.equal(JSON.stringify(aggregated), before);
  });
  it('preserves tied users and distinguishes each user Episode', () => {
    const result = projectLibraryLastActiveEpisodes({
      ...base,
      evidence: [evidence(), evidence(5, Completion.CONFIRMED, 2)],
    });
    assert.deepEqual(
      result.map((row) => [row.id, row.episode?.episodeNumber]),
      [
        [1, 4],
        [2, 5],
      ]
    );
  });
  it('cannot borrow another user activity or a different timestamp', () => {
    const result = projectLibraryLastActiveEpisodes({
      ...base,
      users: [users[0]],
      evidence: [
        evidence(4, Completion.CONFIRMED, 2),
        evidence(4, Completion.CONFIRMED, 1, '2026-10-28T12:00:00Z'),
      ],
    });
    assert.equal(result[0], users[0]);
  });
  it('retains timestamp-only presentation for ambiguous equal-time Episodes in either order', () => {
    const rows = [evidence(4), evidence(5)];
    for (const ordered of [rows, [...rows].reverse()])
      assert.equal(
        projectLibraryLastActiveEpisodes({ ...base, evidence: ordered })[0],
        users[0]
      );
  });
  it('omits conflicting or unavailable classification on the same known Episode', () => {
    const result = projectLibraryLastActiveEpisodes({
      ...base,
      evidence: [evidence(4), evidence(4, Completion.CONFIRMED)],
    });
    assert.deepEqual(result[0].episode, { seasonNumber: 1, episodeNumber: 4 });
    assert.equal(
      projectLibraryLastActiveEpisodes({
        ...base,
        evidence: [evidence()],
        states: [state()],
      })[0].episode?.classification,
      undefined
    );
  });
  it('keeps unknown, unavailable, wrong-parent and invalid coordinate identities unresolved', () => {
    for (const row of [
      evidence(99),
      new ViewingEvidence({ ...evidence(), canonicalMediaId: 11 }),
      new ViewingEvidence({ ...evidence(), canonicalEpisodeId: null }),
      evidence(4, Completion.UNKNOWN),
    ])
      assert.equal(
        projectLibraryLastActiveEpisodes({ ...base, evidence: [row] })[0],
        users[0]
      );
    assert.equal(
      projectLibraryLastActiveEpisodes({
        ...base,
        evidence: [evidence()],
        episodes: [{ ...episodes[0], episodeNumber: -1 }],
      })[0],
      users[0]
    );
  });
  it('supports Specials coordinates without inferring from title text', () => {
    assert.equal(
      projectLibraryLastActiveEpisodes({
        ...base,
        evidence: [evidence()],
        episodes: [{ ...episodes[0], seasonNumber: 0 }],
      })[0].episode?.seasonNumber,
      0
    );
  });
  it('does not use current observations for Archive or annotate Movies', () => {
    assert.equal(
      projectLibraryLastActiveEpisodes({
        ...base,
        states: [state()],
        scope: 'archive',
      })[0],
      users[0]
    );
    assert.equal(
      projectLibraryLastActiveEpisodes({
        ...base,
        evidence: [evidence()],
        mediaType: LibraryMediaType.MOVIE,
      }),
      users
    );
    assert.equal(
      projectLibraryLastActiveEpisodes({
        ...base,
        evidence: [evidence()],
        lastActiveAt: null,
      }),
      users
    );
  });
});
