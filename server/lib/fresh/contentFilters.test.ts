import {
  matchesFreshContentFilters,
  normalizeFreshContentFilters,
} from '@server/lib/fresh/contentFilters';
import type { FreshProviderPresentation } from '@server/lib/fresh/presentation';
import { fixtureSettings } from '@server/test/freshFixtures';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Fresh presentation-only content predicates', () => {
  const metadata = {
    genres: [{ id: 18, name: 'Drama' }],
    original_language: 'en',
    vote_average: 7,
    vote_count: 100,
  };
  const passes = (
    filters = {},
    value: Partial<FreshProviderPresentation> = metadata
  ) => matchesFreshContentFilters(value, { ...fixtureSettings, ...filters });
  it('empty exclusions and zero thresholds require no metadata', () => {
    assert.equal(passes(), true);
    assert.equal(
      passes(
        {
          excludeGenreIds: [],
          excludeOriginalLanguages: [],
          minimumTmdbScore: 0,
          minimumTmdbVotes: 0,
        },
        {}
      ),
      true
    );
  });
  it('excludes any selected genre, including multiple exclusions', () => {
    assert.equal(passes({ excludeGenreIds: [16] }), true);
    assert.equal(passes({ excludeGenreIds: [18] }), false);
    assert.equal(passes({ excludeGenreIds: [16, 18, 10762] }), false);
    assert.equal(passes({ excludeGenreIds: [18] }, {}), false);
  });
  it('uses canonical original-language codes', () => {
    assert.equal(passes({ excludeOriginalLanguages: ['hi'] }), true);
    assert.equal(passes({ excludeOriginalLanguages: ['en', 'hi'] }), false);
    assert.equal(passes({ excludeOriginalLanguages: ['hi'] }, {}), false);
  });
  it('includes score equality, excludes below, missing, invalid and unrated scores', () => {
    assert.equal(passes({ minimumTmdbScore: 7 }), true);
    for (const score of [6.9, 0, -1, 11, NaN, Infinity, undefined]) {
      assert.equal(
        passes({ minimumTmdbScore: 7 }, { ...metadata, vote_average: score }),
        false
      );
    }
    assert.equal(
      passes({ minimumTmdbScore: 0 }, { ...metadata, vote_average: undefined }),
      true
    );
  });
  it('includes vote equality and excludes below, missing and invalid vote counts', () => {
    assert.equal(passes({ minimumTmdbVotes: 100 }), true);
    for (const votes of [99, -1, 100.5, NaN, Infinity, undefined]) {
      assert.equal(
        passes({ minimumTmdbVotes: 100 }, { ...metadata, vote_count: votes }),
        false
      );
    }
    assert.equal(passes({ minimumTmdbVotes: 0 }, {}), true);
  });
  it('requires all conditions; genre and language exclusions override qualifying scores', () => {
    const filters = {
      excludeGenreIds: [16],
      excludeOriginalLanguages: ['hi'],
      minimumTmdbScore: 7,
      minimumTmdbVotes: 100,
    };
    assert.equal(passes(filters), true);
    assert.equal(passes({ ...filters, minimumTmdbVotes: 101 }), false);
    assert.equal(passes({ ...filters, excludeGenreIds: [18] }), false);
    assert.equal(
      passes({ ...filters, excludeOriginalLanguages: ['en'] }),
      false
    );
  });
  it('rejects malformed settings and normalizes only safe defaults and duplicate selections', () => {
    for (const invalid of [
      { minimumTmdbScore: -1 },
      { minimumTmdbScore: 10.1 },
      { minimumTmdbScore: '7' },
      { minimumTmdbVotes: 1.2 },
      { minimumTmdbVotes: -1 },
      { minimumTmdbVotes: Number.MAX_SAFE_INTEGER + 1 },
      { excludeGenreIds: [0] },
      { excludeOriginalLanguages: ['Hindi'] },
    ]) {
      assert.throws(() =>
        normalizeFreshContentFilters({
          ...fixtureSettings,
          ...invalid,
        } as never)
      );
    }
    assert.deepEqual(normalizeFreshContentFilters(fixtureSettings), {
      excludeGenreIds: [],
      excludeOriginalLanguages: [],
      minimumTmdbScore: 0,
      minimumTmdbVotes: 0,
    });
    assert.deepEqual(
      normalizeFreshContentFilters({
        ...fixtureSettings,
        excludeGenreIds: [16, 16],
      }).excludeGenreIds,
      [16]
    );
  });
});
