import {
  MovieDiscoverCriteriaSchema,
  TvDiscoverCriteriaSchema,
  movieDiscoverOptions,
  tvDiscoverOptions,
} from '@server/lib/discoverCriteria';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('shared Discover criteria', () => {
  it('preserves normal movie route parsing and TMDB option mapping', () => {
    const query = MovieDiscoverCriteriaSchema.parse({
      page: '2',
      language: 'fr',
      genre: '18',
      studio: '42',
      primaryReleaseDateGte: '2026-01-02T12:00:00Z',
      sortBy: 'release_date.desc',
    });
    const options = movieDiscoverOptions(query, 'en');
    assert.equal(options.page, 2);
    assert.equal(options.language, 'en');
    assert.equal(options.originalLanguage, 'fr');
    assert.equal(options.genre, '18');
    assert.equal(options.studio, '42');
    assert.equal(options.primaryReleaseDateGte, '2026-01-02');
    assert.equal(options.sortBy, 'release_date.desc');
  });

  it('preserves normal TV route parsing and TMDB option mapping', () => {
    const query = TvDiscoverCriteriaSchema.parse({
      page: '3',
      network: '42',
      status: '0|2',
      firstAirDateLte: '2026-09-25',
      sortBy: 'first_air_date.desc',
    });
    const options = tvDiscoverOptions(query, 'en');
    assert.equal(options.page, 3);
    assert.equal(options.network, 42);
    assert.equal(options.withStatus, '0|2');
    assert.equal(options.firstAirDateLte, '2026-09-25');
    assert.equal(options.sortBy, 'first_air_date.desc');
  });
});
