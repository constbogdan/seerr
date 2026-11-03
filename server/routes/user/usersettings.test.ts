import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { In } from 'typeorm';
import userRoutes from '.';

const defaultAuthenticateResponse = {
  User: {
    Id: 'jf-link-user-001',
    Name: 'linkeduser',
    ServerId: 'server-1',
    Policy: { IsAdministrator: false },
  },
  AccessToken: 'fake-qc-access-token',
};

const authenticateQCMock = mock.method(
  JellyfinAPI.prototype,
  'authenticateQuickConnect',
  async () => ({ ...defaultAuthenticateResponse })
);

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

setupTestDb();

function configureJellyfin() {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin.ip = 'localhost';
  settings.jellyfin.port = 8096;
  settings.jellyfin.useSsl = false;
  settings.jellyfin.urlBase = '';
}

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  settings.main.localLogin = true;

  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return { agent, userId: res.body.id as number };
}

describe('POST /user/:id/settings/linked-accounts/jellyfin/quickconnect', () => {
  beforeEach(() => {
    authenticateQCMock.mock.resetCalls();
    authenticateQCMock.mock.mockImplementation(async () => ({
      ...defaultAuthenticateResponse,
    }));
    configureJellyfin();
  });

  it('links the account when the media server is Jellyfin', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 1);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, 'jf-link-user-001');
    assert.strictEqual(user.userType, UserType.JELLYFIN);
  });

  it('returns 403 when the media server is Emby', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, null);
  });
});

describe('user metrics inclusion', () => {
  it('defaults existing and newly created identities to included', async () => {
    const existing = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    const created = await getRepository(User).save(
      new User({ email: 'new-metrics-user@example.test', avatar: '' })
    );
    assert.equal(existing.includeInUserMetrics, true);
    assert.equal(created.includeInUserMetrics, true);
  });

  it('allows an administrator to exclude a user without changing account behavior', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const target = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    target.jellyfinUserId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    await getRepository(User).save(target);
    const before = {
      userType: target.userType,
      permissions: target.permissions,
      jellyfinUserId: target.jellyfinUserId,
      requestCount: await getRepository(MediaRequest).count({
        where: { requestedBy: { id: target.id } },
      }),
    };

    const response = await agent
      .post(`/user/${target.id}/settings/permissions`)
      .send({
        permissions: target.permissions,
        includeInUserMetrics: false,
      });
    assert.equal(response.status, 200);
    const stored = await getRepository(User).findOneByOrFail({ id: target.id });
    assert.equal(stored.includeInUserMetrics, false);
    const reloaded = await agent.get(`/user/${target.id}/settings/permissions`);
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.body.includeInUserMetrics, false);
    assert.deepEqual(
      {
        userType: stored.userType,
        permissions: stored.permissions,
        jellyfinUserId: stored.jellyfinUserId,
        requestCount: await getRepository(MediaRequest).count({
          where: { requestedBy: { id: target.id } },
        }),
      },
      before
    );
    assert.equal(
      (await loginAs('demo@seerr.dev', 'test1234')).userId,
      target.id
    );
  });

  it('does not let an ordinary user change metrics inclusion', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
    const response = await agent
      .post(`/user/${userId}/settings/permissions`)
      .send({ permissions: 0, includeInUserMetrics: false });
    assert.equal(response.status, 403);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: userId }))
        .includeInUserMetrics,
      true
    );
  });

  it('rejects a malformed metrics value without mutating the user', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const target = await getRepository(User).findOneOrFail({
      where: { email: 'demo@seerr.dev' },
    });
    const before = target.includeInUserMetrics;

    const response = await agent
      .post(`/user/${target.id}/settings/permissions`)
      .send({
        permissions: target.permissions,
        includeInUserMetrics: 'false',
      });

    assert.equal(response.status, 400);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: target.id }))
        .includeInUserMetrics,
      before
    );
  });

  it('filters included users explicitly without username inference', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const excluded = await getRepository(User).save(
      new User({
        email: 'ordinary-name@example.test',
        username: 'Alice',
        avatar: '',
        includeInUserMetrics: false,
      })
    );
    const includedName = await getRepository(User).save(
      new User({
        email: 'jellyseerr@example.test',
        username: 'Jellyseerr',
        avatar: '',
        includeInUserMetrics: true,
      })
    );

    const response = await agent.get(
      '/user?includeInUserMetrics=true&sort=displayname&sortDirection=asc&take=100'
    );
    assert.equal(response.status, 200);
    const ids = response.body.results.map((user: { id: number }) => user.id);
    assert.equal(ids.includes(excluded.id), false);
    assert.equal(ids.includes(includedName.id), true);
    const names = response.body.results.map(
      (user: { displayName: string }) => user.displayName
    );
    assert.deepEqual(
      names,
      [...names].sort((left, right) => left.localeCompare(right))
    );
  });

  it('requires and bulk-updates the boolean metrics value', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const first = await getRepository(User).save(
      new User({
        email: 'bulk-metrics-a@example.test',
        avatar: '',
        permissions: 0,
        includeInUserMetrics: true,
      })
    );
    const second = await getRepository(User).save(
      new User({
        email: 'bulk-metrics-b@example.test',
        avatar: '',
        permissions: 0,
        includeInUserMetrics: false,
      })
    );

    const missing = await agent.put('/user').send({
      ids: [String(first.id), String(second.id)],
      permissions: 0,
    });
    assert.equal(missing.status, 400);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: first.id }))
        .includeInUserMetrics,
      true
    );
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: second.id }))
        .includeInUserMetrics,
      false
    );

    for (const value of [false, true]) {
      const response = await agent.put('/user').send({
        ids: [String(first.id), String(second.id)],
        permissions: 0,
        includeInUserMetrics: value,
      });
      assert.equal(response.status, 200);
      const stored = await getRepository(User).findBy({
        id: In([first.id, second.id]),
      });
      assert.equal(
        stored.every((user) => user.includeInUserMetrics === value),
        true
      );
    }
  });

  it('rejects malformed bulk metrics state atomically', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const target = await getRepository(User).save(
      new User({
        email: 'bulk-metrics-invalid@example.test',
        avatar: '',
        permissions: 0,
      })
    );
    const response = await agent.put('/user').send({
      ids: [String(target.id)],
      permissions: 0,
      includeInUserMetrics: 'false',
    });
    assert.equal(response.status, 400);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: target.id }))
        .includeInUserMetrics,
      true
    );
  });

  it('does not let an ordinary user bulk-update metrics inclusion', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
    const before = await getRepository(User).findOneByOrFail({ id: userId });
    const response = await agent.put('/user').send({
      ids: [String(userId)],
      permissions: before.permissions,
      includeInUserMetrics: !before.includeInUserMetrics,
    });
    assert.equal(response.status, 403);
    assert.equal(
      (await getRepository(User).findOneByOrFail({ id: userId }))
        .includeInUserMetrics,
      before.includeInUserMetrics
    );
  });

  it('saves general settings for a target that has no settings row', async () => {
    const { agent } = await loginAs('admin@seerr.dev', 'test1234');
    const target = await getRepository(User).save(
      new User({
        email: 'no-settings@example.test',
        username: 'No Settings',
        avatar: '',
      })
    );

    const response = await agent.post(`/user/${target.id}/settings/main`).send({
      username: 'Updated Name',
      email: target.email,
      locale: 'en',
    });
    assert.equal(response.status, 200);
    const stored = await getRepository(User).findOneOrFail({
      where: { id: target.id },
      relations: { settings: true },
    });
    assert.ok(stored.settings?.id);
    const settings = await getRepository(UserSettings).findOneOrFail({
      where: { id: stored.settings.id },
      relations: { user: true },
    });
    assert.equal(settings.user.id, target.id);
    assert.equal(stored.username, 'Updated Name');
  });
});
