import TheMovieDb from '@server/api/themoviedb';
import Media from '@server/entity/Media';
import { movieCollectionMembership } from '@server/lib/movieCollectionMembership';
import { isAuthenticated } from '@server/middleware/auth';
import movieRoutes from '@server/routes/movie';
import { fixtureMovie } from '@server/test/freshFixtures';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { load } from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, mock } from 'node:test';
import request from 'supertest';

const app = express();
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
    validateRequests: true,
    validateResponses: true,
    validateSecurity: false,
    ignoreUndocumented: true,
  })
);
app.use((req, _res, next) => {
  if (req.header('x-test-user'))
    req.user = {
      hasPermission: () => true,
    } as unknown as Express.Request['user'];
  next();
});
app.use('/movie', isAuthenticated(), movieRoutes);

afterEach(() => mock.restoreAll());

describe('optional movie recommendation collection membership', () => {
  it('documents the opt-in flag and distinct unresolved response in OpenAPI', () => {
    const spec = load(readFileSync('seerr-api.yml', 'utf8')) as {
      paths: Record<string, { get: { parameters: { name: string }[] } }>;
      components: { schemas: Record<string, unknown> };
    };
    assert.ok(
      spec.paths['/movie/{movieId}/recommendations'].get.parameters.some(
        (parameter) => parameter.name === 'includeCollectionIds'
      )
    );
    assert.ok(
      spec.components.schemas.MovieRecommendationWithCollectionMembership
    );
    assert.ok(spec.components.schemas.MovieCollectionMembership);
  });
  const stubPage = () => {
    mock.method(
      TheMovieDb.prototype,
      'getMovieRecommendations',
      async () =>
        ({
          page: 2,
          total_pages: 4,
          total_results: 80,
          results: [
            fixtureMovie(4, 'First'),
            fixtureMovie(5, 'Second'),
            fixtureMovie(4, 'First Again'),
          ],
        }) as never
    );
    mock.method(Media, 'getRelatedMedia', async () => [] as never);
  };

  it('keeps the original shape and performs no resolution when absent or false', async () => {
    stubPage();
    const resolve = mock.method(
      movieCollectionMembership,
      'resolve',
      async () => {
        throw new Error('should not resolve');
      }
    );
    for (const query of ['', '?includeCollectionIds=false']) {
      const response = await request(app)
        .get('/movie/1/recommendations' + query)
        .set('x-test-user', 'yes');
      assert.equal(response.status, 200);
      assert.deepEqual(
        response.body.results.map((item: { id: number }) => item.id),
        [4, 5, 4]
      );
      assert.equal(response.body.results[0].collectionMembership, undefined);
      assert.equal(response.body.page, 2);
      assert.equal(response.body.totalResults, 80);
    }
    assert.equal(resolve.mock.callCount(), 0);
  });

  it('attaches opt-in results by identity without changing order or pagination', async () => {
    stubPage();
    const resolve = mock.method(
      movieCollectionMembership,
      'resolve',
      async () => ({
        results: new Map([
          [
            4,
            {
              membership: { kind: 'collection' as const, collectionId: 42 },
              observedAt: new Date(),
              stale: false,
              source: 'observation' as const,
            },
          ],
          [
            5,
            {
              membership: { kind: 'standalone' as const },
              observedAt: new Date(),
              stale: false,
              source: 'canonical' as const,
            },
          ],
        ]),
        stats: {
          canonicalHits: 1,
          observationHits: 1,
          tmdbFallbackCalls: 0,
          unresolved: 0,
        },
      })
    );
    const response = await request(app)
      .get('/movie/1/recommendations?includeCollectionIds=true')
      .set('x-test-user', 'yes');
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.results.map((item: { id: number }) => item.id),
      [4, 5, 4]
    );
    assert.deepEqual(
      response.body.results.map(
        (item: { collectionMembership: unknown }) => item.collectionMembership
      ),
      [
        { kind: 'collection', collectionId: 42 },
        { kind: 'standalone' },
        { kind: 'collection', collectionId: 42 },
      ]
    );
    assert.equal(resolve.mock.callCount(), 1);
    assert.deepEqual(resolve.mock.calls[0].arguments[0], [
      { mediaType: 'movie', tmdbId: 4 },
      { mediaType: 'movie', tmdbId: 5 },
      { mediaType: 'movie', tmdbId: 4 },
    ]);
    assert.deepEqual(resolve.mock.calls[0].arguments[1], {
      maxLookups: 4,
      concurrency: 4,
      deadlineMs: 1_000,
    });
  });

  it('returns unresolved results if the optional resolver fails', async () => {
    stubPage();
    mock.method(movieCollectionMembership, 'resolve', async () => {
      throw new Error('database unavailable');
    });
    const response = await request(app)
      .get('/movie/1/recommendations?includeCollectionIds=true')
      .set('x-test-user', 'yes');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.results[0].collectionMembership, {
      kind: 'unresolved',
    });
  });

  it('retains the existing authentication gate before enrichment', async () => {
    stubPage();
    const resolve = mock.method(
      movieCollectionMembership,
      'resolve',
      async () => {
        throw new Error('must not run');
      }
    );
    const response = await request(app).get(
      '/movie/1/recommendations?includeCollectionIds=true'
    );
    assert.equal(response.status, 403);
    assert.equal(resolve.mock.callCount(), 0);
  });
});
