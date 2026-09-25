import {
  candidateQueryOptions,
  normalizeFreshCriteria,
} from '@server/lib/fresh/candidateQuery';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Fresh structured candidate criteria', () => {
  it('accepts normal movie and TV Discover criteria', () => {
    assert.deepEqual(
      normalizeFreshCriteria({ genre: '18', voteAverageGte: '6' }, 'movie'),
      { genre: '18', voteAverageGte: '6' }
    );
    assert.deepEqual(
      normalizeFreshCriteria(
        { network: '42', status: '0|2', watchRegion: 'US' },
        'tv'
      ),
      { network: '42', status: '0|2', watchRegion: 'US' }
    );
  });

  it('rejects explicit dates, pagination, router state, and cross-type criteria', () => {
    for (const criteria of [
      { page: '4' },
      { primaryReleaseDateGte: '2026-06-01' },
      { firstAirDateLte: '2026-09-01' },
      { path: '/discover/movies' },
      { network: '1' },
    ]) {
      assert.throws(() => normalizeFreshCriteria(criteria, 'movie'));
    }
    assert.throws(() => normalizeFreshCriteria({ studio: '1' }, 'tv'));
  });

  it('injects current rolling movie bounds through the shared mapper', () => {
    const first = candidateQueryOptions(
      { language: 'fr|en', voteCountGte: '100' },
      'movie',
      '2026-06-08',
      '2026-09-06'
    );
    const later = candidateQueryOptions(
      { language: 'fr|en', voteCountGte: '100' },
      'movie',
      '2026-07-08',
      '2026-10-06'
    );
    assert.equal(first.originalLanguage, 'fr|en');
    assert.equal(first.voteCountGte, '100');
    assert.equal(first.primaryReleaseDateGte, '2026-06-08');
    assert.equal(first.primaryReleaseDateLte, '2026-09-06');
    assert.equal(later.primaryReleaseDateGte, '2026-07-08');
  });

  it('generates rolling TV bounds independently', () => {
    const first = candidateQueryOptions(
      { network: '42' },
      'tv',
      '2026-06-08',
      '2026-09-06'
    );
    const later = candidateQueryOptions(
      { network: '42' },
      'tv',
      '2026-07-08',
      '2026-10-06'
    );
    assert.equal(first.network, 42);
    assert.equal(first.firstAirDateGte, '2026-06-08');
    assert.equal(first.firstAirDateLte, '2026-09-06');
    assert.equal(later.firstAirDateGte, '2026-07-08');
  });
});
