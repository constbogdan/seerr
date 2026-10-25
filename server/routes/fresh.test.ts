import { MediaStatus, MediaType } from '@server/constants/media';
import FreshDiscovery from '@server/entity/FreshDiscovery';
import Media from '@server/entity/Media';
import { freshSourceKey } from '@server/lib/fresh/engine';
import {
  freshPresentationKey,
  type FreshProviderPresentation,
  type resolveFreshPagePresentation,
} from '@server/lib/fresh/presentation';
import freshService from '@server/lib/fresh/service';
import type { FreshStatus } from '@server/lib/fresh/types';
import { Permission } from '@server/lib/permissions';
import type { FreshSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import { createFreshRoutes } from '@server/routes/fresh';
import freshSettingsRoutes, {
  mergeFreshSettingsUpdate,
} from '@server/routes/settings/fresh';
import {
  createFixtureDatabase,
  fixtureSettings,
} from '@server/test/freshFixtures';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';
import type { DataSource } from 'typeorm';

describe('Fresh V2 API contract', () => {
  let database: DataSource;
  const status: FreshStatus = {
    status: 'ready',
    refreshing: false,
    backfillComplete: true,
    itemCount: 0,
    pendingWork: 0,
  };
  let configured: FreshSettings;
  let referenceNow: number;
  let presentation: typeof resolveFreshPagePresentation;
  const currentSettings = () => configured;
  const app = () => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      const role = req.header('x-test-role');
      if (role)
        req.user = {
          id: 1,
          hasPermission: (permission: Permission) =>
            role === 'admin' || permission === 0,
        } as Express.Request['user'];
      next();
    });
    server.use(
      OpenApiValidator.middleware({
        apiSpec: path.join(process.cwd(), 'seerr-api.yml'),
        validateRequests: true,
        validateResponses: true,
        validateSecurity: false,
        ignoreUndocumented: true,
      })
    );
    // Match Seerr's own Date-to-JSON adapter installed after the validator.
    server.use((_req, res, next) => {
      const json = res.json;
      res.json = function serialize(value) {
        return json.call(this, JSON.parse(JSON.stringify(value)));
      };
      next();
    });
    server.use(
      '/api/v1/fresh',
      isAuthenticated(),
      createFreshRoutes({
        database,
        settings: currentSettings,
        status: async () => status,
        presentation: (...args) => presentation(...args),
        related: async (_user, identities, options) => {
          assert.equal(options?.includeActiveRequest, true);
          return identities
            .filter(
              (identity) =>
                identity.tmdbId === 1 && identity.mediaType === 'movie'
            )
            .map(
              () =>
                new Media({
                  id: 9,
                  tmdbId: 1,
                  mediaType: MediaType.MOVIE,
                  status: MediaStatus.AVAILABLE,
                  status4k: MediaStatus.UNKNOWN,
                  requests: [],
                  issues: [],
                  seasons: [],
                  createdAt: new Date(referenceNow),
                  updatedAt: new Date(referenceNow),
                })
            );
        },
      })
    );
    server.use(
      '/api/v1/settings/fresh',
      isAuthenticated(Permission.ADMIN),
      freshSettingsRoutes
    );
    server.use(
      (
        error: { status?: number; message?: string },
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => {
        void next;
        return res.status(error.status ?? 500).json({ message: error.message });
      }
    );
    return server;
  };
  const add = (
    tmdbId: number,
    mediaType: 'movie' | 'tv' = 'movie',
    ageDays = 1,
    eventKey = mediaType === 'movie' ? 'movie' : 'series'
  ) =>
    database.getRepository(FreshDiscovery).save(
      new FreshDiscovery({
        sourceKey: freshSourceKey(fixtureSettings),
        mediaType,
        tmdbId,
        eventKey,
        title: mediaType === 'movie' ? 'Movie ' + tmdbId : 'Series ' + tmdbId,
        discoveredAt: new Date(referenceNow - ageDays * 86400000),
        visibleUntil: new Date(referenceNow + (7 - ageDays) * 86400000),
      })
    );
  beforeEach(async () => {
    database = await createFixtureDatabase();
    referenceNow = Date.now();
    configured = { ...fixtureSettings };
    presentation = async () => new Map();
  });
  afterEach(async () => {
    mock.restoreAll();
    await database.destroy();
  });

  it('enforces authentication and admin settings authorization', async () => {
    const unauthenticated = await request(app()).get('/api/v1/fresh');
    assert.equal(
      unauthenticated.status,
      403,
      JSON.stringify(unauthenticated.body)
    );
    const unauthorized = await request(app())
      .get('/api/v1/settings/fresh')
      .set('x-test-role', 'user');
    assert.equal(unauthorized.status, 403, JSON.stringify(unauthorized.body));
  });
  it('retains administrator-only read-only status retrieval and truthful unavailable responses', async () => {
    const statusRead = mock.method(freshService, 'status', async () => status);
    mock.method(freshService, 'sync', () =>
      assert.fail('status must not synchronize')
    );
    mock.method(freshService, 'filters', () =>
      assert.fail('status must not refresh connection/filter data')
    );
    mock.method(freshService, 'configure', () =>
      assert.fail('status must not change configuration')
    );
    const server = app();
    for (const role of [undefined, 'user']) {
      const call = request(server).get('/api/v1/settings/fresh/status');
      if (role) call.set('x-test-role', role);
      assert.equal((await call).status, 403);
    }
    assert.equal(statusRead.mock.calls.length, 0);
    const response = await request(server)
      .get('/api/v1/settings/fresh/status')
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, status);
    assert.equal(statusRead.mock.calls.length, 1);
    statusRead.mock.mockImplementation(async () => {
      throw new Error('fixture database unavailable');
    });
    const failed = await request(server)
      .get('/api/v1/settings/fresh/status')
      .set('x-test-role', 'admin');
    assert.equal(failed.status, 503);
    assert.equal(failed.body.message, 'Fresh status temporarily unavailable.');
  });
  it('returns native typed media, availability and fallback titles through OpenAPI response validation', async () => {
    await add(1);
    const response = await request(app())
      .get('/api/v1/fresh')
      .set('x-test-role', 'user');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.totalResults, 1);
    assert.equal(response.body.results[0].title, 'Movie 1');
    assert.equal(
      response.body.results[0].mediaInfo.status,
      MediaStatus.AVAILABLE
    );
    assert.ok(response.body.results[0].freshFirstSeenAt);
  });
  it('deduplicates Series events before totals and pagination and preserves deterministic directions', async () => {
    await add(201, 'tv', 5);
    await add(201, 'tv', 1, 'season:2');
    for (let id = 1; id <= 21; id++) await add(id, 'movie', 2);
    await add(99, 'movie', 30);
    const first = await request(app())
      .get('/api/v1/fresh?page=1')
      .set('x-test-role', 'user');
    const second = await request(app())
      .get('/api/v1/fresh?page=2')
      .set('x-test-role', 'user');
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.totalResults, 22);
    assert.equal(first.body.results[0].id, 201);
    assert.equal(first.body.results.length, 20);
    assert.equal(second.body.results.length, 2);
    assert.equal(
      new Set(
        [...first.body.results, ...second.body.results].map(
          (item: { id: number; mediaType: string }) =>
            item.mediaType + ':' + item.id
        )
      ).size,
      22
    );
    const oldest = await request(app())
      .get('/api/v1/fresh?sort=oldest&mediaType=tv')
      .set('x-test-role', 'user');
    assert.equal(oldest.body.totalResults, 1);
    assert.equal(oldest.body.results[0].id, 201);
  });
  it('does not expose the token or legacy administration and rejects obsolete settings', async () => {
    const response = await request(app())
      .get('/api/v1/settings/fresh')
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.apiToken, undefined);
    assert.equal(response.body.mediaEligibilityDays, undefined);
    assert.throws(() =>
      mergeFreshSettingsUpdate(fixtureSettings, {
        ...fixtureSettings,
        mediaEligibilityDays: 90,
      })
    );
    const { apiToken, ...withoutToken } = fixtureSettings;
    assert.equal(apiToken, 'fixture-token');
    assert.equal(
      mergeFreshSettingsUpdate(fixtureSettings, {
        ...fixtureSettings,
        apiToken: '',
      }).apiToken,
      'fixture-token'
    );
    assert.equal(
      mergeFreshSettingsUpdate(fixtureSettings, withoutToken).apiToken,
      'fixture-token'
    );
    for (const route of ['candidates', 'diagnostics', 'rebuild', 'refresh']) {
      const res = await request(app())
        .get('/api/v1/settings/fresh/' + route)
        .set('x-test-role', 'admin');
      assert.equal(res.status, 404);
    }
  });
  it('filters the full Movie/Series population before totals and pagination without writing discoveries or clocks', async () => {
    for (let id = 1; id <= 45; id++) await add(id, 'movie', id <= 5 ? 1 : 2);
    await add(1, 'tv', 3);
    await add(1, 'tv', 4, 'season:2');
    await add(99, 'movie', 80);
    const before = await database
      .getRepository(FreshDiscovery)
      .find({ order: { id: 'ASC' } });
    let metadataCalls = 0;
    presentation = async (rows) => {
      metadataCalls++;
      assert.ok(rows.length <= 20);
      return new Map(
        rows.map((row) => [
          freshPresentationKey(row),
          {
            id: row.tmdbId,
            genres: [
              {
                id: row.tmdbId <= 5 && row.mediaType === 'movie' ? 16 : 18,
                name: 'Genre',
              },
            ],
            original_language: row.tmdbId === 6 ? 'hi' : 'en',
            vote_average: 7,
            vote_count: row.tmdbId === 7 ? 99 : 100,
          } as FreshProviderPresentation,
        ])
      );
    };
    configured = {
      ...configured,
      excludeGenreIds: [16],
      excludeOriginalLanguages: ['hi'],
      minimumTmdbScore: 7,
      minimumTmdbVotes: 100,
    };
    const server = app();
    const get = (query = '') =>
      request(server)
        .get('/api/v1/fresh' + query)
        .set('x-test-role', 'user');
    const first = await get();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.totalResults, 39);
    assert.equal(first.body.totalPages, 2);
    assert.equal(first.body.results.length, 20);
    assert.equal(first.body.results[0].id, 8);
    const second = await get('?page=2');
    assert.equal(second.body.results.length, 19);
    assert.equal(second.body.results.at(-1).mediaType, 'tv');
    assert.equal(metadataCalls, 3, 'pagination reuses the complete snapshot');
    assert.equal(
      new Set(
        [...first.body.results, ...second.body.results].map(
          (row) => row.mediaType + ':' + row.id
        )
      ).size,
      39
    );
    const oldest = await get('?sort=oldest');
    assert.equal(oldest.body.results[0].mediaType, 'tv');
    const tv = await get('?mediaType=tv');
    assert.equal(tv.body.totalResults, 1);
    assert.equal(tv.body.results[0].id, 1);
    configured = { ...fixtureSettings, minimumTmdbScore: 7 };
    const relaxed = await get();
    assert.equal(relaxed.body.totalResults, 46);
    assert.equal(
      relaxed.body.results[0].mediaInfo.status,
      MediaStatus.AVAILABLE
    );
    configured.freshVisibilityDays = 90;
    assert.equal(
      (await get()).body.totalResults,
      47,
      'expired discoveries can reappear without backfill'
    );
    assert.deepEqual(
      await database
        .getRepository(FreshDiscovery)
        .find({ order: { id: 'ASC' } }),
      before
    );
    assert.deepEqual(await database.query('SELECT * FROM fresh_work'), []);
    assert.deepEqual(
      await database.query('SELECT * FROM fresh_source_state'),
      []
    );
  });
  it('returns unavailable instead of partial filtered totals when metadata is incomplete', async () => {
    await add(1);
    configured.minimumTmdbScore = 7;
    const response = await request(app())
      .get('/api/v1/fresh')
      .set('x-test-role', 'user');
    assert.equal(response.status, 503);
    assert.equal(response.body.totalResults, undefined);
  });
  it('sorts complete metadata by rating/votes, known values first, with First Seen and typed identity ties', async () => {
    const metrics = new Map<string, Partial<FreshProviderPresentation>>([
      ['movie:1', { vote_average: 8, vote_count: 100 }],
      ['movie:2', { vote_average: 8, vote_count: 100 }],
      ['movie:3', { vote_average: 8, vote_count: 100 }],
      ['tv:2', { vote_average: 8, vote_count: 100 }],
      ['movie:4', { vote_average: 9, vote_count: 10 }],
      ['movie:5', { vote_average: 7, vote_count: 1000 }],
      ['movie:6', { vote_average: 0, vote_count: 0 }],
      ['movie:7', {}],
      ['movie:8', { vote_average: -1, vote_count: -1 }],
      ['movie:9', { vote_average: 11, vote_count: 1.5 }],
    ]);
    await add(1, 'movie', 3);
    for (let id = 2; id <= 9; id++)
      await add(id, 'movie', id === 4 || id === 5 ? 2 : 1);
    await add(2, 'tv', 1);
    const before = await database
      .getRepository(FreshDiscovery)
      .find({ order: { id: 'ASC' } });
    let calls = 0;
    presentation = async (rows) => {
      calls++;
      return new Map(
        rows.map((row) => [
          freshPresentationKey(row),
          {
            id: row.tmdbId,
            genres: [{ id: row.tmdbId === 4 ? 16 : 18, name: 'Genre' }],
            original_language: row.tmdbId === 5 ? 'hi' : 'en',
            ...metrics.get(freshPresentationKey(row)),
          } as FreshProviderPresentation,
        ])
      );
    };
    const server = app();
    const get = async (sort: string) => {
      const response = await request(server)
        .get('/api/v1/fresh?sort=' + sort)
        .set('x-test-role', 'user');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    };
    const ids = (body: { results: { mediaType: string; id: number }[] }) =>
      body.results.map((row) => `${row.mediaType}:${row.id}`);
    assert.deepEqual(ids(await get('vote_average')), [
      'movie:4',
      'movie:2',
      'movie:3',
      'tv:2',
      'movie:1',
      'movie:5',
      'movie:6',
      'movie:7',
      'movie:8',
      'movie:9',
    ]);
    assert.deepEqual(ids(await get('vote_count')), [
      'movie:5',
      'movie:2',
      'movie:3',
      'tv:2',
      'movie:1',
      'movie:4',
      'movie:6',
      'movie:7',
      'movie:8',
      'movie:9',
    ]);
    assert.equal(calls, 1, 'both sort modes reuse the same complete snapshot');
    configured = {
      ...configured,
      excludeGenreIds: [16],
      excludeOriginalLanguages: ['hi'],
      minimumTmdbScore: 7,
    };
    for (const sort of ['vote_average', 'vote_count']) {
      const filtered = await get(sort);
      assert.equal(filtered.totalResults, 4);
      assert.deepEqual(ids(filtered), [
        'movie:2',
        'movie:3',
        'tv:2',
        'movie:1',
      ]);
    }
    assert.equal(
      calls,
      2,
      'changed filters invalidate the snapshot, not each sort'
    );
    assert.deepEqual(
      await database
        .getRepository(FreshDiscovery)
        .find({ order: { id: 'ASC' } }),
      before
    );
    await add(10, 'movie', 1);
    metrics.set('movie:10', { vote_average: 10, vote_count: 9999 });
    assert.equal((await get('vote_count')).results[0].id, 10);
    assert.equal(
      calls,
      3,
      'discovery generation invalidates metadata ordering'
    );
  });
  it('filters and metric-sorts before pagination with accurate totals, unique pages and Movie/Series selection', async () => {
    for (let id = 1; id <= 45; id++) await add(id);
    await add(101, 'tv', 2);
    await add(101, 'tv', 3, 'season:2');
    await add(999, 'movie', 80);
    configured.excludeGenreIds = [16];
    let calls = 0;
    presentation = async (rows) => {
      calls++;
      assert.ok(rows.length <= 20);
      return new Map(
        rows.map((row) => [
          freshPresentationKey(row),
          {
            id: row.tmdbId,
            genres: [{ id: row.tmdbId <= 5 ? 16 : 18, name: 'Genre' }],
            original_language: 'en',
            vote_average:
              row.mediaType === 'tv'
                ? 8
                : row.tmdbId > 40
                  ? 9
                  : row.tmdbId > 20
                    ? 5
                    : 1,
            vote_count: row.tmdbId * 100,
          } as FreshProviderPresentation,
        ])
      );
    };
    const before = await database
      .getRepository(FreshDiscovery)
      .find({ order: { id: 'ASC' } });
    const server = app();
    const get = async (query: string) => {
      const response = await request(server)
        .get('/api/v1/fresh?' + query)
        .set('x-test-role', 'user');
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    };
    for (const sort of ['vote_average', 'vote_count']) {
      const pages = [];
      for (let page = 1; page <= 3; page++) {
        const body = await get(`sort=${sort}&page=${page}`);
        assert.equal(body.totalResults, 41);
        assert.equal(body.totalPages, 3);
        assert.equal(body.results.length, page === 3 ? 1 : 20);
        pages.push(...body.results);
      }
      assert.equal(
        new Set(pages.map((row) => `${row.mediaType}:${row.id}`)).size,
        41
      );
      const expected =
        sort === 'vote_average'
          ? [
              41,
              42,
              43,
              44,
              45,
              101,
              ...Array.from({ length: 20 }, (_, i) => i + 21),
              ...Array.from({ length: 15 }, (_, i) => i + 6),
            ]
          : [101, ...Array.from({ length: 40 }, (_, i) => 45 - i)];
      assert.deepEqual(
        pages.map((row) => row.id),
        expected
      );
    }
    assert.equal(calls, 3, 'no selected-page or sort-specific metadata sweep');
    const defaults = await get('');
    assert.deepEqual(
      defaults.results.map((row: { id: number }) => row.id),
      Array.from({ length: 20 }, (_, i) => i + 6)
    );
    assert.equal(calls, 3, 'First Seen filtering shares the same snapshot');
    const movie = await get('sort=vote_count&mediaType=movie');
    assert.equal(movie.totalResults, 40);
    assert.equal(movie.results[0].id, 45);
    const tv = await get('sort=vote_average&mediaType=tv');
    assert.equal(tv.totalResults, 1);
    assert.equal(tv.results[0].id, 101);
    assert.deepEqual(
      await database
        .getRepository(FreshDiscovery)
        .find({ order: { id: 'ASC' } }),
      before
    );
    assert.deepEqual(await database.query('SELECT * FROM fresh_work'), []);
    assert.deepEqual(
      await database.query('SELECT * FROM fresh_source_state'),
      []
    );
  });
  it('does not apply metadata sorting to the default feed and fails closed for unavailable metric snapshots', async () => {
    await add(1);
    await add(2, 'tv', 2);
    let calls = 0;
    presentation = async () => {
      calls++;
      return new Map();
    };
    const server = app();
    const get = (sort = '') =>
      request(server)
        .get('/api/v1/fresh' + (sort ? '?sort=' + sort : ''))
        .set('x-test-role', 'user');
    const defaults = await get();
    const explicit = await get('freshest');
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.body, explicit.body);
    for (const sort of ['vote_average', 'vote_count']) {
      assert.equal((await get(sort)).status, 503);
      presentation = async () => {
        calls++;
        throw new Error('fixture provider unavailable');
      };
      const failed = await get(sort);
      assert.equal(failed.status, 503);
      assert.equal(failed.body.totalResults, undefined);
      presentation = async () => {
        calls++;
        return new Map();
      };
    }
    assert.ok(calls >= 6);
    const invalid = await get('popularity');
    assert.equal(
      invalid.status,
      400,
      'OpenAPI validates the exact new sort contract'
    );
  });
  it('preserves the complete-evaluation population limit for metric sorts without content filters', async () => {
    let calls = 0;
    presentation = async () => {
      calls++;
      return new Map();
    };
    for (let offset = 0; offset < 5001; offset += 250) {
      await database.getRepository(FreshDiscovery).insert(
        Array.from({ length: Math.min(250, 5001 - offset) }, (_, i) => ({
          sourceKey: freshSourceKey(fixtureSettings),
          mediaType: 'movie' as const,
          tmdbId: offset + i + 1,
          eventKey: 'movie',
          title: 'Fixture',
          discoveredAt: new Date(referenceNow - 86400000),
          visibleUntil: new Date(referenceNow + 86400000),
        }))
      );
    }
    const server = app();
    for (const sort of ['vote_average', 'vote_count']) {
      const response = await request(server)
        .get('/api/v1/fresh?sort=' + sort)
        .set('x-test-role', 'user');
      assert.equal(response.status, 503);
    }
    assert.equal(
      calls,
      0,
      'oversized populations must fail before provider calls'
    );
  });
  it('validates content settings through the HTTP contract without configuring synchronization', async () => {
    for (const invalid of [
      { minimumTmdbScore: -1 },
      { minimumTmdbScore: 11 },
      { minimumTmdbVotes: 1.5 },
      { minimumTmdbVotes: -1 },
      { excludeOriginalLanguages: ['Hindi'] },
      { excludeGenreIds: [-1] },
    ]) {
      const response = await request(app())
        .put('/api/v1/settings/fresh')
        .set('x-test-role', 'admin')
        .send({ ...fixtureSettings, ...invalid });
      assert.equal(response.status, 400, JSON.stringify(response.body));
    }
    const saved = {
      ...fixtureSettings,
      excludeGenreIds: [16],
      excludeOriginalLanguages: ['hi'],
      minimumTmdbScore: 7,
      minimumTmdbVotes: 0,
    };
    assert.deepEqual(mergeFreshSettingsUpdate(saved, fixtureSettings), saved);
  });
  it('restores in-memory settings when persistence fails without enabling the service', async () => {
    const settings = getSettings();
    const previous = { ...settings.fresh };
    mock.method(settings, 'save', async () => {
      throw new Error('fixture persistence failure');
    });
    const response = await request(app())
      .put('/api/v1/settings/fresh')
      .set('x-test-role', 'admin')
      .send(fixtureSettings);
    assert.equal(response.status, 400, JSON.stringify(response.body));
    assert.deepEqual(settings.fresh, previous);
  });
});
