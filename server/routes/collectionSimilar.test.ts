import TheMovieDb from '@server/api/themoviedb';
import Media from '@server/entity/Media';
import { similarCollections } from '@server/lib/similarCollections';
import { isAuthenticated } from '@server/middleware/auth';
import collectionRoutes from '@server/routes/collection';
import express from 'express';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import request from 'supertest';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.header('x-test-user'))
    req.user = {
      hasPermission: () => true,
    } as unknown as Express.Request['user'];
  next();
});
app.use('/collection', isAuthenticated(), collectionRoutes);
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

afterEach(() => mock.restoreAll());

describe('Similar Collections routes', () => {
  it('requires authentication to read persisted state', async () => {
    const read = mock.method(similarCollections, 'read', async () => ({
      relatedCollectionIds: [],
      completedSeedCount: 0,
      incompleteSeedCount: 0,
      discoveryActive: false,
    }));
    const response = await request(app).get('/collection/100/similar');
    assert.equal(response.status, 403);
    assert.equal(read.mock.callCount(), 0);
  });

  it('rejects invalid collection IDs before reading persistence', async () => {
    const read = mock.method(similarCollections, 'read', async () => ({
      relatedCollectionIds: [],
      completedSeedCount: 0,
      incompleteSeedCount: 0,
      discoveryActive: false,
    }));
    for (const id of ['0', '-1', '1.5', 'not-a-number', '9007199254740992']) {
      const response = await request(app)
        .get(`/collection/${id}/similar`)
        .set('x-test-user', 'yes');
      assert.equal(response.status, 400, id);
    }
    assert.equal(read.mock.callCount(), 0);
  });

  it('returns empty persisted state for a valid unvisited ID', async () => {
    const empty = {
      relatedCollectionIds: [],
      completedSeedCount: 0,
      incompleteSeedCount: 0,
      discoveryActive: false,
    };
    const read = mock.method(similarCollections, 'read', async () => empty);
    const response = await request(app)
      .get('/collection/100/similar')
      .set('x-test-user', 'yes');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, empty);
    assert.deepEqual(read.mock.calls[0].arguments, [100]);
  });

  it('returns persisted IDs in service order and active discovery without other work', async () => {
    const state = {
      relatedCollectionIds: [528, 5547],
      completedSeedCount: 2,
      incompleteSeedCount: 1,
      discoveryActive: true,
    };
    const read = mock.method(similarCollections, 'read', async () => state);
    const collection = mock.method(
      TheMovieDb.prototype,
      'getCollection',
      async () => {
        throw new Error('TMDB must not be called');
      }
    );
    const media = mock.method(Media, 'getRelatedMedia', async () => {
      throw new Error('Media mapping must not be called');
    });
    const trigger = mock.method(similarCollections, 'trigger', async () => {
      throw new Error('Discovery must not be triggered');
    });
    const response = await request(app)
      .get('/collection/100/similar')
      .set('x-test-user', 'yes');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, state);
    assert.equal(read.mock.callCount(), 1);
    assert.equal(collection.mock.callCount(), 0);
    assert.equal(media.mock.callCount(), 0);
    assert.equal(trigger.mock.callCount(), 0);
  });

  it('reports a sanitized failure instead of an empty successful read', async () => {
    mock.method(similarCollections, 'read', async () => {
      throw new Error('sensitive database connection details');
    });
    const response = await request(app)
      .get('/collection/100/similar')
      .set('x-test-user', 'yes');
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      message: 'Unable to read Similar Collections state.',
    });
  });

  it('requires authentication before starting discovery', async () => {
    const trigger = mock.method(similarCollections, 'trigger', async () => ({
      started: true,
    }));
    const response = await request(app)
      .post('/collection/100/similar')
      .send({ visitToken: '00000000-0000-4000-8000-000000000001' });
    assert.equal(response.status, 403);
    assert.equal(trigger.mock.callCount(), 0);
  });

  it('validates input and returns promptly with the claim result', async () => {
    const trigger = mock.method(similarCollections, 'trigger', async () => ({
      started: true,
    }));
    const invalid = await request(app)
      .post('/collection/0/similar')
      .set('x-test-user', 'yes')
      .send({ visitToken: 'invalid' });
    assert.equal(invalid.status, 400);
    assert.equal(trigger.mock.callCount(), 0);
    const response = await request(app)
      .post('/collection/100/similar')
      .set('x-test-user', 'yes')
      .send({ visitToken: '00000000-0000-4000-8000-000000000001' });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { started: true });
    assert.deepEqual(trigger.mock.calls[0].arguments, [
      100,
      '00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('keeps GET and POST on the same path independent', async () => {
    const read = mock.method(similarCollections, 'read', async () => ({
      relatedCollectionIds: [528],
      completedSeedCount: 1,
      incompleteSeedCount: 0,
      discoveryActive: false,
    }));
    const trigger = mock.method(similarCollections, 'trigger', async () => ({
      started: true,
    }));
    const get = await request(app)
      .get('/collection/100/similar')
      .set('x-test-user', 'yes');
    const post = await request(app)
      .post('/collection/100/similar')
      .set('x-test-user', 'yes')
      .send({ visitToken: '00000000-0000-4000-8000-000000000001' });
    assert.equal(get.status, 200);
    assert.deepEqual(get.body.relatedCollectionIds, [528]);
    assert.equal(post.status, 202);
    assert.deepEqual(post.body, { started: true });
    assert.equal(read.mock.callCount(), 1);
    assert.equal(trigger.mock.callCount(), 1);
  });

  it('preserves the existing details payload and reads persistence without triggering work', async () => {
    mock.method(
      TheMovieDb.prototype,
      'getCollection',
      async () => ({ id: 100, name: 'Origin', parts: [] }) as never
    );
    mock.method(Media, 'getRelatedMedia', async () => [] as never);
    const read = mock.method(similarCollections, 'read', async () => ({
      relatedCollectionIds: [200],
      completedSeedCount: 1,
      incompleteSeedCount: 0,
      discoveryActive: false,
    }));
    const trigger = mock.method(similarCollections, 'trigger', async () => ({
      started: true,
    }));
    const response = await request(app)
      .get('/collection/100')
      .set('x-test-user', 'yes');
    assert.equal(response.status, 200);
    assert.equal(response.body.id, 100);
    assert.equal(response.body.name, 'Origin');
    assert.deepEqual(response.body.parts, []);
    assert.deepEqual(
      response.body.similarCollections.relatedCollectionIds,
      [200]
    );
    assert.equal(read.mock.callCount(), 1);
    assert.equal(trigger.mock.callCount(), 0);
  });
});
