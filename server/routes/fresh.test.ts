import freshService from '@server/lib/fresh/service';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import freshRoutes from '@server/routes/fresh';
import freshSettingsRoutes, {
  mergeFreshSettingsUpdate,
} from '@server/routes/settings/fresh';
import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.header('x-test-role');
  if (role) {
    req.user = {
      id: 1,
      hasPermission: (permission: Permission) =>
        role === 'admin' || permission === 0,
    } as Express.Request['user'];
  }
  next();
});
app.use('/fresh', isAuthenticated(), freshRoutes);
app.use(
  '/settings/fresh',
  isAuthenticated(Permission.ADMIN),
  freshSettingsRoutes
);

describe('Fresh route authorization and safe responses', () => {
  it('retains the write-only token when updates omit or blank it', () => {
    const current = {
      enabled: true,
      baseUrl: 'https://autobrr.test',
      apiToken: 'fixture-token',
      filterId: 7,
      candidateWindowDays: 90,
      maximumItems: 20,
      movieCriteria: {},
      tvCriteria: {},
    };
    const body = { ...current, apiToken: '' };
    assert.equal(
      mergeFreshSettingsUpdate(current, body).apiToken,
      'fixture-token'
    );
    const omitted: Partial<typeof body> = { ...body };
    delete omitted.apiToken;
    assert.equal(
      mergeFreshSettingsUpdate(current, omitted).apiToken,
      'fixture-token'
    );
  });

  it('requires authentication for results and admin permission for operations', async () => {
    assert.equal((await request(app).get('/fresh')).status, 403);
    assert.equal(
      (await request(app).get('/settings/fresh').set('x-test-role', 'user'))
        .status,
      403
    );
    assert.equal(
      (
        await request(app)
          .get('/settings/fresh/diagnostics')
          .set('x-test-role', 'user')
      ).status,
      403
    );
  });

  it('returns disabled results to users and write-only settings to admins', async () => {
    const settings = getSettings();
    settings.fresh = {
      enabled: false,
      baseUrl: 'https://autobrr.test',
      apiToken: 'fixture-token',
      filterId: 7,
      candidateWindowDays: 90,
      maximumItems: 20,
      movieCriteria: {},
      tvCriteria: {},
    };
    freshService.configure(settings.fresh);

    const result = await request(app).get('/fresh').set('x-test-role', 'user');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.results, []);
    assert.equal(result.body.status.status, 'disabled');

    const response = await request(app)
      .get('/settings/fresh')
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.apiTokenConfigured, true);
    assert.equal(response.body.apiToken, undefined);
    assert.doesNotMatch(JSON.stringify(response.body), /fixture-token/);

    const diagnostics = await request(app)
      .get('/settings/fresh/diagnostics')
      .set('x-test-role', 'admin');
    assert.equal(diagnostics.status, 200);
    assert.equal(diagnostics.body.latestAttempt, null);
    assert.equal(diagnostics.body.currentProjection.status, 'disabled');
    assert.doesNotMatch(JSON.stringify(diagnostics.body), /fixture-token/);
  });
});
