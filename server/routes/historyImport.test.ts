import { Permission } from '@server/lib/permissions';
import {
  createWholphinHistoryArtifact,
  type WholphinHistoryContent,
} from '@server/lib/wholphinHistory';
import historyImportRoutes from '@server/routes/historyImport';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

const app = express();
app.use(express.json());
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
app.use('/settings/history-import', historyImportRoutes);

setupTestDb();

const artifactContent = (): WholphinHistoryContent => ({
  schema: 'wholphin-history-v1',
  jellyfinServerScope: 'route-test-server',
  coverage: {
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-10-04T00:00:00.000Z',
  },
  viewers: [],
  media: [
    {
      id: 'movie:one',
      mediaType: 'movie',
      identities: [
        { provider: 'tmdb', sourceScope: '', value: '101' },
        {
          provider: 'jellyfin',
          sourceScope: 'route-test-server',
          value: 'jf-movie-one',
        },
      ],
    },
  ],
  seasons: [],
  episodes: [],
  libraryFacts: [],
  viewingFacts: [],
});

describe('historical-data import authorization', () => {
  it('keeps permanent import operations administrator-only', async () => {
    const paths = [
      ['get', '/settings/history-import'],
      ['post', '/settings/history-import/validate'],
      ['post', '/settings/history-import'],
    ] as const;
    for (const [method, route] of paths) {
      const response = await request(app)
        [method](route)
        .set('x-test-role', 'user');
      assert.equal(response.status, 403, `${method.toUpperCase()} ${route}`);
    }
  });

  it('allows an administrator to inspect generic import capabilities', async () => {
    const response = await request(app)
      .get('/settings/history-import')
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.supportedSchemas, ['wholphin-history-v1']);
    assert.equal(response.body.maximumFileBytes, 16 * 1024 * 1024);
    assert.equal(response.body.status.state, 'not-imported');
  });

  it('returns structured inspection and an explicit conflict response', async () => {
    const first = createWholphinHistoryArtifact(artifactContent());
    const validation = await request(app)
      .post('/settings/history-import/validate')
      .set('x-test-role', 'admin')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from(JSON.stringify(first)));
    assert.equal(validation.status, 200);
    assert.equal(validation.body.disposition, 'first-import');
    assert.equal(validation.body.importable, true);
    assert.equal(validation.body.observedRange.completeness, 'not-asserted');

    const imported = await request(app)
      .post('/settings/history-import')
      .set('x-test-role', 'admin')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from(JSON.stringify(first)));
    assert.equal(imported.status, 200);
    assert.equal(imported.body.disposition, 'first-import');
    const status = await request(app)
      .get('/settings/history-import')
      .set('x-test-role', 'admin');
    assert.equal(status.body.status.state, 'accepted');
    assert.equal(status.body.status.observedRange.completeness, 'not-asserted');
    assert.equal(status.body.status.contentHash, first.contentHash);

    const changed = artifactContent();
    changed.media[0].identities[0].value = '202';
    const conflict = await request(app)
      .post('/settings/history-import')
      .set('x-test-role', 'admin')
      .set('content-type', 'application/octet-stream')
      .send(
        Buffer.from(JSON.stringify(createWholphinHistoryArtifact(changed)))
      );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.inspection.disposition, 'corrected-facts');
  });

  it('guards the import page with the native administrator permission', () => {
    const source = readFileSync(
      path.join(process.cwd(), 'src/pages/settings/history-import.tsx'),
      'utf8'
    );
    assert.match(source, /useRouteGuard\(Permission\.ADMIN\)/);
    assert.equal(Permission.ADMIN > 0, true);
  });
});
