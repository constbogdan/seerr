import { FreshCandidateStatus } from '@server/constants/fresh';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshMedia from '@server/entity/FreshMedia';
import FreshObservation from '@server/entity/FreshObservation';
import { FreshSyncState } from '@server/entity/FreshSyncState';
import Media from '@server/entity/Media';
import freshService from '@server/lib/fresh/service';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import freshRoutes from '@server/routes/fresh';
import freshSettingsRoutes, {
  mergeFreshSettingsUpdate,
} from '@server/routes/settings/fresh';
import express from 'express';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.header('x-test-role');
  if (role) {
    req.user = {
      id: 1,
      hasPermission: (permission: Permission) =>
        role === 'admin' || permission === 0,
    } as Express.Request['user'];
  }
  next();
});
app.use('/fresh', isAuthenticated(), freshRoutes);
app.use(
  '/settings/fresh',
  isAuthenticated(Permission.ADMIN),
  freshSettingsRoutes
);

describe('Fresh route authorization and safe responses', () => {
  before(async () => {
    if (!dataSource.isInitialized) await dataSource.initialize();
    await dataSource.synchronize(true);
  });

  after(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });
  it('retains the write-only token when updates omit or blank it', () => {
    const current = {
      enabled: true,
      baseUrl: 'https://autobrr.test',
      apiToken: 'fixture-token',
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
    const body = { ...current, apiToken: '' };
    assert.equal(
      mergeFreshSettingsUpdate(current, body).apiToken,
      'fixture-token'
    );
    const omitted: Partial<typeof body> = { ...body };
    delete omitted.apiToken;
    assert.equal(
      mergeFreshSettingsUpdate(current, omitted).apiToken,
      'fixture-token'
    );
  });

  it('replaces a supplied token and rejects response-only settings state', () => {
    const current = {
      enabled: true,
      baseUrl: 'https://autobrr.test',
      apiToken: 'fixture-token',
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
    assert.equal(
      mergeFreshSettingsUpdate(current, {
        ...current,
        apiToken: 'replacement-token',
      }).apiToken,
      'replacement-token'
    );
    assert.throws(() =>
      mergeFreshSettingsUpdate(current, {
        ...current,
        apiToken: '',
        apiTokenConfigured: true,
      })
    );
  });

  it('persists enabled changes through settings, public state, and status', async () => {
    const current = {
      enabled: true,
      baseUrl: 'https://autobrr.test',
      apiToken: 'fixture-token',
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
    const disabled = mergeFreshSettingsUpdate(current, {
      ...current,
      enabled: false,
      apiToken: '',
    });
    assert.equal(disabled.enabled, false);
    const settings = getSettings();
    settings.fresh = disabled;
    freshService.configure(disabled);
    assert.equal(settings.fullPublicSettings.freshEnabled, false);
    assert.equal((await freshService.status()).status, 'disabled');

    const enabled = mergeFreshSettingsUpdate(disabled, {
      ...disabled,
      enabled: true,
      apiToken: '',
    });
    settings.fresh = enabled;
    freshService.configure(enabled);
    assert.equal(enabled.enabled, true);
    assert.equal(settings.fullPublicSettings.freshEnabled, true);
    assert.equal((await freshService.status()).status, 'preparing');
  });

  it('requires authentication for results and admin permission for operations', async () => {
    assert.equal((await request(app).get('/fresh')).status, 403);
    assert.equal(
      (await request(app).get('/settings/fresh').set('x-test-role', 'user'))
        .status,
      403
    );
    assert.equal(
      (
        await request(app)
          .get('/settings/fresh/diagnostics')
          .set('x-test-role', 'user')
      ).status,
      403
    );
    assert.equal(
      (
        await request(app)
          .post('/settings/fresh/rebuild')
          .set('x-test-role', 'user')
      ).status,
      403
    );
  });

  it('allows only an administrator to await a completed Fresh rebuild', async () => {
    const original = freshService.rebuild;
    let calls = 0;
    freshService.rebuild = async () => {
      calls++;
    };
    try {
      const response = await request(app)
        .post('/settings/fresh/rebuild')
        .set('x-test-role', 'admin');
      assert.equal(response.status, 200);
      assert.equal(calls, 1);
      assert.equal(typeof response.body.status, 'string');
      freshService.rebuild = async () => {
        throw new Error(
          'https://tracker.invalid/download?apikey=secret-provider-token'
        );
      };
      const failed = await request(app)
        .post('/settings/fresh/rebuild')
        .set('x-test-role', 'admin');
      assert.equal(failed.status, 500);
      assert.doesNotMatch(failed.text, /secret-provider-token/);
    } finally {
      freshService.rebuild = original;
    }
  });

  it('paginates the prepared projection after server-side filtering and sorting', async () => {
    const settings = getSettings();
    settings.fresh = {
      enabled: true,
      baseUrl: 'https://autobrr.test',
      apiToken: 'fixture-token',
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
    freshService.configure(settings.fresh);
    await dataSource.getRepository(FreshSyncState).save(
      new FreshSyncState({
        id: 1,
        sourceFingerprint: 'fixture',
        filterId: 7,
        generation: 1,
        checkpointReleaseId: '30',
        lastSuccessfulSyncAt: new Date('2026-09-26T10:00:00Z'),
      })
    );
    const repository = dataSource.getRepository(FreshMedia);
    await repository.clear();
    await repository.save(
      Array.from(
        { length: 25 },
        (_, index) =>
          new FreshMedia({
            mediaType: 'movie',
            tmdbId: 1000 + index,
            active: true,
            lastMatchedGeneration: 1,
            firstSeenAt: new Date(
              Date.parse('2026-09-01T00:00:00Z') + index * 1000
            ),
            lastSeenAt: new Date('2026-09-25T00:00:00Z'),
            resolvedAt: new Date('2026-09-25T00:00:00Z'),
            metadataRefreshedAt: new Date('2026-09-25T00:00:00Z'),
            displayTitle: `Movie ${index}`,
            sortTitle: `movie ${index.toString().padStart(2, '0')}`,
            originalTitle: `Movie ${index}`,
            mediaDate: '2026-09-01',
            overview: '',
            originalLanguage: 'en',
            genreIds: [],
            originCountries: [],
          })
      )
    );
    await dataSource.getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 1000,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
      })
    );

    const first = await request(app)
      .get('/fresh?page=1&mediaType=movie&sort=oldest')
      .set('x-test-role', 'user');
    assert.equal(first.status, 200);
    assert.equal(first.body.results.length, 20);
    assert.equal(first.body.results[0].id, 1000);
    assert.equal(first.body.results[0].mediaInfo.status, MediaStatus.AVAILABLE);
    assert.equal(
      first.body.results[0].freshFirstSeenAt,
      '2026-09-01T00:00:00.000Z'
    );
    assert.equal(await dataSource.getRepository(Media).count(), 1);

    const second = await request(app)
      .get('/fresh?page=2&mediaType=movie&sort=oldest')
      .set('x-test-role', 'user');
    assert.equal(second.status, 200);
    assert.equal(second.body.page, 2);
    assert.equal(second.body.totalPages, 2);
    assert.equal(second.body.totalResults, 25);
    assert.equal(second.body.results.length, 5);

    const outside = await request(app)
      .get('/fresh?page=3&mediaType=movie&sort=oldest')
      .set('x-test-role', 'user');
    assert.equal(outside.status, 200);
    assert.deepEqual(outside.body.results, []);

    await repository.save(
      Array.from(
        { length: 21 },
        (_, index) =>
          new FreshMedia({
            mediaType: 'tv',
            tmdbId: 2000 + index,
            active: true,
            lastMatchedGeneration: 1,
            firstSeenAt: new Date(
              Date.parse('2026-09-02T00:00:00Z') + index * 1000
            ),
            lastSeenAt: new Date('2026-09-25T00:00:00Z'),
            resolvedAt: new Date('2026-09-25T00:00:00Z'),
            metadataRefreshedAt: new Date('2026-09-25T00:00:00Z'),
            displayTitle: `Series ${index}`,
            sortTitle: `series ${index.toString().padStart(2, '0')}`,
            originalTitle: `Series ${index}`,
            mediaDate: index === 0 ? null : '2026-09-02',
            overview: '',
            originalLanguage: 'en',
            genreIds: [],
            originCountries: ['US'],
          })
      )
    );
    const tvSecond = await request(app)
      .get('/fresh?page=2&mediaType=tv&sort=title')
      .set('x-test-role', 'user');
    assert.equal(tvSecond.status, 200);
    assert.equal(tvSecond.body.totalResults, 21);
    assert.equal(tvSecond.body.totalPages, 2);
    assert.equal(tvSecond.body.results.length, 1);
    const tvByYear = await request(app)
      .get('/fresh?page=2&mediaType=tv&sort=year')
      .set('x-test-role', 'user');
    assert.equal(tvByYear.body.results[0].id, 2000);
    for (const sort of [
      'freshest',
      'oldest',
      'title',
      'year',
      'vote_average.desc',
      'vote_average.asc',
    ]) {
      const sorted = await request(app)
        .get(`/fresh?page=1&mediaType=all&sort=${sort}`)
        .set('x-test-role', 'user');
      assert.equal(sorted.status, 200);
      assert.equal(sorted.body.totalResults, 46);
      assert.equal(sorted.body.results.length, 20);
    }
  });

  it('returns disabled results to users and write-only settings to admins', async () => {
    const settings = getSettings();
    settings.fresh = {
      enabled: false,
      baseUrl: 'https://autobrr.test',
      apiToken: 'fixture-token',
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
    freshService.configure(settings.fresh);

    const result = await request(app).get('/fresh').set('x-test-role', 'user');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.results, []);
    assert.equal(result.body.status.status, 'disabled');

    const response = await request(app)
      .get('/settings/fresh')
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.apiTokenConfigured, true);
    assert.equal(response.body.apiToken, undefined);
    assert.deepEqual(Object.keys(response.body).sort(), [
      'apiTokenConfigured',
      'baseUrl',
      'cachedFilterName',
      'enabled',
      'excludeContentRatings',
      'excludeGenreIds',
      'excludeOriginalLanguages',
      'filterId',
      'freshVisibilityDays',
      'includeContentRatings',
      'includeGenreIds',
      'includeOriginalLanguages',
      'mediaEligibilityDays',
      'minimumTmdbScore',
      'minimumTmdbVotes',
    ]);
    assert.doesNotMatch(JSON.stringify(response.body), /fixture-token/);

    const diagnostics = await request(app)
      .get('/settings/fresh/diagnostics')
      .set('x-test-role', 'admin');
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.body.latestAttempt, null);
    assert.equal(diagnostics.body.currentProjection.status, 'disabled');
    assert.doesNotMatch(JSON.stringify(diagnostics.body), /fixture-token/);
  });

  it('serves persistent candidate diagnostics with admin-only filtering and summary counts', async () => {
    await dataSource.getRepository(FreshCandidate).clear();
    await dataSource.getRepository(FreshSyncState).save(
      new FreshSyncState({
        id: 1,
        generation: 3,
        sourceFingerprint: 'fixture',
      })
    );
    const eligibilityUnknownMedia = await dataSource
      .getRepository(FreshMedia)
      .save(
        new FreshMedia({
          mediaType: 'movie',
          tmdbId: 9001,
          admitted: false,
          membershipReason: 'eligibility_unknown',
          lastMatchedGeneration: 3,
          firstSeenAt: new Date('2026-09-20T00:00:00Z'),
          lastSeenAt: new Date('2026-09-25T00:00:00Z'),
          resolvedAt: new Date('2026-09-25T00:00:00Z'),
          metadataRefreshedAt: new Date('2026-09-25T00:00:00Z'),
          displayTitle: 'Legacy Evidence',
          sortTitle: 'legacy evidence',
          originalTitle: 'Legacy Evidence',
          mediaDate: '2025-01-01',
        })
      );
    const candidates = await dataSource.getRepository(FreshCandidate).save([
      new FreshCandidate({
        sourceGeneration: 3,
        mediaType: 'movie',
        normalizedTitle: 'needs attention',
        displayTitle: 'Needs Attention',
        matchYear: 2026,
        status: FreshCandidateStatus.NO_MATCH,
        firstObservedAt: new Date('2026-09-20T00:00:00Z'),
        lastObservedAt: new Date('2026-09-25T00:00:00Z'),
      }),
      new FreshCandidate({
        sourceGeneration: 3,
        mediaType: 'tv',
        normalizedTitle: 'ambiguous series',
        displayTitle: 'Ambiguous Series',
        status: FreshCandidateStatus.AMBIGUOUS,
        firstObservedAt: new Date('2026-09-21T00:00:00Z'),
        lastObservedAt: new Date('2026-09-24T00:00:00Z'),
      }),
      new FreshCandidate({
        sourceGeneration: 3,
        mediaType: 'movie',
        normalizedTitle: 'legacy evidence',
        displayTitle: 'Legacy Evidence',
        matchYear: 2025,
        status: FreshCandidateStatus.RESOLVED,
        tmdbId: eligibilityUnknownMedia.tmdbId,
        freshMediaId: eligibilityUnknownMedia.id,
        firstObservedAt: new Date('2026-09-20T00:00:00Z'),
        lastObservedAt: new Date('2026-09-25T00:00:00Z'),
      }),
    ]);
    await dataSource.getRepository(FreshObservation).save(
      new FreshObservation({
        sourceGeneration: 3,
        releaseId: 'diagnostic-legacy',
        filterId: 7,
        candidateId: candidates[2].id,
        mediaType: 'movie',
        title: 'Legacy Evidence',
        normalizedTitle: 'legacy evidence',
        year: 2025,
        availabilityType: 'unknown',
        observedAt: new Date('2026-09-20T00:00:00Z'),
      })
    );
    const forbidden = await request(app)
      .get('/settings/fresh/candidates')
      .set('x-test-role', 'user');
    assert.equal(forbidden.status, 403);
    const response = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&search=attention&mediaType=movie&status=no_match&sort=title.asc'
      )
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.results.length, 1);
    assert.equal(response.body.results[0].displayTitle, 'Needs Attention');
    assert.equal(response.body.results[0].displayStatus, 'no_match');
    assert.equal(response.body.results[0].actionable, true);
    assert.equal(response.body.summary.noMatch, 1);
    assert.equal(response.body.summary.ambiguous, 1);
    assert.equal(response.body.summary.needsAttention, 2);
    assert.equal(response.body.summary.eligibilityUnknown, 1);
    assert.equal(response.body.summary.outsideEligibilityWindow, 0);

    const attention = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=all&status=needs_attention&sort=status'
      )
      .set('x-test-role', 'admin');
    assert.equal(attention.status, 200);
    assert.equal(attention.body.results.length, 2);

    const unknown = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=all&status=eligibility_unknown&sort=status'
      )
      .set('x-test-role', 'admin');
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.results.length, 1);
    assert.equal(unknown.body.results[0].displayStatus, 'eligibility_unknown');
    assert.deepEqual(unknown.body.results[0].eligibility, {
      observationType: 'unknown',
      observationAt: '2026-09-20T00:00:00.000Z',
      eligibilityDate: '2025-01-01',
      eligibilityDateSource: 'canonical_fallback',
      ageDays: 627,
      eligibilityLimitDays: 90,
      legacyEvidence: true,
    });
  });
});
