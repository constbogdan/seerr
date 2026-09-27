import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import FreshMedia from '@server/entity/FreshMedia';
import {
  eligibilityDateForObservation,
  eligibilityForObservation,
  evaluateAdmissionEvidence,
  evaluateFreshMembership,
  observationQualifies,
  qualifiesAtObservation,
  selectMovieAvailabilityDates,
} from '@server/lib/fresh/membership';
import type { FreshSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const settings: FreshSettings = {
  enabled: true,
  baseUrl: 'https://autobrr.test',
  apiToken: 'test',
  filterId: 7,
  cachedFilterName: 'Fresh',
  mediaEligibilityDays: 90,
  freshVisibilityDays: 7,
  includeGenreIds: [],
  excludeGenreIds: [],
  includeOriginalLanguages: [],
  excludeOriginalLanguages: [],
  includeContentRatings: [],
  excludeContentRatings: [],
  minimumTmdbScore: 0,
  minimumTmdbVotes: 0,
};

const media = () =>
  new FreshMedia({
    mediaType: 'movie',
    tmdbId: 10,
    admitted: true,
    firstSeenAt: new Date('2026-03-20T00:00:00Z'),
    lastSeenAt: new Date('2026-03-20T00:00:00Z'),
    resolvedAt: new Date('2026-03-20T00:00:00Z'),
    metadataRefreshedAt: new Date('2026-03-20T00:00:00Z'),
    mediaDate: '2026-01-01',
    displayTitle: 'Example',
    originalTitle: 'Example',
    sortTitle: 'example',
    originalLanguage: 'en',
    genreIds: [18, 53],
    contentRating: 'R',
    voteAverage: 8.2,
    voteCount: 500,
  });

describe('Fresh membership', () => {
  it('separates observation-time admission from visibility expiry', () => {
    assert.equal(
      qualifiesAtObservation(
        '2026-01-01',
        new Date('2026-03-20T00:00:00Z'),
        90
      ),
      true
    );
    assert.equal(
      evaluateFreshMembership(
        media(),
        settings,
        new Date('2026-03-27T00:00:00Z')
      ).reason,
      'active_fresh'
    );
    assert.equal(
      evaluateFreshMembership(
        media(),
        settings,
        new Date('2026-03-28T00:00:01Z')
      ).reason,
      'visibility_expired'
    );
  });

  it('never admits unknown or too-old media and treats future dates sanely', () => {
    assert.equal(
      qualifiesAtObservation(
        '2025-01-01',
        new Date('2026-03-20T00:00:00Z'),
        90
      ),
      false
    );
    assert.equal(
      qualifiesAtObservation(null, new Date('2026-03-20T00:00:00Z'), 90),
      false
    );
    assert.equal(
      qualifiesAtObservation(
        '2026-04-01',
        new Date('2026-03-20T00:00:00Z'),
        90
      ),
      true
    );
  });

  it('selects regional Digital and Physical movie availability dates', () => {
    const dates = selectMovieAvailabilityDates(
      {
        release_date: '2026-07-31',
        release_dates: {
          results: [
            {
              iso_3166_1: 'US',
              release_dates: [
                {
                  certification: '',
                  release_date: '2026-09-29T00:00:00.000Z',
                  type: 4,
                },
                {
                  certification: '',
                  release_date: '2026-11-17T00:00:00.000Z',
                  type: 5,
                },
              ],
            },
          ],
        },
      } as TmdbMovieDetails,
      'US'
    );

    assert.deepEqual(dates, {
      digital: '2026-09-29',
      physical: '2026-11-17',
    });
  });

  it('uses the observed home-release class for movie eligibility', () => {
    const value = media();
    value.mediaDate = '2026-01-01';
    value.digitalReleaseDate = '2026-09-29';
    value.physicalReleaseDate = '2026-11-17';

    assert.equal(
      observationQualifies(
        value,
        {
          availabilityType: 'digital',
          observedAt: new Date('2026-10-01T00:00:00Z'),
        },
        30
      ),
      true
    );
    assert.equal(
      observationQualifies(
        value,
        {
          availabilityType: 'physical',
          observedAt: new Date('2027-01-01T00:00:00Z'),
        },
        30
      ),
      false
    );
  });

  it('falls back deterministically without inventing a movie date', () => {
    const value = media();
    value.mediaDate = '2026-07-31';
    value.digitalReleaseDate = null;
    value.physicalReleaseDate = '2026-11-17';
    assert.equal(eligibilityDateForObservation(value, 'digital'), '2026-11-17');
    value.physicalReleaseDate = null;
    assert.equal(eligibilityDateForObservation(value, 'digital'), '2026-07-31');
    value.mediaDate = null;
    assert.equal(eligibilityDateForObservation(value, 'digital'), null);
  });

  it('reports the actual fallback date source', () => {
    const value = media();
    value.mediaDate = '2026-01-01';
    value.digitalReleaseDate = null;
    value.physicalReleaseDate = '2026-03-01';
    const result = eligibilityForObservation(
      value,
      {
        availabilityType: 'digital',
        observedAt: new Date('2026-03-02T00:00:00Z'),
      },
      90
    );
    assert.equal(result.eligibilityDate, '2026-03-01');
    assert.equal(result.eligibilityDateSource, 'physical');
  });

  it('distinguishes insufficient legacy movie evidence from proven outside eligibility', () => {
    const value = media();
    value.admitted = false;
    value.mediaDate = '2025-01-01';
    value.digitalReleaseDate = null;
    value.physicalReleaseDate = null;
    assert.equal(
      evaluateAdmissionEvidence(
        value,
        [
          {
            availabilityType: 'unknown',
            observedAt: new Date('2026-03-20T00:00:00Z'),
          },
        ],
        90
      ).status,
      'unknown'
    );

    value.mediaType = 'tv';
    assert.equal(
      evaluateAdmissionEvidence(
        value,
        [
          {
            availabilityType: 'unknown',
            observedAt: new Date('2026-03-20T00:00:00Z'),
          },
        ],
        90
      ).status,
      'outside'
    );
  });

  it('applies include-any and exclude-wins content filters', () => {
    const value = media();
    assert.equal(
      evaluateFreshMembership(
        value,
        { ...settings, includeGenreIds: [35, 18] },
        new Date('2026-03-21T00:00:00Z')
      ).active,
      true
    );
    assert.equal(
      evaluateFreshMembership(
        value,
        {
          ...settings,
          includeGenreIds: [18],
          excludeGenreIds: [53],
        },
        new Date('2026-03-21T00:00:00Z')
      ).reason,
      'excluded_genre'
    );
    assert.equal(
      evaluateFreshMembership(
        value,
        { ...settings, includeOriginalLanguages: ['fr'] },
        new Date('2026-03-21T00:00:00Z')
      ).reason,
      'excluded_original_language'
    );
    assert.equal(
      evaluateFreshMembership(
        value,
        { ...settings, excludeContentRatings: ['movie:R'] },
        new Date('2026-03-21T00:00:00Z')
      ).reason,
      'excluded_content_rating'
    );
    assert.equal(
      evaluateFreshMembership(
        value,
        { ...settings, minimumTmdbScore: 8.5 },
        new Date('2026-03-21T00:00:00Z')
      ).reason,
      'below_tmdb_score'
    );
    assert.equal(
      evaluateFreshMembership(
        value,
        { ...settings, minimumTmdbVotes: 501 },
        new Date('2026-03-21T00:00:00Z')
      ).reason,
      'below_tmdb_vote_count'
    );
  });

  it('allows a removed exclusion only before visibility expires', () => {
    const value = media();
    const excluded = { ...settings, excludeGenreIds: [18] };
    assert.equal(
      evaluateFreshMembership(value, excluded, new Date('2026-03-21T00:00:00Z'))
        .active,
      false
    );
    assert.equal(
      evaluateFreshMembership(value, settings, new Date('2026-03-21T00:00:00Z'))
        .active,
      true
    );
    assert.equal(
      evaluateFreshMembership(value, settings, new Date('2026-03-29T00:00:00Z'))
        .active,
      false
    );
  });
});
