import type { LibraryService } from '@server/lib/library';
import {
  LibraryCollectionsService,
  type LibraryCollectionsDependencies,
} from '@server/lib/libraryCollections';
import { isAuthenticated } from '@server/middleware/auth';
import { createLibraryRouter } from '@server/routes/library';
import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

const queries: Parameters<LibraryCollectionsService['query']>[0][] = [];
const collectionsService: Pick<LibraryCollectionsService, 'query'> = {
  query: async (query) => {
    queries.push(query);
    return {
      pageInfo: { pages: 1, page: 1, results: 1, pageSize: query.take },
      results: [
        {
          id: 10,
          name: 'Test Collection',
          overview: null,
          posterPath: null,
          backdropPath: null,
          availableMovies: 1,
          totalMovies: 2,
          completeness: 'incomplete',
        },
      ],
      status: 'complete',
      stale: false,
      discoveredCollections: 1,
      failedCollections: 0,
      refreshedAt: '2026-10-21T00:00:00.000Z',
    };
  },
};

const unusedLibraryService: Pick<
  LibraryService,
  'query' | 'seriesDetail' | 'userAvailability'
> = {
  query: async () => {
    throw new Error('Unexpected Library query');
  },
  seriesDetail: async () => null,
  userAvailability: async () => ({ users: [] }),
};

const createApp = (
  service: Pick<LibraryCollectionsService, 'query'> = collectionsService
) => {
  const app = express();
  app.use((req, _res, next) => {
    const role = req.header('x-test-role');
    if (role) {
      req.user = {
        id: 1,
        hasPermission: () => role === 'admin',
      } as unknown as Express.Request['user'];
    }
    next();
  });
  app.use(
    '/library',
    isAuthenticated(),
    createLibraryRouter(
      unusedLibraryService,
      undefined,
      undefined,
      undefined,
      service
    )
  );
  app.use(
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
  return app;
};

const app = createApp();

describe('Library collections API', () => {
  it('requires administrator permission', async () => {
    const response = await request(app)
      .get('/library/collections')
      .set('x-test-role', 'user');
    assert.equal(response.status, 403);
  });

  it('validates and forwards collection pagination, filtering, and sorting', async () => {
    queries.length = 0;
    const response = await request(app)
      .get(
        '/library/collections?take=12&skip=24&completeness=incomplete&sort=available&sortDirection=desc'
      )
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].id, 10);
    assert.deepEqual(queries, [
      {
        take: 12,
        skip: 24,
        completeness: 'incomplete',
        sort: 'available',
        sortDirection: 'desc',
        locale: 'en',
      },
    ]);
  });

  it('returns exact completion-ratio ordering through the HTTP API', async () => {
    const members = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => start + index);
    const collections = new Map([
      [1, { id: 1, name: 'One Tenth', parts: members(101, 10) }],
      [2, { id: 2, name: 'Two Thirds', parts: members(201, 3) }],
      [3, { id: 3, name: 'Five Sixths', parts: members(301, 6) }],
      [4, { id: 4, name: 'Three Thirds', parts: members(401, 3) }],
      [5, { id: 5, name: 'Ten Twenty-Sevenths', parts: members(501, 27) }],
      [6, { id: 6, name: 'Unknown', parts: [] }],
    ]);
    const availableIds = new Set([
      ...members(101, 1),
      ...members(201, 2),
      ...members(301, 5),
      ...members(401, 3),
      ...members(501, 10),
    ]);
    const dependencies: Partial<LibraryCollectionsDependencies> = {
      discoverCollectionIds: async () => [...collections.keys()],
      fetchCollection: async (id) => {
        const value = collections.get(id)!;
        return {
          id: value.id,
          name: value.name,
          overview: '',
          poster_path: null,
          backdrop_path: null,
          parts: value.parts.map((memberId) => ({ id: memberId })),
        } as unknown as Awaited<
          ReturnType<LibraryCollectionsDependencies['fetchCollection']>
        >;
      },
      fetchAvailability: async (ids) =>
        new Map(ids.map((id) => [id, availableIds.has(id)])),
    };
    const sortingApp = createApp(new LibraryCollectionsService(dependencies));
    const getCollections = (sortDirection: 'asc' | 'desc') =>
      request(sortingApp)
        .get(
          `/library/collections?take=20&skip=0&sort=completeness&sortDirection=${sortDirection}`
        )
        .set('x-test-role', 'admin');

    const pending = await getCollections('asc');
    assert.equal(pending.status, 200);
    assert.equal(pending.body.status, 'pending');
    await new Promise<void>((resolve) => setImmediate(resolve));

    const ascending = await getCollections('asc');
    const descending = await getCollections('desc');
    assert.deepEqual(
      ascending.body.results.map(
        (item: {
          id: number;
          availableMovies: number;
          totalMovies: number;
        }) => [item.id, item.availableMovies, item.totalMovies]
      ),
      [
        [1, 1, 10],
        [5, 10, 27],
        [2, 2, 3],
        [3, 5, 6],
        [4, 3, 3],
        [6, null, null],
      ]
    );
    assert.deepEqual(
      descending.body.results.map((item: { id: number }) => item.id),
      [4, 3, 2, 5, 1, 6]
    );
  });
});
