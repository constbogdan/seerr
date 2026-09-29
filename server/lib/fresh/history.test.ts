import type { TmdbSeasonWithEpisodes } from '@server/api/themoviedb/interfaces';
import FreshMedia from '@server/entity/FreshMedia';
import {
  evaluateMovieAdmission,
  evaluateTvAdmission,
  recurringIdentityForEvidence,
  selectTvActivityDate,
} from '@server/lib/fresh/history';
import { normalizeFreshTitle } from '@server/lib/fresh/normalize';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const day = 86_400_000;
const observedAt = new Date('2026-09-28T00:00:00.000Z');

const movie = (date: string) =>
  new FreshMedia({
    mediaType: 'movie',
    tmdbId: 1,
    mediaDate: date,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
    resolvedAt: observedAt,
    metadataRefreshedAt: observedAt,
    displayTitle: 'Movie',
    sortTitle: 'movie',
    originalTitle: 'Movie',
  });

const observation = (ageDays: number) => ({
  availabilityType: 'unknown' as const,
  observedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + ageDays * day),
});

const season = (
  airDate: string | null,
  episodes: { number: number; date: string | null }[]
) =>
  ({
    id: 1,
    name: 'Season 13',
    overview: '',
    air_date: airDate,
    season_number: 13,
    poster_path: null,
    episodes: episodes.map(({ number, date }) => ({
      id: number,
      name: `Episode ${number}`,
      overview: '',
      air_date: date,
      episode_number: number,
      season_number: 13,
      production_code: '',
      runtime: 30,
      still_path: null,
      vote_average: 0,
      vote_count: 0,
      crew: [],
      guest_stars: [],
    })),
  }) as unknown as TmdbSeasonWithEpisodes;

describe('Fresh discovery history policy', () => {
  it('uses inclusive Movie normal and 14-day first-observation grace boundaries', () => {
    const reference = movie('2026-01-01');
    assert.equal(
      evaluateMovieAdmission(reference, [observation(0)], 90)?.eligible,
      true
    );
    assert.equal(
      evaluateMovieAdmission(reference, [observation(90)], 90)?.reason,
      'eligible_movie'
    );
    assert.equal(
      evaluateMovieAdmission(reference, [observation(91)], 90)?.reason,
      'eligible_movie_first_observation_grace'
    );
    assert.equal(
      evaluateMovieAdmission(reference, [observation(104)], 90)?.eligible,
      true
    );
    assert.equal(
      evaluateMovieAdmission(reference, [observation(105)], 90)?.eligible,
      false
    );
    assert.equal(
      evaluateMovieAdmission(reference, [observation(-1)], 90)?.reason,
      'movie_not_yet_available'
    );
  });

  it('admits the audited Virginia Woolf first observation through grace and normalizes aliases', () => {
    const virginia = movie('2026-06-19');
    virginia.tmdbId = 1291375;
    const decision = evaluateMovieAdmission(
      virginia,
      [
        {
          availabilityType: 'unknown',
          observedAt: new Date('2026-09-28T01:45:34.000Z'),
        },
      ],
      90
    );
    assert.equal(decision?.reason, 'eligible_movie_first_observation_grace');
    assert.equal(decision?.eligible, true);
    assert.equal(
      normalizeFreshTitle("Virginia.Woolf's.Night.&.Day"),
      'virginia woolfs night and day'
    );
    assert.equal(
      normalizeFreshTitle('virginia.woolfs.night.and.day'),
      'virginia woolfs night and day'
    );
    assert.equal(
      normalizeFreshTitle('Amélie'),
      normalizeFreshTitle('Ame\u0301lie')
    );
  });

  it('requires explicit ordinary-season or special identity evidence', () => {
    assert.deepEqual(
      recurringIdentityForEvidence({
        mediaType: 'tv',
        seasonKey: 13,
        specialEpisodeKey: -1,
        explicitSeason: true,
        explicitSpecial: false,
      }),
      { identityKind: 'season', seasonKey: 13, specialEpisodeKey: -1 }
    );
    assert.deepEqual(
      recurringIdentityForEvidence({
        mediaType: 'tv',
        seasonKey: 0,
        specialEpisodeKey: 14,
        explicitSeason: false,
        explicitSpecial: true,
      }),
      { identityKind: 'special', seasonKey: 0, specialEpisodeKey: 14 }
    );
    assert.equal(
      recurringIdentityForEvidence({
        mediaType: 'tv',
        seasonKey: 0,
        specialEpisodeKey: 0,
        explicitSeason: false,
        explicitSpecial: false,
      }),
      undefined
    );
  });

  it('uses the latest aired episode for recurring TV season activity', () => {
    const details = season('2026-01-01', [
      { number: 1, date: '2026-01-01' },
      { number: 23, date: '2026-09-20' },
      { number: 24, date: '2026-09-27' },
      { number: 25, date: '2026-10-10' },
    ]);
    const identity = {
      identityKind: 'season' as const,
      seasonKey: 13,
      specialEpisodeKey: -1 as const,
    };
    assert.deepEqual(selectTvActivityDate(details, observedAt, identity), {
      date: '2026-09-27',
      source: 'tmdb_latest_aired_episode',
    });
    assert.equal(
      evaluateTvAdmission(details, observedAt, identity, 90).reason,
      'eligible_tv_recent_activity'
    );
  });

  it('falls back to a trustworthy season date and refuses future-only or missing activity', () => {
    const identity = {
      identityKind: 'season' as const,
      seasonKey: 13,
      specialEpisodeKey: -1 as const,
    };
    assert.deepEqual(
      selectTvActivityDate(season('2026-09-20', []), observedAt, identity),
      { date: '2026-09-20', source: 'tmdb_season_air_date' }
    );
    assert.equal(
      evaluateTvAdmission(
        season('2027-01-01', [{ number: 1, date: '2027-01-01' }]),
        observedAt,
        identity,
        90
      ).reason,
      'tv_not_yet_aired'
    );
    assert.equal(
      evaluateTvAdmission(season(null, []), observedAt, identity, 90).reason,
      'tv_activity_unknown'
    );
  });

  it('evaluates explicit specials by exact episode rather than by season activity', () => {
    const details = season('2020-01-01', [
      { number: 1, date: '2026-09-27' },
      { number: 14, date: '2020-01-01' },
    ]);
    assert.equal(
      evaluateTvAdmission(
        details,
        observedAt,
        { identityKind: 'special', seasonKey: 0, specialEpisodeKey: 14 },
        90
      ).reason,
      'historical_tv_season'
    );
    assert.equal(
      evaluateTvAdmission(
        details,
        observedAt,
        { identityKind: 'special', seasonKey: 0, specialEpisodeKey: 1 },
        90
      ).eligible,
      true
    );
  });
});
