import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { UserMediaState } from '@server/entity/UserMediaState';
import { Watchlist } from '@server/entity/Watchlist';
import { Permission } from '@server/lib/permissions';
import discoverRoutes from '@server/routes/discover';
import userRoutes from '@server/routes/user';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

setupTestDb();

const app = express();
let otherUserId: number;
app.use((req, _res, next) => {
  const role = req.header('x-test-role') ?? 'user';
  const id = Number(req.header('x-test-user') ?? 1);
  req.user = {
    id,
    hasPermission: (permission: Permission | Permission[]) => {
      const requested = Array.isArray(permission) ? permission : [permission];
      if (role === 'admin') return true;
      if (role === 'viewer') {
        return requested.includes(Permission.WATCHLIST_VIEW);
      }
      if (role === 'manager') {
        return requested.includes(Permission.MANAGE_REQUESTS);
      }
      return permission === 0;
    },
  } as Express.Request['user'];
  next();
});
app.use('/discover', discoverRoutes);
app.use('/user', userRoutes);
app.use(
  (
    error: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    void _next;
    return res.status(error.status ?? 500).json({ message: error.message });
  }
);

describe('Watchlist privacy and admin scopes', () => {
  beforeEach(async () => {
    const owner = await getRepository(User).findOneByOrFail({ id: 1 });
    owner.plexToken = null;
    await getRepository(User).save(owner);
    const other = await getRepository(User).save(
      new User({ email: 'privacy-other@example.test', avatar: '' })
    );
    otherUserId = other.id;
    const media = await getRepository(Media).save(
      new Media({ tmdbId: 7001, mediaType: MediaType.MOVIE })
    );
    await getRepository(Watchlist).save(
      new Watchlist({
        ratingKey: '',
        tmdbId: 7001,
        mediaType: MediaType.MOVIE,
        title: 'Private Watchlist Item',
        requestedBy: owner,
        media,
      })
    );
    await getRepository(UserMediaState).save(
      new UserMediaState({
        user: owner,
        mediaType: MediaType.MOVIE,
        tmdbId: 7001,
        media,
        jellyfinPlayed: true,
      })
    );
    const otherMedia = await getRepository(Media).save(
      new Media({ tmdbId: 7002, mediaType: MediaType.TV })
    );
    await getRepository(Watchlist).save(
      new Watchlist({
        ratingKey: '',
        tmdbId: 7002,
        mediaType: MediaType.TV,
        title: 'Other User Item',
        requestedBy: other,
        media: otherMedia,
      })
    );
  });

  it('allows owner access but rejects MANAGE_REQUESTS-only cross-user access', async () => {
    assert.equal(
      (
        await request(app)
          .get('/user/1/watchlist?watched=all')
          .set('x-test-user', '1')
      ).status,
      200
    );
    assert.equal(
      (
        await request(app)
          .get('/user/1/watchlist?watched=all')
          .set('x-test-user', '2')
          .set('x-test-role', 'manager')
      ).status,
      403
    );
  });

  it('allows WATCHLIST_VIEW and admin scopes without exposing full users', async () => {
    const single = await request(app)
      .get('/user/1/watchlist?watched=all')
      .set('x-test-user', '2')
      .set('x-test-role', 'viewer');
    assert.equal(single.status, 200);
    assert.equal(single.body.results[0].requestedBy.id, 1);
    assert.equal(single.body.results[0].requestedBy.email, undefined);

    const all = await request(app)
      .get('/discover/watchlist?owner=all&watched=all')
      .set('x-test-role', 'admin');
    assert.equal(all.status, 200);
    assert.equal(all.body.totalResults, 2);
    assert.deepEqual(
      new Set(
        all.body.results.map(
          (row: { requestedBy: { id: number } }) => row.requestedBy.id
        )
      ),
      new Set([1, otherUserId])
    );

    const specific = await request(app)
      .get(`/discover/watchlist?owner=${otherUserId}&watched=all`)
      .set('x-test-role', 'viewer');
    assert.equal(specific.status, 200);
    assert.equal(specific.body.totalResults, 1);
    assert.equal(specific.body.results[0].requestedBy.id, otherUserId);
  });

  it('rejects ordinary All Users and specific-other scopes', async () => {
    assert.equal(
      (
        await request(app)
          .get('/discover/watchlist?owner=all&watched=all')
          .set('x-test-user', '2')
      ).status,
      403
    );
    assert.equal(
      (
        await request(app)
          .get('/discover/watchlist?owner=1&watched=all')
          .set('x-test-user', '2')
      ).status,
      403
    );
  });

  it('excludes accounts explicitly omitted from user metrics scopes', async () => {
    const service = await getRepository(User).findOneByOrFail({
      id: otherUserId,
    });
    service.includeInUserMetrics = false;
    await getRepository(User).save(service);

    const all = await request(app)
      .get('/discover/watchlist?owner=all&watched=all')
      .set('x-test-role', 'admin');
    assert.equal(all.status, 200);
    assert.equal(all.body.totalResults, 1);
    assert.equal(all.body.results[0].requestedBy.id, 1);

    const specific = await request(app)
      .get(`/discover/watchlist?owner=${otherUserId}&watched=all`)
      .set('x-test-role', 'admin');
    assert.equal(specific.status, 400);
  });
});
