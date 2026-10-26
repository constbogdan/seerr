import JellyfinAPI from '@server/api/jellyfin';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import Settings, {
  getSettings,
  type JellyfinSettings,
} from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import settingsRoutes from '@server/routes/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

setupTestDb();
const settings = getSettings();
let saved: JellyfinSettings | undefined;
let actor: User;
let app: express.Express;
const save = mock.method(settings, 'save', async () => {
  saved = JSON.parse(JSON.stringify(settings.jellyfin)) as JellyfinSettings;
});
const system = mock.method(
  JellyfinAPI.prototype,
  'getSystemInfo',
  async () => ({ Id: 'configured-server', ServerName: 'Existing Jellyfin' })
);

beforeEach(async () => {
  actor = await getRepository(User).findOneByOrFail({ id: 1 });
  settings.jellyfin = {
    name: 'Existing Jellyfin',
    serverId: 'configured-server',
    ip: '127.0.0.1',
    port: 8096,
    apiKey: 'existing-jellyfin-key',
    urlBase: '/jf',
    useSsl: false,
    externalHostname: 'https://jellyfin.test/web',
    libraries: [
      { id: 'existing-library', name: 'Movies', enabled: true, type: 'movie' },
    ],
    subtitleReportingEnabled: false,
  };
  saved = undefined;
  save.mock.resetCalls();
  system.mock.resetCalls();
  app = express();
  app.use(express.json());
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(__dirname, '../../../seerr-api.yml'),
      validateRequests: true,
    })
  );
  app.use((req, _res, next) => {
    req.user = actor;
    next();
  });
  app.use(
    '/api/v1/settings',
    isAuthenticated(Permission.ADMIN),
    settingsRoutes
  );
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      void _next;
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
});

const readSettings = () =>
  request(app).get('/api/v1/settings/jellyfin').set('X-Api-Key', 'fixture-key');
const updateSettings = (body: Record<string, unknown>) =>
  request(app)
    .post('/api/v1/settings/jellyfin')
    .set('X-Api-Key', 'fixture-key')
    .send(body);

describe('Jellyfin subtitle settings API', () => {
  it('is default-disabled for existing settings', () => {
    assert.equal(new Settings().jellyfin.subtitleReportingEnabled, false);
  });

  it('persists enable/disable through the existing settings path without changing the connection or linked users', async () => {
    const before = JSON.stringify({
      ...settings.jellyfin,
      subtitleReportingEnabled: undefined,
    });
    const users = await getRepository(User).find();
    for (const enabled of [true, false]) {
      const response = await updateSettings({
        subtitleReportingEnabled: enabled,
      });
      assert.equal(response.status, 200);
      assert.equal(saved?.subtitleReportingEnabled, enabled);
      assert.equal(
        (await readSettings()).body.subtitleReportingEnabled,
        enabled
      );
      assert.equal(
        JSON.stringify({
          ...settings.jellyfin,
          subtitleReportingEnabled: undefined,
        }),
        before
      );
      assert.deepEqual(await getRepository(User).find(), users);
    }
    assert.equal(save.mock.callCount(), 2);
    assert.equal(system.mock.callCount(), 2); // Existing connection verification only.
  });

  it('rejects invalid enable flags or origin changes before connection access or persistence', async () => {
    const before = JSON.stringify(settings.jellyfin);
    for (const body of [
      { subtitleReportingEnabled: 'false' },
      {
        subtitleReportingEnabled: true,
        externalHostname: 'http://jellyfin.test',
      },
      {
        subtitleReportingEnabled: true,
        externalHostname: 'https://name:secret@jellyfin.test',
      },
      {
        subtitleReportingEnabled: true,
        externalHostname: 'https://jellyfin.test?token=secret',
      },
      {
        subtitleReportingEnabled: true,
        externalHostname: 'https://jellyfin.test#fragment',
      },
    ]) {
      const response = await updateSettings(body);
      assert.equal(response.status, 400);
      assert.ok(!JSON.stringify(response.body).includes('secret'));
      assert.equal(JSON.stringify(settings.jellyfin), before);
    }
    settings.jellyfin.subtitleReportingEnabled = true;
    assert.equal(
      (await updateSettings({ externalHostname: 'http://changed.test' }))
        .status,
      400
    );
    assert.equal(save.mock.callCount(), 0);
    assert.equal(system.mock.callCount(), 0);
  });

  it('preserves HTTP configurations when reporting remains off and keeps settings administrator-only', async () => {
    assert.equal(
      (await updateSettings({ externalHostname: 'http://existing.test/web' }))
        .status,
      200
    );
    actor = new User({ id: 2, permissions: Permission.CREATE_ISSUES });
    assert.equal((await readSettings()).status, 403);
    assert.equal(
      (await updateSettings({ subtitleReportingEnabled: true })).status,
      403
    );
  });
});
