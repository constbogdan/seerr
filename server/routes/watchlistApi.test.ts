import PlexTvAPI from '@server/api/plextv';
import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import { Permission } from '@server/lib/permissions';
import {
  getWatchlistForUser,
  parseWatchlistQuery,
} from '@server/lib/watchlist';
import {
  WATCHLIST_ARTWORK_CONCURRENCY,
  enrichWatchlistArtwork,
} from '@server/lib/watchlistArtwork';
import { watchlistMembershipQuery } from '@server/lib/watchlistMembership';
import { isAuthenticated } from '@server/middleware/auth';
import discoverRoutes from '@server/routes/discover';
import userRoutes from '@server/routes/user';
import watchlistRoutes from '@server/routes/watchlist';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';
import { SelectQueryBuilder } from 'typeorm';

setupTestDb();
const fixtures = new Map<string, Record<string, unknown>>();
const transportCalls: string[] = [];
let principals = new Map<number, User>();
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.header('x-test-user') !== 'anonymous') {
    const user = principals.get(Number(req.header('x-test-user') ?? 1));
    if (user)
      req.user = Object.assign(user, {
        hasPermission: (permission: Permission) =>
          permission === 0 ||
          req.header('x-test-role') === 'admin' ||
          (permission === Permission.WATCHLIST_VIEW &&
            req.header('x-test-role') === 'viewer'),
      });
  }
  next();
});
// Exercise the actual source-controlled contract, including query coercion.
app.use(
  OpenApiValidator.middleware({
    apiSpec: path.resolve('seerr-api.yml'),
    validateRequests: true,
    validateResponses: true,
    // Authentication is exercised by the real isAuthenticated middleware below;
    // the test principal replaces session/API-key credential resolution only.
    validateSecurity: false,
  })
);
app.use((_req, res, next) => {
  const json = res.json;
  // Match server/index.ts: serialize Date values before response validation.
  res.json = function (body) {
    return json.call(this, JSON.parse(JSON.stringify(body)));
  };
  next();
});
app.use('/api/v1/watchlist', isAuthenticated(), watchlistRoutes);
app.use('/api/v1/discover', isAuthenticated(), discoverRoutes);
app.use('/api/v1/user', isAuthenticated(), userRoutes);
app.use(
  (
    error: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    void next;
    res.status(error.status ?? 500).json({ message: error.message });
  }
);

beforeEach(async () => {
  fixtures.clear();
  transportCalls.length = 0;
  const owner = await getRepository(User).findOneByOrFail({ id: 1 });
  owner.plexToken = null;
  await getRepository(User).save(owner);
  await getRepository(User).update({ id: 2 }, { plexToken: null });
  principals = new Map(
    (await getRepository(User).find()).map((user) => [user.id, user])
  );
  mock.method(
    TheMovieDb.prototype as unknown as {
      get: (url: string) => Promise<unknown>;
    },
    'get',
    async (url: string) => {
      transportCalls.push(url);
      if (!fixtures.has(url)) throw new Error('fixture metadata unavailable');
      return fixtures.get(url);
    }
  );
});
afterEach(() => mock.restoreAll());

const add = async (
  mediaType = MediaType.MOVIE,
  tmdbId = 123,
  userId = 1,
  media?: Media
) =>
  getRepository(Watchlist).save(
    new Watchlist({
      mediaType,
      tmdbId,
      requestedBy: await getRepository(User).findOneByOrFail({ id: userId }),
      title: `Saved ${mediaType} ${tmdbId}`,
      genreIds: [18],
      media,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    })
  );
const membership = (items: string) =>
  request(app).get('/api/v1/watchlist/membership').query({ items });
const list = (query = '') =>
  request(app).get(
    `/api/v1/discover/watchlist?watched=all&libraryStatus=any${query}`
  );
const fixture = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  poster_path: `/${id}-poster.jpg`,
  backdrop_path: `/${id}-backdrop.jpg`,
  genres: [{ id: 18 }],
  external_ids: {},
  ...extra,
});

describe('Personal Watchlist batch membership', () => {
  it("returns typed present/absent outcomes, never another user's identical identity", async () => {
    await add(MediaType.MOVIE, 123, 1);
    await add(MediaType.TV, 123, 2);
    const response = await membership('movie:123,tv:123,movie:456');
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.deepEqual(response.body, {
      results: [
        { mediaType: 'movie', tmdbId: 123, onWatchlist: true },
        { mediaType: 'tv', tmdbId: 123, onWatchlist: false },
        { mediaType: 'movie', tmdbId: 456, onWatchlist: false },
      ],
    });
    assert.deepEqual(
      (await membership('movie:123,tv:123').set('x-test-user', '2')).body
        .results,
      [
        { mediaType: 'movie', tmdbId: 123, onWatchlist: false },
        { mediaType: 'tv', tmdbId: 123, onWatchlist: true },
      ]
    );
    assert.equal(transportCalls.length, 0);
  });

  it('deduplicates in input order and uses one parameterized owner-scoped query', async () => {
    await add();
    const queries = mock.method(dataSource.logger, 'logQuery', () => {});
    const response = await membership('tv:123,movie:123,tv:123');
    assert.equal(response.status, 200);
    assert.equal(response.body.results.length, 2);
    assert.equal(queries.mock.callCount(), 1);
    const [sql, parameters] = queries.mock.calls[0].arguments;
    assert.ok(sql);
    assert.match(sql, /"watchlist"\."requestedById" = (?:1|\?)/);
    assert.doesNotMatch(sql, /JOIN/);
    assert.deepEqual(parameters, [123]);
  });

  it('checks retained membership after Media deletion or unlinking', async () => {
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 123, mediaType: MediaType.MOVIE })
    );
    await add(MediaType.MOVIE, 123, 1, media);
    await getRepository(Media).delete(media.id);
    await add(MediaType.TV, 456);
    assert.deepEqual(
      (await membership('movie:123,tv:456')).body.results.map(
        (item: { onWatchlist: boolean }) => item.onWatchlist
      ),
      [true, true]
    );
  });

  it('accepts 100 identities and rejects overflow before deduplication', async () => {
    const items = Array.from(
      { length: 100 },
      (_, index) => `movie:${index + 1}`
    ).join(',');
    const response = await membership(items);
    assert.equal(response.status, 200);
    assert.equal(response.body.results.length, 100);
    assert.equal((await membership(`${items},tv:101`)).status, 400);
    assert.equal(
      (await membership(Array(101).fill('movie:1').join(','))).status,
      400
    );
    assert.equal((await membership('tv:9007199254740991')).status, 200);
  });

  it('rejects missing, malformed, repeated and unsafe query input', async () => {
    assert.equal(
      (await request(app).get('/api/v1/watchlist/membership')).status,
      400
    );
    for (const items of [
      '',
      'movie:0',
      'tv:-1',
      'show:1',
      'movie:1.5',
      'movie:1e3',
      'movie:01',
      'movie:9007199254740992',
      'movie:1,',
      'movie:1, tv:2',
      'movie:1 OR 1=1',
    ]) {
      assert.equal((await membership(items)).status, 400, items);
    }
    assert.equal(
      (
        await request(app).get(
          '/api/v1/watchlist/membership?items=movie:1&items=tv:2'
        )
      ).status,
      400
    );
    assert.equal(
      watchlistMembershipQuery.safeParse({ items: ['movie:1'] }).success,
      false
    );
  });

  it('requires authentication and never accepts an owner override, including for administrators', async () => {
    assert.equal(
      (await membership('movie:123').set('x-test-user', 'anonymous')).status,
      403
    );
    for (const override of ['owner=all', 'owner=2', 'userId=2']) {
      assert.equal(
        (
          await request(app)
            .get(`/api/v1/watchlist/membership?items=movie:123&${override}`)
            .set('x-test-role', 'admin')
        ).status,
        400
      );
    }
    assert.equal(
      watchlistMembershipQuery.safeParse({ items: 'movie:123', owner: '2' })
        .success,
      false
    );
  });

  it('returns an error rather than false absence if the database query fails', async () => {
    mock.method(SelectQueryBuilder.prototype, 'getRawMany', async () => {
      throw new Error('fixture database unavailable');
    });
    const response = await membership('movie:123');
    assert.equal(response.status, 500);
    assert.equal(response.body.results, undefined);
  });
});

describe('Opt-in Watchlist page artwork', () => {
  it('is disabled by default and for explicit false', async () => {
    await add();
    for (const query of ['', '&includeArtwork=false']) {
      const response = await list(query);
      assert.equal(response.status, 200);
      assert.equal('artwork' in response.body.results[0], false);
    }
    assert.equal(transportCalls.length, 0);
    assert.equal(
      parseWatchlistQuery({ includeArtwork: false }).includeArtwork,
      undefined
    );
  });

  it('maps public artwork for mixed Movie/TV pages without leaking metadata fields', async () => {
    await add();
    await add(MediaType.TV, 123);
    fixtures.set(
      '/movie/123',
      fixture(123, {
        user: { email: 'private@example.test' },
        requests: ['private'],
        watchState: 'private',
        release_date: '1999-03-31',
        first_air_date: '2020-01-01',
      })
    );
    fixtures.set(
      '/tv/123',
      fixture(123, {
        poster_path: '/tv.jpg',
        first_air_date: '2024-02-29',
        release_date: '2000-01-01',
      })
    );
    const baseline = await list();
    const response = await list('&includeArtwork=true');
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.results.map((item: { artwork: unknown }) => item.artwork),
      [
        {
          posterPath: '/123-poster.jpg',
          backdropPath: '/123-backdrop.jpg',
          releaseDate: '1999-03-31',
        },
        {
          posterPath: '/tv.jpg',
          backdropPath: '/123-backdrop.jpg',
          firstAirDate: '2024-02-29',
        },
      ]
    );
    const withoutArtwork = {
      ...response.body,
      results: response.body.results.map(
        ({ artwork: ignored, ...item }: { artwork: unknown }) => {
          void ignored;
          return item;
        }
      ),
    };
    assert.deepEqual(withoutArtwork, baseline.body);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /private@example|"requests":\["private"\]/
    );
    assert.deepEqual(transportCalls.sort(), ['/movie/123', '/tv/123']);
  });

  it('deduplicates repeated typed titles without changing authorized owner rows', async () => {
    await add();
    await add(MediaType.MOVIE, 123, 2);
    fixtures.set('/movie/123', fixture(123));
    const response = await list('&owner=all&includeArtwork=true').set(
      'x-test-role',
      'viewer'
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.totalResults, 2);
    assert.deepEqual(
      response.body.results.map(
        (item: { requestedBy: { id: number } }) => item.requestedBy.id
      ),
      [1, 2]
    );
    assert.equal(transportCalls.length, 1);
  });

  it('keeps pages, totals, dates and server-side filters unchanged', async () => {
    for (let id = 1; id <= 23; id++) {
      await add(MediaType.MOVIE, id);
      fixtures.set(`/movie/${id}`, fixture(id));
    }
    await add(MediaType.TV, 999);
    const plain = await list('&category=movies&sort=added_desc&page=2');
    const enriched = await list(
      '&category=movies&sort=added_desc&page=2&includeArtwork=true'
    );
    assert.equal(enriched.status, 200);
    assert.equal(enriched.body.totalResults, 23);
    assert.equal(enriched.body.totalPages, 2);
    assert.equal(enriched.body.results.length, 3);
    assert.deepEqual(
      enriched.body.results.map((item: { id: number; createdAt: string }) => [
        item.id,
        item.createdAt,
      ]),
      plain.body.results.map((item: { id: number; createdAt: string }) => [
        item.id,
        item.createdAt,
      ])
    );
    assert.equal(transportCalls.length, 3);
  });

  it('keeps the title-only row on provider failure, identity mismatch or missing images', async () => {
    await add();
    await add(MediaType.TV, 456);
    await add(MediaType.MOVIE, 789);
    fixtures.set('/tv/456', fixture(999));
    fixtures.set(
      '/movie/789',
      fixture(789, { poster_path: null, backdrop_path: null })
    );
    const response = await list('&includeArtwork=true');
    assert.equal(response.status, 200);
    assert.equal(response.body.results.length, 3);
    assert.ok(
      response.body.results.every((item: { title: string }) => item.title)
    );
    assert.deepEqual(
      response.body.results.map((item: { artwork: unknown }) => item.artwork),
      [null, { posterPath: null, backdropPath: null, releaseDate: null }, null]
    );
  });

  it('supports the existing personal user route without changing delegated access', async () => {
    await add();
    fixtures.set('/movie/123', fixture(123));
    const response = await request(app).get(
      '/api/v1/user/1/watchlist?watched=all&libraryStatus=any&category=movies&sort=added_desc&includeArtwork=true'
    );
    assert.equal(response.status, 200);
    assert.ok(response.body.results[0].artwork.posterPath);
    assert.equal(
      (await list('&owner=2').set('x-test-role', 'viewer')).status,
      200
    );
    assert.equal((await list('&owner=2')).status, 403);
  });

  it('preserves personal POST/DELETE and typed membership across an intent cycle', async () => {
    fixtures.set('/movie/123', fixture(123));
    const created = await request(app)
      .post('/api/v1/watchlist')
      .send({ tmdbId: 123, mediaType: 'movie', title: 'Saved title' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const duplicate = await request(app)
      .post('/api/v1/watchlist')
      .send({ tmdbId: '123', mediaType: 'movie', title: 'Saved title' });
    assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
    assert.equal(
      (
        await request(app)
          .delete('/api/v1/watchlist/123?mediaType=movie')
          .set('x-test-user', '2')
      ).status,
      404
    );
    assert.equal(
      (await membership('movie:123')).body.results[0].onWatchlist,
      true
    );
    assert.equal(
      (await request(app).delete('/api/v1/watchlist/123?mediaType=movie'))
        .status,
      204
    );
    assert.equal(
      (await membership('movie:123')).body.results[0].onWatchlist,
      false
    );
    assert.equal(await getRepository(Media).count(), 1);
  });

  it('leaves Plex selection, remote payload and unsupported filter flags unchanged', async () => {
    const plex = mock.method(PlexTvAPI.prototype, 'getWatchlist', async () => ({
      items: [],
      totalSize: 0,
      size: 0,
      offset: 0,
    }));
    const response = await getWatchlistForUser({
      user: { id: 1, plexToken: 'fixture-token' },
      query: parseWatchlistQuery({ includeArtwork: true }),
    });
    assert.equal(response.source, 'plex');
    assert.equal(response.supportsPresentation, false);
    assert.equal(response.supportsWatchState, false);
    assert.equal(plex.mock.callCount(), 1);
    assert.equal(transportCalls.length, 0);
  });
});

const artworkPage = (count: number): WatchlistResponse => ({
  page: 1,
  totalPages: 1,
  totalResults: count,
  source: 'local',
  supportsPresentation: true,
  supportsWatchState: true,
  supportsLibraryStatus: true,
  hasUnclassifiedItems: false,
  results: Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    tmdbId: index + 1,
    mediaType: 'movie',
    title: 'Fallback title',
    ratingKey: '',
  })),
});

describe('Artwork resource and projection boundaries', () => {
  it('keeps images and rows when dates are missing or invalid without additional lookups', async () => {
    const invalidDates = [
      undefined,
      null,
      '',
      '2023-02-29',
      '2024-02-30',
      '2024-13-01',
      '2024-01-01T00:00:00Z',
      '0000-01-01',
      2024,
    ];
    for (const mediaType of ['movie', 'tv'] as const) {
      for (const date of invalidDates) {
        let calls = 0;
        const page = artworkPage(1);
        page.results[0].mediaType = mediaType;
        const result = await enrichWatchlistArtwork(page, {
          getWatchlistArtwork: async () => {
            calls++;
            return fixture(1, {
              release_date: date,
              first_air_date: date,
            }) as never;
          },
        });
        assert.equal(calls, 1);
        assert.deepEqual(result.results[0].artwork, {
          posterPath: '/1-poster.jpg',
          backdropPath: '/1-backdrop.jpg',
          [mediaType === 'movie' ? 'releaseDate' : 'firstAirDate']: null,
        });
        assert.equal(result.totalResults, 1);
        assert.equal(result.results[0].title, page.results[0].title);
      }
    }
  });

  it('reuses the existing TMDB transport cache and passes its deadline signal', async () => {
    mock.restoreAll();
    const client = new TheMovieDb();
    const transport = client as unknown as {
      axios: {
        get: (
          url: string,
          options: { signal: AbortSignal }
        ) => Promise<unknown>;
      };
    };
    const http = mock.method(transport.axios, 'get', async () => ({
      data: fixture(918273),
    }));
    const controller = new AbortController();
    const first = await client.getWatchlistArtwork(
      'movie',
      918273,
      controller.signal
    );
    const second = await client.getWatchlistArtwork(
      'movie',
      918273,
      controller.signal
    );
    assert.deepEqual(first, second);
    assert.equal(http.mock.callCount(), 1);
    const [url, options] = http.mock.calls[0].arguments;
    assert.equal(url, '/movie/918273');
    assert.ok(options);
    assert.equal(options.signal, controller.signal);
  });

  it('bounds concurrency while completing a full page', async () => {
    let active = 0;
    let peak = 0;
    let calls = 0;
    const result = await enrichWatchlistArtwork(artworkPage(20), {
      getWatchlistArtwork: async (_type, id) => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        return fixture(id) as never;
      },
    });
    assert.equal(peak, WATCHLIST_ARTWORK_CONCURRENCY);
    assert.equal(calls, 20);
    assert.ok(result.results.every((item) => item.artwork?.posterPath));
  });

  it('returns at the page deadline, aborts work and never starts the remaining queue', async () => {
    const signals: AbortSignal[] = [];
    let finish: (value: never) => void = () => {};
    const hung = new Promise<never>((resolve) => {
      finish = resolve;
    });
    const result = await enrichWatchlistArtwork(
      artworkPage(20),
      {
        getWatchlistArtwork: async (_type, _id, signal) => {
          signals.push(signal);
          return hung;
        },
      },
      15
    );
    assert.equal(signals.length, WATCHLIST_ARTWORK_CONCURRENCY);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.ok(result.results.every((item) => item.artwork === null));
    finish(fixture(1) as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(signals.length, WATCHLIST_ARTWORK_CONCURRENCY);
    assert.ok(result.results.every((item) => item.artwork === null));
  });

  it('accepts only image paths and copies no provider-owned private fields', async () => {
    const result = await enrichWatchlistArtwork(artworkPage(1), {
      getWatchlistArtwork: async () =>
        fixture(1, {
          poster_path: 'https://credential.invalid/image',
          backdrop_path: '//credential.invalid/image',
          requestedBy: { email: 'private' },
        }) as never,
    });
    assert.deepEqual(result.results[0].artwork, {
      posterPath: null,
      backdropPath: null,
      releaseDate: null,
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      /credential|private|requestedBy/
    );
  });
});
