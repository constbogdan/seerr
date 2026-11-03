import {
  safeWatchlistRouletteExternalUrl,
  default as watchlistRouletteRoutes,
  watchlistRouletteSettingsSchema,
} from '@server/routes/settings/watchlistRoulette';
import { setupTestDb } from '@server/test/db';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

setupTestDb();

const app = express();
app.use(express.json());
app.use('/settings/watchlist-roulette', watchlistRouletteRoutes);
app.use(
  (
    error: { status?: number; message?: string },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    void _next;
    return res
      .status(error.status ?? 500)
      .json({ message: error.message ?? 'Unexpected error.' });
  }
);

describe('Watchlist Roulette settings API validation', () => {
  it('accepts a nullable owner and bounded independent request counts', () => {
    assert.equal(
      watchlistRouletteSettingsSchema.safeParse({
        requestOwnerUserId: null,
        movieItemsPerRun: 3,
        seriesItemsPerRun: 1,
      }).success,
      true
    );
    assert.equal(
      watchlistRouletteSettingsSchema.safeParse({
        requestOwnerUserId: 1,
        movieItemsPerRun: 0,
        seriesItemsPerRun: 1,
      }).success,
      false
    );
  });

  it('allows only credential-free HTTP(S) Servarr links', () => {
    assert.equal(
      safeWatchlistRouletteExternalUrl(
        'https://radarr.example.test/base/movie/example'
      ),
      'https://radarr.example.test/base/movie/example'
    );
    assert.equal(safeWatchlistRouletteExternalUrl('javascript:alert(1)'), null);
    assert.equal(
      safeWatchlistRouletteExternalUrl(
        'https://user:secret@sonarr.example.test/series/example'
      ),
      null
    );
  });

  it('rejects a missing or non-administrator request owner', async () => {
    const response = await request(app)
      .post('/settings/watchlist-roulette')
      .send({
        requestOwnerUserId: 999999,
        movieItemsPerRun: 3,
        seriesItemsPerRun: 1,
      });
    assert.equal(response.status, 400);
    assert.match(response.body.message, /not a current administrator/);
  });

  it('persists an explicit administrator and bounded counts', async () => {
    const response = await request(app)
      .post('/settings/watchlist-roulette')
      .send({
        requestOwnerUserId: 1,
        movieItemsPerRun: 4,
        seriesItemsPerRun: 2,
      });
    assert.equal(response.status, 200);
    assert.deepEqual(
      {
        requestOwnerUserId: response.body.requestOwnerUserId,
        movieItemsPerRun: response.body.movieItemsPerRun,
        seriesItemsPerRun: response.body.seriesItemsPerRun,
      },
      { requestOwnerUserId: 1, movieItemsPerRun: 4, seriesItemsPerRun: 2 }
    );
  });
});
