import { FreshCandidateStatus } from '@server/constants/fresh';
import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import FreshAdmissionOverride from '@server/entity/FreshAdmissionOverride';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshCandidateVisibility from '@server/entity/FreshCandidateVisibility';
import FreshManualResolution from '@server/entity/FreshManualResolution';
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

  it('requires typed, revision-bound administrator candidate mutations', async () => {
    const originalResolve = freshService.resolveCandidate;
    const originalReset = freshService.resetCandidateResolution;
    const originalAdmit = freshService.admitCandidate;
    const originalRemove = freshService.removeCandidateOverride;
    const originalVisibility = freshService.setCandidateVisibility;
    const originalBulkVisibility = freshService.setCandidateVisibilityBulk;
    const calls: string[] = [];
    freshService.resolveCandidate = async (
      candidateId,
      mediaType,
      tmdbId,
      expectedRevision
    ) => {
      calls.push(
        `resolve:${candidateId}:${mediaType}:${tmdbId}:${expectedRevision}`
      );
      return {
        candidate: new FreshCandidate({
          id: candidateId,
          mediaType: 'movie',
          effectiveMediaType: mediaType,
          status: FreshCandidateStatus.RESOLVED,
        }),
        media: new FreshMedia({
          mediaType,
          tmdbId,
          displayTitle: 'Canonical Title',
          active: false,
        }),
      };
    };
    freshService.resetCandidateResolution = async (candidateId, revision) => {
      calls.push(`reset:${candidateId}:${revision}`);
      return new FreshCandidate({ id: candidateId, revision: revision + 1 });
    };
    freshService.admitCandidate = async (candidateId, revision) => {
      calls.push(`admit:${candidateId}:${revision}`);
      return new FreshCandidate({ id: candidateId, revision: revision + 1 });
    };
    freshService.removeCandidateOverride = async (candidateId, revision) => {
      calls.push(`remove:${candidateId}:${revision}`);
      return new FreshCandidate({ id: candidateId, revision: revision + 1 });
    };
    freshService.setCandidateVisibility = async (
      candidateId,
      show,
      revision
    ) => {
      calls.push(`${show ? 'show' : 'dismiss'}:${candidateId}:${revision}`);
      return new FreshCandidate({ id: candidateId, revision: revision + 1 });
    };
    freshService.setCandidateVisibilityBulk = async (selections, show) => {
      calls.push(
        `bulk-${show ? 'show' : 'dismiss'}:${selections
          .map(
            ({ candidateId, expectedRevision }) =>
              `${candidateId}:${expectedRevision}`
          )
          .join(',')}`
      );
      return selections.map(
        ({ candidateId, expectedRevision }) =>
          new FreshCandidate({
            id: candidateId,
            revision: expectedRevision + 1,
          })
      );
    };
    try {
      assert.equal(
        (
          await request(app)
            .post('/settings/fresh/candidates/10/resolve')
            .set('x-test-role', 'user')
            .send({ mediaType: 'tv', tmdbId: 305251, expectedRevision: 7 })
        ).status,
        403
      );
      const resolved = await request(app)
        .post('/settings/fresh/candidates/10/resolve')
        .set('x-test-role', 'admin')
        .send({ mediaType: 'tv', tmdbId: 305251, expectedRevision: 7 });
      assert.equal(resolved.status, 200);
      assert.equal(resolved.body.parsedMediaType, 'movie');
      assert.equal(resolved.body.mediaType, 'tv');
      assert.equal(
        (
          await request(app)
            .post('/settings/fresh/candidates/10/resolve')
            .set('x-test-role', 'admin')
            .send({ tmdbId: 305251 })
        ).status,
        400
      );
      for (const [endpoint, expected] of [
        ['reset-resolution', 'reset:10:8'],
        ['admit', 'admit:10:8'],
        ['remove-override', 'remove:10:8'],
      ] as const) {
        const response = await request(app)
          .post(`/settings/fresh/candidates/10/${endpoint}`)
          .set('x-test-role', 'admin')
          .send({ expectedRevision: 8 });
        assert.equal(response.status, 200);
        assert.ok(calls.includes(expected));
      }
      assert.equal(
        (
          await request(app)
            .post('/settings/fresh/candidates/10/dismiss')
            .set('x-test-role', 'user')
            .send({ expectedRevision: 9 })
        ).status,
        403
      );
      for (const [endpoint, expected] of [
        ['dismiss', 'dismiss:10:9'],
        ['show', 'show:10:9'],
      ] as const) {
        const response = await request(app)
          .post(`/settings/fresh/candidates/10/${endpoint}`)
          .set('x-test-role', 'admin')
          .send({ expectedRevision: 9 });
        assert.equal(response.status, 200);
        assert.ok(calls.includes(expected));
      }
      assert.equal(
        (
          await request(app)
            .post('/settings/fresh/candidates/visibility')
            .set('x-test-role', 'user')
            .send({
              show: false,
              candidates: [{ candidateId: 10, expectedRevision: 9 }],
            })
        ).status,
        403
      );
      const bulk = await request(app)
        .post('/settings/fresh/candidates/visibility')
        .set('x-test-role', 'admin')
        .send({
          show: false,
          candidates: [
            { candidateId: 10, expectedRevision: 9 },
            { candidateId: 11, expectedRevision: 4 },
          ],
        });
      assert.equal(bulk.status, 200);
      assert.ok(calls.includes('bulk-dismiss:10:9,11:4'));
      assert.ok(calls.includes('resolve:10:tv:305251:7'));
    } finally {
      freshService.resolveCandidate = originalResolve;
      freshService.resetCandidateResolution = originalReset;
      freshService.admitCandidate = originalAdmit;
      freshService.removeCandidateOverride = originalRemove;
      freshService.setCandidateVisibility = originalVisibility;
      freshService.setCandidateVisibilityBulk = originalBulkVisibility;
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
    const settings = getSettings();
    settings.fresh = { ...settings.fresh, enabled: true };
    freshService.configure(settings.fresh);
    await dataSource.getRepository(FreshManualResolution).clear();
    await dataSource.getRepository(FreshAdmissionOverride).clear();
    await dataSource.getRepository(FreshCandidateVisibility).clear();
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
    const seasonUnknownMedia = await dataSource.getRepository(FreshMedia).save(
      new FreshMedia({
        mediaType: 'tv',
        tmdbId: 305251,
        admitted: false,
        active: false,
        membershipReason: 'season_unknown',
        automaticReasons: ['season_unknown'],
        lastMatchedGeneration: 3,
        firstSeenAt: new Date('2026-09-20T00:00:00Z'),
        lastSeenAt: new Date('2026-09-25T00:00:00Z'),
        resolvedAt: new Date('2026-09-25T00:00:00Z'),
        metadataRefreshedAt: new Date('2026-09-25T00:00:00Z'),
        displayTitle: 'FIA WEC',
        sortTitle: 'fia wec',
        originalTitle: 'FIA WEC',
        mediaDate: '2012-01-01',
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
        sourceEvidenceKey: 'needs-attention-key',
        firstObservedAt: new Date('2026-09-20T00:00:00Z'),
        lastObservedAt: new Date('2026-09-25T00:00:00Z'),
      }),
      new FreshCandidate({
        sourceGeneration: 3,
        mediaType: 'movie',
        normalizedTitle: 'identity collision',
        displayTitle: 'Identity Collision',
        matchYear: 2026,
        status: FreshCandidateStatus.RESOLVED,
        sourceEvidenceKey: 'identity-collision-key',
        automaticStatus: FreshCandidateStatus.RESOLVED,
        lastFailureReason: 'source_evidence_collision',
        firstObservedAt: new Date('2026-09-22T00:00:00Z'),
        lastObservedAt: new Date('2026-09-23T00:00:00Z'),
      }),
      new FreshCandidate({
        sourceGeneration: 3,
        mediaType: 'tv',
        normalizedTitle: 'ambiguous series',
        displayTitle: 'Ambiguous Series',
        status: FreshCandidateStatus.AMBIGUOUS,
        sourceEvidenceKey: 'ambiguous-series-key',
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
        sourceEvidenceKey: 'diagnostic-source-key',
        tmdbId: eligibilityUnknownMedia.tmdbId,
        freshMediaId: eligibilityUnknownMedia.id,
        firstObservedAt: new Date('2026-09-20T00:00:00Z'),
        lastObservedAt: new Date('2026-09-25T00:00:00Z'),
      }),
      new FreshCandidate({
        sourceGeneration: 3,
        mediaType: 'movie',
        effectiveMediaType: 'tv',
        normalizedTitle: 'fia wec 2026 6 hours of fuji',
        displayTitle: 'FIA WEC 2026 6 Hours Of Fuji',
        matchYear: 2026,
        seasonKey: -1,
        specialEpisodeKey: -1,
        explicitSeason: false,
        explicitSpecial: false,
        status: FreshCandidateStatus.RESOLVED,
        automaticStatus: FreshCandidateStatus.NO_MATCH,
        sourceEvidenceKey: 'fia-wec-source-key',
        tmdbId: seasonUnknownMedia.tmdbId,
        freshMediaId: seasonUnknownMedia.id,
        firstObservedAt: new Date('2026-09-20T00:00:00Z'),
        lastObservedAt: new Date('2026-09-25T00:00:00Z'),
      }),
    ]);
    await dataSource.getRepository(FreshObservation).save(
      new FreshObservation({
        sourceGeneration: 3,
        releaseId: 'diagnostic-legacy',
        filterId: 7,
        candidateId: candidates[3].id,
        mediaType: 'movie',
        title: 'Legacy Evidence',
        sourceTitle: 'Legacy.Evidence.2025.1080p.WEB-DL-GROUP',
        normalizedTitle: 'legacy evidence',
        year: 2025,
        availabilityType: 'unknown',
        observedAt: new Date('2026-09-20T00:00:00Z'),
      })
    );
    await dataSource.getRepository(FreshManualResolution).save(
      new FreshManualResolution({
        sourceEvidenceVersion: 1,
        sourceEvidenceKey: 'diagnostic-source-key',
        mediaType: 'movie',
        tmdbId: 9001,
        canonicalTitle: 'Legacy Evidence',
        active: true,
      })
    );
    await dataSource.getRepository(FreshManualResolution).save(
      new FreshManualResolution({
        sourceEvidenceVersion: 1,
        sourceEvidenceKey: 'fia-wec-source-key',
        mediaType: 'tv',
        tmdbId: 305251,
        canonicalTitle: 'FIA WEC',
        active: true,
      })
    );
    await dataSource.getRepository(FreshAdmissionOverride).save(
      new FreshAdmissionOverride({
        mediaType: 'movie',
        tmdbId: 9001,
        identityKind: 'movie',
        seasonKey: -1,
        specialEpisodeKey: -1,
        active: true,
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
    assert.deepEqual(response.body.results[0].sourceTitleSamples, []);
    assert.equal(response.body.summary.noMatch, 1);
    assert.equal(response.body.summary.ambiguous, 1);
    assert.equal(response.body.summary.needsAttention, 3);
    assert.equal(response.body.summary.eligibilityUnknown, 1);
    assert.equal(response.body.summary.outsideEligibilityWindow, 0);

    const prioritized = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=all&status=all&sort=priority'
      )
      .set('x-test-role', 'admin');
    assert.equal(prioritized.status, 200);
    assert.deepEqual(
      prioritized.body.results
        .slice(0, 2)
        .map((row: { displayStatus: string }) => row.displayStatus),
      ['no_match', 'ambiguous']
    );
    assert.equal(
      prioritized.body.results.some(
        (row: { displayStatus: string }) =>
          row.displayStatus === 'needs_attention'
      ),
      true
    );

    const attention = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=all&status=needs_attention&sort=status'
      )
      .set('x-test-role', 'admin');
    assert.equal(attention.status, 200);
    assert.equal(attention.body.results.length, 3);
    assert.equal(
      attention.body.results.every(
        (row: {
          actionable: boolean;
          actions: {
            resolve: boolean;
            resetResolution: boolean;
            admit: boolean;
            removeOverride: boolean;
          };
        }) =>
          row.actionable &&
          (row.actions.resolve ||
            row.actions.resetResolution ||
            row.actions.admit ||
            row.actions.removeOverride)
      ),
      true
    );
    const technicalIdentity = attention.body.results.find(
      (row: { displayTitle: string }) =>
        row.displayTitle === 'Identity Collision'
    );
    assert.equal(technicalIdentity.displayStatus, 'needs_attention');
    assert.equal(technicalIdentity.actions.resolve, true);
    assert.equal(technicalIdentity.actions.admit, false);

    const unknown = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=all&status=eligibility_unknown&sort=status'
      )
      .set('x-test-role', 'admin');
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.results.length, 1);
    assert.equal(unknown.body.results[0].displayStatus, 'reviewable');
    assert.equal(unknown.body.results[0].actions.admit, false);
    assert.deepEqual(unknown.body.results[0].sourceTitleSamples, [
      'Legacy.Evidence.2025.1080p.WEB-DL-GROUP',
    ]);
    assert.deepEqual(unknown.body.results[0].eligibility, {
      observationType: 'unknown',
      observationAt: '2026-09-20T00:00:00.000Z',
      eligibilityDate: '2025-01-01',
      eligibilityDateSource: 'canonical_fallback',
      ageDays: 627,
      eligibilityLimitDays: 90,
      legacyEvidence: true,
    });

    const unknownSeason = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=tv&status=all&sort=priority&seasonEvidence=unknown'
      )
      .set('x-test-role', 'admin');
    assert.equal(unknownSeason.status, 200);
    assert.equal(unknownSeason.body.results.length, 2);
    const fia = unknownSeason.body.results.find(
      (row: { displayTitle: string }) => row.displayTitle === 'FIA WEC'
    );
    assert.equal(fia.parsedTitle, 'FIA WEC 2026 6 Hours Of Fuji');
    assert.equal(fia.mediaType, 'tv');
    assert.equal(fia.tmdbId, 305251);
    assert.equal(fia.seasonNumber, undefined);
    assert.equal(fia.displayStatus, 'reviewable');
    assert.equal(fia.actions.admit, true);

    const resolutionFamily = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=all&status=all&sort=priority&reasonFamily=resolution'
      )
      .set('x-test-role', 'admin');
    assert.equal(resolutionFamily.status, 200);
    assert.equal(resolutionFamily.body.results.length, 3);

    const manuallyResolved = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&search=movie%3A9001&mediaType=all&status=all&sort=priority&manualResolution=present'
      )
      .set('x-test-role', 'admin');
    assert.equal(manuallyResolved.status, 200);
    assert.equal(manuallyResolved.body.results.length, 1);
    assert.equal(
      manuallyResolved.body.results[0].manualResolution.mediaType,
      'movie'
    );

    const overridden = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=all&status=all&sort=priority&admissionOverride=present'
      )
      .set('x-test-role', 'admin');
    assert.equal(overridden.status, 200);
    assert.equal(overridden.body.results.length, 1);
    assert.equal(overridden.body.results[0].admissionOverride.revision, 1);

    const publicFreshBefore = await request(app)
      .get('/fresh?page=1')
      .set('x-test-role', 'user');
    assert.equal(publicFreshBefore.status, 200);
    const membershipBefore = await dataSource
      .getRepository(FreshMedia)
      .findOneByOrFail({ id: eligibilityUnknownMedia.id });
    const dismissed = await request(app)
      .post(`/settings/fresh/candidates/${candidates[0].id}/dismiss`)
      .set('x-test-role', 'admin')
      .send({ expectedRevision: candidates[0].revision });
    assert.equal(dismissed.status, 200);
    const visible = await request(app)
      .get(
        '/settings/fresh/candidates?page=1&mediaType=all&status=all&sort=priority'
      )
      .set('x-test-role', 'admin');
    assert.equal(visible.body.results.length, 4);
    assert.equal(
      visible.body.results.some(
        (row: { candidateId: number }) => row.candidateId === candidates[0].id
      ),
      false
    );
    const hidden = await request(app)
      .get('/settings/fresh/candidates?visibility=hidden')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      hidden.body.results.map(
        (row: { candidateId: number }) => row.candidateId
      ),
      [candidates[0].id]
    );
    assert.equal(hidden.body.results[0].show, false);
    const all = await request(app)
      .get('/settings/fresh/candidates?visibility=all')
      .set('x-test-role', 'admin');
    assert.equal(all.body.results.length, 5);
    const shown = await request(app)
      .post(`/settings/fresh/candidates/${candidates[0].id}/show`)
      .set('x-test-role', 'admin')
      .send({ expectedRevision: dismissed.body.revision });
    assert.equal(shown.status, 200);
    const restored = await request(app)
      .get('/settings/fresh/candidates')
      .set('x-test-role', 'admin');
    assert.equal(restored.body.results.length, 5);

    const bulkCandidates = await Promise.all(
      candidates
        .slice(0, 2)
        .map(({ id }) =>
          dataSource.getRepository(FreshCandidate).findOneByOrFail({ id })
        )
    );
    const bulkDismissed = await request(app)
      .post('/settings/fresh/candidates/visibility')
      .set('x-test-role', 'admin')
      .send({
        show: false,
        candidates: bulkCandidates.map((candidate) => ({
          candidateId: candidate.id,
          expectedRevision: candidate.revision,
        })),
      });
    assert.equal(bulkDismissed.status, 200);
    assert.equal(bulkDismissed.body.candidates.length, 2);
    const bulkHidden = await request(app)
      .get('/settings/fresh/candidates?visibility=hidden')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        bulkHidden.body.results.map(
          (row: { candidateId: number }) => row.candidateId
        )
      ),
      new Set(bulkCandidates.map(({ id }) => id))
    );
    const bulkShown = await request(app)
      .post('/settings/fresh/candidates/visibility')
      .set('x-test-role', 'admin')
      .send({
        show: true,
        candidates: bulkDismissed.body.candidates.map(
          (candidate: { candidateId: number; revision: number }) => ({
            candidateId: candidate.candidateId,
            expectedRevision: candidate.revision,
          })
        ),
      });
    assert.equal(bulkShown.status, 200);

    const beforeAtomicFailure = await Promise.all(
      bulkCandidates.map(({ id }) =>
        dataSource.getRepository(FreshCandidate).findOneByOrFail({ id })
      )
    );
    const staleBulk = await request(app)
      .post('/settings/fresh/candidates/visibility')
      .set('x-test-role', 'admin')
      .send({
        show: false,
        candidates: beforeAtomicFailure.map((candidate, index) => ({
          candidateId: candidate.id,
          expectedRevision: candidate.revision - (index === 1 ? 1 : 0),
        })),
      });
    assert.equal(staleBulk.status, 409);
    const afterAtomicFailure = await Promise.all(
      bulkCandidates.map(({ id }) =>
        dataSource.getRepository(FreshCandidate).findOneByOrFail({ id })
      )
    );
    assert.deepEqual(
      afterAtomicFailure.map(({ revision }) => revision),
      beforeAtomicFailure.map(({ revision }) => revision)
    );
    const visibleAfterAtomicFailure = await request(app)
      .get('/settings/fresh/candidates')
      .set('x-test-role', 'admin');
    assert.equal(
      bulkCandidates.every(({ id }) =>
        visibleAfterAtomicFailure.body.results.some(
          (row: { candidateId: number }) => row.candidateId === id
        )
      ),
      true
    );
    const membershipAfter = await dataSource
      .getRepository(FreshMedia)
      .findOneByOrFail({ id: eligibilityUnknownMedia.id });
    assert.deepEqual(
      {
        active: membershipAfter.active,
        admitted: membershipAfter.admitted,
        reason: membershipAfter.membershipReason,
      },
      {
        active: membershipBefore.active,
        admitted: membershipBefore.admitted,
        reason: membershipBefore.membershipReason,
      }
    );
    const publicFreshAfter = await request(app)
      .get('/fresh?page=1')
      .set('x-test-role', 'user');
    assert.equal(publicFreshAfter.status, 200);
    assert.deepEqual(publicFreshAfter.body, publicFreshBefore.body);

    const invalidFacet = await request(app)
      .get('/settings/fresh/candidates?manualResolution=sometimes')
      .set('x-test-role', 'admin');
    assert.equal(invalidFacet.status, 400);
  });

  it('uses canonical display casing without rewriting parsed or source evidence', async () => {
    await dataSource.getRepository(FreshObservation).clear();
    await dataSource.getRepository(FreshCandidate).clear();
    await dataSource.getRepository(FreshMedia).clear();
    await dataSource.getRepository(FreshSyncState).save(
      new FreshSyncState({
        id: 1,
        generation: 4,
        sourceFingerprint: 'canonical-title-fixture',
      })
    );
    const media = await dataSource.getRepository(FreshMedia).save(
      new FreshMedia({
        mediaType: 'movie',
        tmdbId: 1480387,
        active: false,
        admitted: false,
        lastMatchedGeneration: 4,
        firstSeenAt: new Date('2026-09-29T00:00:00Z'),
        lastSeenAt: new Date('2026-09-29T00:00:00Z'),
        resolvedAt: new Date('2026-09-29T00:00:00Z'),
        metadataRefreshedAt: new Date('2026-09-29T00:00:00Z'),
        displayTitle: 'undertone',
        sortTitle: 'undertone',
        originalTitle: 'undertone',
        mediaDate: '2026-01-01',
      })
    );
    const resolved = await dataSource.getRepository(FreshCandidate).save(
      new FreshCandidate({
        sourceGeneration: 4,
        mediaType: 'movie',
        effectiveMediaType: 'movie',
        normalizedTitle: 'undertone',
        displayTitle: 'Undertone',
        matchYear: 2026,
        status: FreshCandidateStatus.RESOLVED,
        sourceEvidenceKey: 'undertone-source-key',
        tmdbId: 1480387,
        freshMediaId: media.id,
        firstObservedAt: new Date('2026-09-29T00:00:00Z'),
        lastObservedAt: new Date('2026-09-29T00:00:00Z'),
      })
    );
    await dataSource.getRepository(FreshObservation).save(
      new FreshObservation({
        sourceGeneration: 4,
        releaseId: 'undertone-release',
        filterId: 7,
        candidateId: resolved.id,
        mediaType: 'movie',
        title: 'Undertone',
        sourceTitle: 'Undertone.2026.1080p.WEB-DL-GROUP',
        normalizedTitle: 'undertone',
        year: 2026,
        availabilityType: 'digital',
        observedAt: new Date('2026-09-29T00:00:00Z'),
      })
    );
    await dataSource.getRepository(FreshCandidate).save(
      new FreshCandidate({
        sourceGeneration: 4,
        mediaType: 'movie',
        normalizedTitle: 'unresolved evidence',
        displayTitle: 'Unresolved Evidence',
        matchYear: 2026,
        status: FreshCandidateStatus.NO_MATCH,
        sourceEvidenceKey: 'unresolved-title-key',
        firstObservedAt: new Date('2026-09-29T00:00:00Z'),
        lastObservedAt: new Date('2026-09-29T00:00:00Z'),
      })
    );

    const canonical = await request(app)
      .get('/settings/fresh/candidates?search=undertone&visibility=all')
      .set('x-test-role', 'admin');
    assert.equal(canonical.status, 200);
    assert.equal(canonical.body.results.length, 1);
    assert.equal(canonical.body.results[0].displayTitle, 'Undertone');
    assert.equal(canonical.body.results[0].parsedTitle, 'undertone');
    assert.deepEqual(canonical.body.results[0].sourceTitleSamples, [
      'Undertone.2026.1080p.WEB-DL-GROUP',
    ]);

    const unresolved = await request(app)
      .get(
        '/settings/fresh/candidates?search=unresolved%20evidence&visibility=all'
      )
      .set('x-test-role', 'admin');
    assert.equal(unresolved.status, 200);
    assert.equal(unresolved.body.results.length, 1);
    assert.equal(
      unresolved.body.results[0].displayTitle,
      'Unresolved Evidence'
    );
    assert.equal(unresolved.body.results[0].parsedTitle, 'Unresolved Evidence');
  });
});
