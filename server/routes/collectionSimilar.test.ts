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
