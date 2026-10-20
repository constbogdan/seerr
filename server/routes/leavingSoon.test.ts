import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  LibraryPresentationStatus,
  LibraryResultsResponse,
} from '@server/interfaces/api/libraryInterfaces';
import type { LibraryQuery } from '@server/lib/library';
import { isAuthenticated } from '@server/middleware/auth';
import { createLeavingSoonRouter } from '@server/routes/leavingSoon';
import express from 'express';
import request from 'supertest';

const app = express();
app.use((req, _res, next) => {
  if (req.header('x-authenticated')) {
    req.user = {
      id: Number(req.header('x-user-id') ?? 1),
      hasPermission: () => true,
    } as unknown as Express.Request['user'];
  }
  next();
});
let receivedQuery: LibraryQuery | undefined;
const batchId = '11111111-1111-4111-8111-111111111111';
const unrelatedBatchId = '22222222-2222-4222-8222-222222222222';
const presentationGrants = new Map<string, Set<number>>();
app.use(
  '/leaving-soon',
  isAuthenticated(),
  createLeavingSoonRouter(
    {
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
              posterPath: null,
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
          presentation: {
            state: 'pending',
            batchId,
            revision: 1,
            pendingCount: 1,
          },
        };
      },
    },
    {
      grantStatusAccess: (requestedBatchId, userId) => {
        const users =
          presentationGrants.get(requestedBatchId) ?? new Set<number>();
        users.add(userId);
        presentationGrants.set(requestedBatchId, users);
        return true;
      },
      statusFor: (requestedBatchId, userId) =>
        presentationGrants.get(requestedBatchId)?.has(userId)
          ? {
              state: 'pending',
              revision: 1,
              pendingCount: 1,
            }
          : null,
    }
  )
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
    assert.equal(response.body.results[0].posterPath, null);
    assert.equal(response.body.results[0].schedules.length, 1);
    assert.equal(response.body.presentation.state, 'pending');
    assert.equal(response.body.presentation.batchId, batchId);
    assert.equal('watchlistUsers' in response.body.results[0], false);
    assert.equal('watchedUsers' in response.body.results[0], false);
    assert.equal('sourceScope' in response.body.results[0].schedules[0], false);
  });

  it('scopes presentation status to the authenticated user who received the batch', async () => {
    await request(app)
      .get('/leaving-soon?page=1')
      .set('x-authenticated', 'yes')
      .set('x-user-id', '1');

    const allowed = await request(app)
      .get(`/leaving-soon/presentation-status/${batchId}`)
      .set('x-authenticated', 'yes')
      .set('x-user-id', '1');
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.state, 'pending');
    assert.equal(
      (
        await request(app)
          .get(`/leaving-soon/presentation-status/${batchId}`)
          .set('x-authenticated', 'yes')
          .set('x-user-id', '2')
      ).status,
      404
    );
    assert.equal(
      (
        await request(app)
          .get(`/leaving-soon/presentation-status/${unrelatedBatchId}`)
          .set('x-authenticated', 'yes')
          .set('x-user-id', '1')
      ).status,
      404
    );
    assert.equal(
      (
        await request(app)
          .get('/leaving-soon/presentation-status/not-a-uuid')
          .set('x-authenticated', 'yes')
          .set('x-user-id', '1')
      ).status,
      400
    );
  });

  it('returns warm artwork without granting a settled presentation batch', async () => {
    const warmApp = express();
    let grantCount = 0;
    warmApp.use((req, _res, next) => {
      if (req.header('x-authenticated')) {
        req.user = {
          id: 1,
          hasPermission: () => true,
        } as unknown as Express.Request['user'];
      }
      next();
    });
    const warmResponse = {
      pageInfo: { pages: 1, page: 1, results: 1, pageSize: 20 },
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
      presentation: {
        state: 'complete',
        revision: 2,
        pendingCount: 0,
      },
      results: [
        {
          canonicalMediaId: 42,
          tmdbId: 550,
          mediaType: 'movie',
          title: 'Leaving Movie',
          year: 1999,
          posterPath: '/poster.jpg',
          removalSchedules: [],
        },
      ],
    } as unknown as LibraryResultsResponse;
    warmApp.use(
      '/leaving-soon',
      isAuthenticated(),
      createLeavingSoonRouter(
        { query: async () => warmResponse },
        {
          grantStatusAccess: () => {
            grantCount += 1;
            return true;
          },
          statusFor: (): LibraryPresentationStatus | null => null,
        }
      )
    );

    const response = await request(warmApp)
      .get('/leaving-soon')
      .set('x-authenticated', 'yes');
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].posterPath, '/poster.jpg');
    assert.equal(response.body.presentation.state, 'complete');
    assert.equal(grantCount, 0);
  });
});
