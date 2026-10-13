import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LibraryQuery } from '@server/lib/library';
import { isAuthenticated } from '@server/middleware/auth';
import { createLeavingSoonRouter } from '@server/routes/leavingSoon';
import express from 'express';
import request from 'supertest';

const app = express();
app.use((req, _res, next) => {
  if (req.header('x-authenticated')) {
    req.user = {
      id: 1,
      hasPermission: () => true,
    } as unknown as Express.Request['user'];
  }
  next();
});
let receivedQuery: LibraryQuery | undefined;
app.use(
  '/leaving-soon',
  isAuthenticated(),
  createLeavingSoonRouter({
    query: async (query) => {
      receivedQuery = query;
      return {
        pageInfo: { pages: 1, page: 1, results: 1, pageSize: 20 },
        users: [],
        storageLocations: [],
        sourceStatus: {
          library: 'current',
          currentViewing: 'current',
          historicalViewing: 'current',
          historicalImport: {
            state: 'accepted',
            observedRange: null,
            contentHash: null,
          },
        },
        results: [
          {
            canonicalMediaId: 42,
            tmdbId: 550,
            mediaType: 'movie',
            libraryState: 'current',
            title: 'Leaving Movie',
            year: 1999,
            posterPath: '/poster.jpg',
            backdropPath: '/backdrop.jpg',
            addedAt: '2026-01-01T00:00:00.000Z',
            removedAt: null,
            removalSource: null,
            logicalSizeBytes: '100',
            resolution: null,
            watchlistUsers: [{ id: 9, displayName: 'Private', avatar: null }],
            watchedUsers: [],
            watchedUserCount: 0,
            hasWatchedDetail: false,
            lastActiveAt: null,
            lastActiveUsers: [],
            requesters: [],
            storageRoots: [],
            fresh: false,
            seasonSummaries: [],
            externalLinks: [],
            tmdbRating: null,
            collection: null,
            removalSchedules: [
              {
                id: 7,
                canonicalMediaId: 42,
                targetType: 'movie',
                seasonNumber: null,
                origin: 'manual',
                status: 'active',
                scheduledAt: '2026-10-01T00:00:00.000Z',
                removeAt: '2026-10-15T00:00:00.000Z',
                revision: 1,
              },
            ],
          },
        ],
      };
    },
  })
);

describe('Leaving Soon ordinary-user API', () => {
  it('requires authentication but not administrator permission', async () => {
    assert.equal((await request(app).get('/leaving-soon')).status, 403);
    assert.equal(
      (
        await request(app)
          .get('/leaving-soon?page=1')
          .set('x-authenticated', 'yes')
      ).status,
      200
    );
  });

  it('forces current scheduled pagination and omits private Library facts', async () => {
    const response = await request(app)
      .get('/leaving-soon?page=1')
      .set('x-authenticated', 'yes');
    assert.deepEqual(
      {
        take: receivedQuery?.take,
        skip: receivedQuery?.skip,
        scope: receivedQuery?.scope,
        scheduled: receivedQuery?.scheduled,
      },
      { take: 20, skip: 0, scope: 'current', scheduled: 'yes' }
    );
    assert.equal(response.body.results[0].title, 'Leaving Movie');
    assert.equal(response.body.results[0].schedules.length, 1);
    assert.equal('watchlistUsers' in response.body.results[0], false);
    assert.equal('watchedUsers' in response.body.results[0], false);
    assert.equal('sourceScope' in response.body.results[0].schedules[0], false);
  });
});
