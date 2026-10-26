import csurf from '@dr.pogodin/csurf';
import { SubtitleJellyfin } from '@server/api/subtitleJellyfin';
import { IssueStatus } from '@server/constants/issue';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import IssueComment from '@server/entity/IssueComment';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import type { SubtitleItem } from '@server/lib/subtitleIssue';
import { SubtitleReportError } from '@server/lib/subtitleIssue';
import {
  SUBTITLE_REPORT_PATH,
  isSubtitleReportRequest,
} from '@server/middleware/subtitleReporting';
import { createSubtitleReportingRoutes } from '@server/routes/subtitleReporting';
import { IssueCommentSubscriber } from '@server/subscriber/IssueCommentSubscriber';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import { setupTestDb } from '@server/test/db';
import cookieParser from 'cookie-parser';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

const itemId = 'a'.repeat(32);
const seriesId = 'b'.repeat(32);
const userId = 'c'.repeat(32);
const token = 'private-jellyfin-user-token';
let items: Record<string, SubtitleItem>;
let verified: { Id: string; Policy: { IsDisabled: boolean } };
const getUser = mock.method(
  SubtitleJellyfin.prototype,
  'getUser',
  async () => verified
);
const getItem = mock.method(
  SubtitleJellyfin.prototype,
  'getItem',
  async (_userId: string, id: string) => items[id]
);
const notification = mock.method(
  IssueSubscriber.prototype as unknown as {
    sendIssueNotification: (...args: unknown[]) => Promise<void>;
  },
  'sendIssueNotification',
  async () => undefined
);
const commentNotification = mock.method(
  IssueCommentSubscriber.prototype as unknown as {
    sendIssueCommentNotification: (...args: unknown[]) => Promise<void>;
  },
  'sendIssueCommentNotification',
  async () => undefined
);

setupTestDb();
let app: express.Express;
let user: User;
beforeEach(async () => {
  const settings = getSettings();
  settings.main.applicationUrl = 'http://localhost:5057/seerr';
  Object.assign(settings.jellyfin, {
    ip: '127.0.0.1',
    port: 8096,
    urlBase: '',
    useSsl: false,
    externalHostname: 'https://jellyfin.example.test/web',
    subtitleReportingEnabled: true,
  });
  user = await getRepository(User).findOneOrFail({
    where: { email: 'demo@seerr.dev' },
  });
  user.jellyfinUserId = userId;
  user.permissions = Permission.CREATE_ISSUES;
  await getRepository(User).save(user);
  verified = { Id: userId, Policy: { IsDisabled: false } };
  items = {
    [itemId]: {
      Id: itemId,
      Type: 'Movie',
      Name: 'Test Movie',
      ProductionYear: 2025,
      ProviderIds: { Tmdb: '123' },
    },
  };
  getUser.mock.resetCalls();
  getUser.mock.mockImplementation(async () => verified);
  getItem.mock.resetCalls();
  notification.mock.resetCalls();
  commentNotification.mock.resetCalls();
  app = express();
  app.use(cookieParser());
  app.use(express.json());
  const csrf = csurf({ cookie: true });
  app.use((req, res, next) =>
    isSubtitleReportRequest(req) ? next() : csrf(req, res, next)
  );
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(__dirname, '../../seerr-api.yml'),
      validateRequests: true,
      validateResponses: true,
    })
  );
  // Ambient identity must never substitute for the Jellyfin credential.
  app.use((req, _res, next) => {
    req.user = new User({ id: 1, permissions: Permission.ADMIN });
    next();
  });
  app.use(SUBTITLE_REPORT_PATH, createSubtitleReportingRoutes());
  app.post('/api/v1/issue', (_req, res) => res.sendStatus(201));
  app.use(
    (
      err: { status?: number; message?: string; errors?: unknown[] },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      void _next;
      res
        .status(err.status ?? 500)
        .json({ message: err.message, errors: err.errors });
    }
  );
});

async function media(mediaType = MediaType.MOVIE, tmdbId = 123) {
  return getRepository(Media).save(
    new Media({ mediaType, tmdbId, status: MediaStatus.AVAILABLE })
  );
}
function report(body: object = { itemId }) {
  return request(app)
    .post(SUBTITLE_REPORT_PATH)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}
function episode(season = 2, number = 4) {
  items[itemId] = {
    Id: itemId,
    Type: 'Episode',
    SeriesId: seriesId,
    ParentIndexNumber: season,
    IndexNumber: number,
    ProviderIds: { Tmdb: '999' },
  };
  items[seriesId] = {
    Id: seriesId,
    Type: 'Series',
    Name: 'Test Series',
    ProviderIds: { Tmdb: '123' },
  };
}
function season(number = 2) {
  episode();
  items[itemId] = {
    Id: itemId,
    Type: 'Season',
    Name: 'Season 99', // Neither title text nor child metadata defines scope.
    SeriesId: seriesId,
    IndexNumber: number,
    ParentIndexNumber: 99,
    ProviderIds: { Tmdb: '999' },
  };
}

describe('Jellyfin subtitle reporting HTTP contract', () => {
  it('fails closed when disabled or absent, before provider lookup, CORS authorization or issue creation', async () => {
    for (const enabled of [false, undefined]) {
      getSettings().jellyfin.subtitleReportingEnabled = enabled;
      const response = await report().set(
        'Origin',
        'https://jellyfin.example.test'
      );
      assert.equal(response.status, 403);
      assert.equal(response.body.message, 'Subtitle reporting is disabled.');
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      const preflight = await request(app)
        .options(SUBTITLE_REPORT_PATH)
        .set('Origin', 'https://jellyfin.example.test');
      assert.equal(preflight.status, 403);
      assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    }
    assert.equal(getUser.mock.callCount(), 0);
    assert.equal(getItem.mock.callCount(), 0);
    assert.equal(await getRepository(Issue).count(), 0);
  });

  it('requires the explicit HTTPS External URL rather than falling back to the internal connection', async () => {
    for (const externalHostname of [
      '',
      'http://localhost:8096',
      'https://jellyfin.example.test?token=private',
      'https://jellyfin.example.test#fragment',
    ]) {
      getSettings().jellyfin.externalHostname = externalHostname;
      const response = await report();
      assert.equal(response.status, 503);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.ok(!JSON.stringify(response.body).includes('private'));
    }
    assert.equal(getUser.mock.callCount(), 0);
  });

  it('creates an attributed Movie issue and initial comment through existing subscribers', async () => {
    const known = await media();
    const response = await report().set('Host', 'attacker.test');
    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { status: 'created' });
    const saved = await getRepository(Issue).findOneOrFail({
      where: { media: { id: known.id } },
    });
    assert.equal(saved.createdBy.id, user.id);
    assert.equal(saved.comments[0].user.id, user.id);
    assert.equal(saved.status, IssueStatus.OPEN);
    assert.equal(saved.issueType, 3);
    assert.equal(
      saved.comments[0].message,
      `Subtitle issue reported for: Test Movie (2025) – http://localhost:5057/seerr/movie/123\nJellyfin item ID: ${itemId}`
    );
    assert.equal(notification.mock.callCount(), 1);
    assert.equal(getUser.mock.callCount(), 1);
    assert.deepEqual(getItem.mock.calls[0].arguments, [userId, itemId]);
    assert.ok(!JSON.stringify(saved).includes(token));
    assert.ok(!response.text.includes(token));
    const unchangedUser = await getRepository(User).findOneOrFail({
      select: { id: true, jellyfinAuthToken: true },
      where: { id: user.id },
    });
    assert.equal(unchangedUser.jellyfinAuthToken, null);
  });
  it('resolves a Series-wide report independently of the Movie with the same numeric TMDB ID', async () => {
    const movie = await media();
    const series = await media(MediaType.TV);
    items[itemId] = {
      Id: itemId,
      Type: 'Series',
      Name: 'A Series',
      ProviderIds: { Tmdb: '123' },
    };
    assert.equal((await report()).status, 201);
    const saved = await getRepository(Issue).findOneOrFail({
      where: { media: { id: series.id } },
    });
    assert.equal(saved.problemSeason, 0);
    assert.equal(saved.problemEpisode, 0);
    assert.match(saved.comments[0].message, /Series-wide.*\/tv\/123/);
    assert.equal(
      await getRepository(Issue).countBy({ media: { id: movie.id } }),
      0
    );
  });
  it('resolves a regular Season through its authoritative parent Series and actual index', async () => {
    const known = await media(MediaType.TV);
    await media(MediaType.TV, 999);
    season();
    assert.equal((await report()).status, 201);
    const saved = (await getRepository(Issue).find())[0];
    assert.equal(saved.media.id, known.id);
    assert.equal(saved.problemSeason, 2);
    assert.equal(saved.problemEpisode, 0);
    assert.equal(saved.createdBy.id, user.id);
    assert.equal(saved.comments[0].user.id, user.id);
    assert.match(
      saved.comments[0].message,
      /Test Series – Season 2 \(all Episodes\).*\/tv\/123/
    );
    assert.deepEqual(
      getItem.mock.calls.map((call) => call.arguments),
      [
        [userId, itemId],
        [userId, seriesId],
      ]
    );
    assert.equal(notification.mock.callCount(), 1);
  });
  it('rejects Season 0 directly without downgrading it to a Series-wide report', async () => {
    await media(MediaType.TV);
    season(0);
    const response = await report();
    assert.equal(response.status, 422);
    assert.equal(getItem.mock.callCount(), 1);
    assert.equal(await getRepository(Issue).count(), 0);
    assert.equal(notification.mock.callCount(), 0);
  });
  it('deduplicates concurrent Season reports across Jellyfin Season items and users', async () => {
    await media(MediaType.TV);
    season();
    const results = await Promise.all([report(), report(), report()]);
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      [200, 200, 201]
    );
    const alternateItemId = 'e'.repeat(32);
    items[alternateItemId] = { ...items[itemId], Id: alternateItemId };
    const other = await getRepository(User).findOneByOrFail({ id: 1 });
    other.jellyfinUserId = 'd'.repeat(32);
    await getRepository(User).save(other);
    verified.Id = other.jellyfinUserId;
    assert.deepEqual((await report({ itemId: alternateItemId })).body, {
      status: 'already-reported',
    });
    const saved = (await getRepository(Issue).find())[0];
    assert.equal(saved.createdBy.id, user.id);
    assert.equal(await getRepository(Issue).count(), 1);
    assert.equal(await getRepository(IssueComment).count(), 1);
    assert.equal(notification.mock.callCount(), 1);
  });
  it('keeps whole-Series, regular-Season, regular-Episode and Specials-Episode scopes distinct', async () => {
    await media(MediaType.TV);
    season();
    assert.equal((await report()).status, 201);
    assert.equal((await report({ itemId: seriesId })).status, 201);
    episode();
    assert.equal((await report()).status, 201);
    episode(0);
    assert.equal((await report()).status, 201);
    assert.equal((await report()).status, 200);
    season(3);
    assert.equal((await report()).status, 201);
    const scopes = (await getRepository(Issue).find())
      .map((issue) => `${issue.problemSeason}/${issue.problemEpisode}`)
      .sort();
    assert.deepEqual(scopes, ['0/0', '0/4', '2/0', '2/4', '3/0']);
    assert.equal(notification.mock.callCount(), 5);
  });
  it('retains linked-user permission checks for Season reports before item lookup', async () => {
    season();
    user.permissions = 0;
    await getRepository(User).save(user);
    assert.equal((await report()).status, 403);
    assert.equal(getItem.mock.callCount(), 0);
    assert.equal(await getRepository(Issue).count(), 0);
  });
  for (const season of [0, 2]) {
    it(`uses the Episode parent Series, including Season ${season}, never the Episode TMDB identity`, async () => {
      await media(MediaType.TV);
      await media(MediaType.TV, 999);
      episode(season);
      items[itemId].IndexNumberEnd = null;
      assert.equal((await report()).status, 201);
      const saved = (await getRepository(Issue).find())[0];
      assert.equal(saved.media.tmdbId, 123);
      assert.equal(saved.problemSeason, season);
      assert.equal(saved.problemEpisode, 4);
      assert.match(saved.comments[0].message, new RegExp(`S0${season}E04`));
      assert.deepEqual(
        getItem.mock.calls.map((call) => call.arguments),
        [
          [userId, itemId],
          [userId, seriesId],
        ]
      );
    });
  }
  for (const bad of [
    { ParentIndexNumber: undefined },
    { ParentIndexNumber: -1 },
    { ParentIndexNumber: 2.5 },
    { IndexNumber: 0 },
    { IndexNumber: -1 },
    { IndexNumber: 1.5 },
    { IndexNumber: 2147483648 },
    { IndexNumberEnd: 5 },
    { IndexNumberEnd: 3 },
    { SeriesId: undefined },
  ]) {
    it(`rejects malformed/ambiguous Episode coordinates ${JSON.stringify(bad)} without Series downgrade`, async () => {
      await media(MediaType.TV);
      episode();
      Object.assign(items[itemId], bad);
      const response = await report();
      assert.equal(response.status, 422, response.text);
      assert.equal(await getRepository(Issue).count(), 0);
    });
  }
  it('rejects missing or wrong-type parent identity', async () => {
    await media(MediaType.TV);
    episode();
    items[seriesId].ProviderIds = {};
    assert.equal((await report()).status, 422);
    items[seriesId].Type = 'Movie';
    assert.equal((await report()).status, 422);
  });
  it('rejects unsupported items, conflicting provider IDs and mismatched item IDs', async () => {
    await media();
    items[itemId].Type = 'MusicAlbum';
    assert.equal((await report()).status, 422);
    items[itemId].Type = 'Movie';
    items[itemId].ProviderIds = { Tmdb: '123', TheMovieDb: '456' };
    assert.equal((await report()).status, 422);
    items[itemId].Id = seriesId;
    assert.equal((await report()).status, 422);
  });
  it('does not create Media or requests when typed Media is unknown', async () => {
    await media(MediaType.TV);
    assert.equal((await report()).status, 404);
    assert.equal(await getRepository(Media).count(), 1);
    assert.equal(await getRepository(Issue).count(), 0);
  });
  it('acknowledges repeated and different-user reports without another comment or creation notification', async () => {
    await media();
    assert.equal((await report()).status, 201);
    const other = await getRepository(User).findOneOrFail({ where: { id: 1 } });
    other.jellyfinUserId = 'd'.repeat(32);
    await getRepository(User).save(other);
    verified.Id = other.jellyfinUserId;
    assert.deepEqual((await report()).body, { status: 'already-reported' });
    assert.equal(await getRepository(Issue).count(), 1);
    assert.equal(await getRepository(IssueComment).count(), 1);
    assert.equal(notification.mock.callCount(), 1);
  });
  it('serializes concurrent submissions without duplicate issues or notifications', async () => {
    await media();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => report())
    );
    assert.equal(results.filter((res) => res.status === 201).length, 1);
    assert.equal(results.filter((res) => res.status === 200).length, 5);
    assert.equal(await getRepository(Issue).count(), 1);
    assert.equal(await getRepository(IssueComment).count(), 1);
    assert.equal(notification.mock.callCount(), 1);
  });
  it('keeps separate Episode scopes and allows reporting again after resolution', async () => {
    await media(MediaType.TV);
    episode();
    assert.equal((await report()).status, 201);
    items[itemId].IndexNumber = 5;
    assert.equal((await report()).status, 201);
    const saved = (await getRepository(Issue).find())[0];
    saved.status = IssueStatus.RESOLVED;
    await getRepository(Issue).save(saved);
    items[itemId].IndexNumber = 4;
    assert.equal((await report()).status, 201);
    assert.equal(await getRepository(Issue).count(), 3);
  });
  it('rejects absent authentication despite an ambient admin, session cookie or Seerr API key', async () => {
    const res = await request(app)
      .post(SUBTITLE_REPORT_PATH)
      .set('X-Api-Key', 'admin-key')
      .set('Cookie', 'connect.sid=admin')
      .send({ itemId });
    assert.equal(res.status, 401);
    assert.equal(getUser.mock.callCount(), 0);
  });
  for (const state of [
    'expired',
    'invalid',
    'disabled',
    'missing-policy',
    'unlinked',
    'unauthorized',
  ]) {
    it(`rejects ${state} accounts without item lookup or issue creation`, async () => {
      if (state === 'expired' || state === 'invalid')
        getUser.mock.mockImplementation(async () => {
          throw new SubtitleReportError(
            401,
            'Jellyfin authentication rejected.'
          );
        });
      if (state === 'disabled') verified.Policy.IsDisabled = true;
      if (state === 'missing-policy')
        verified.Policy = {} as { IsDisabled: boolean };
      if (state === 'unlinked') verified.Id = 'e'.repeat(32);
      if (state === 'unauthorized') {
        user.permissions = Permission.REQUEST;
        await getRepository(User).save(user);
      }
      assert.equal(
        (await report()).status,
        ['unlinked', 'unauthorized'].includes(state) ? 403 : 401
      );
      assert.equal(getItem.mock.callCount(), 0);
      assert.equal(await getRepository(Issue).count(), 0);
    });
  }
  it('accepts managers and normalized linked GUIDs', async () => {
    await media();
    user.permissions = Permission.MANAGE_ISSUES;
    user.jellyfinUserId = 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC';
    await getRepository(User).save(user);
    assert.equal((await report()).status, 201);
  });
  it('strictly rejects extra client identities/descriptions/URLs and query parameters before provider access', async () => {
    for (const field of [
      'tmdbId',
      'userId',
      'issueType',
      'description',
      'url',
    ]) {
      assert.equal(
        (await report({ itemId, [field]: 'untrusted' })).status,
        400
      );
    }
    assert.equal((await report().query({ userId: '1' })).status, 400);
    assert.equal((await report({ itemId: '../other' })).status, 400);
    assert.equal(getUser.mock.callCount(), 0);
  });
  it('accepts only the configured browser origin and native requests without cookie CSRF', async () => {
    await media();
    const preflight = await request(app)
      .options(SUBTITLE_REPORT_PATH)
      .set('Origin', 'https://jellyfin.example.test')
      .set('Access-Control-Request-Method', 'POST');
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers['access-control-allow-origin'],
      'https://jellyfin.example.test'
    );
    assert.equal(
      preflight.headers['access-control-allow-credentials'],
      undefined
    );
    assert.equal(
      (await report().set('Origin', 'https://jellyfin.example.test')).status,
      201
    );
    assert.equal((await report()).status, 200);
    for (const origin of [
      'https://attacker.test',
      'https://jellyfin.example.test:8443',
      'https://jellyfin.example.test.attacker.test',
      'https://jellyfin.example.test/web',
      'http://jellyfin.example.test',
    ]) {
      const rejected = await report().set('Origin', origin);
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers['access-control-allow-origin'], undefined);
    }
    assert.equal((await report().set('Origin', 'null')).status, 403);
    assert.equal(
      (await request(app).post('/api/v1/issue').send({})).status,
      403
    );
    assert.equal(
      isSubtitleReportRequest({
        path: `${SUBTITLE_REPORT_PATH}/other`,
        method: 'POST',
      } as express.Request),
      false
    );
  });
  it('rejects non-JSON simple browser submissions', async () => {
    assert.equal(
      (
        await request(app)
          .post(SUBTITLE_REPORT_PATH)
          .set('Authorization', `Bearer ${token}`)
          .type('form')
          .send({ itemId })
      ).status,
      415
    );
    assert.equal(getUser.mock.callCount(), 0);
  });
  it('requires safe configured URLs and HTTPS for remote access', async () => {
    const settings = getSettings();
    settings.main.applicationUrl = 'http://remote.example.test';
    assert.equal((await report()).status, 503);
    settings.main.applicationUrl = 'https://seerr.example.test';
    assert.equal((await report()).status, 403);
    settings.jellyfin.externalHostname =
      'https://name:password@jellyfin.example.test';
    assert.equal((await report()).status, 503);
    assert.equal(getUser.mock.callCount(), 0);
  });
  it('bounds verified-user requests, including duplicates', async () => {
    await media();
    for (let n = 0; n < 10; n++)
      assert.ok([200, 201].includes((await report()).status));
    const rejected = await report();
    assert.equal(rejected.status, 429);
    assert.equal(rejected.headers['retry-after'], '60');
    assert.equal(getItem.mock.callCount(), 10);
  });
  it('bounds unauthenticated IP abuse before contacting Jellyfin', async () => {
    getUser.mock.mockImplementation(async () => {
      throw new SubtitleReportError(401, 'Jellyfin authentication rejected.');
    });
    for (let n = 0; n < 30; n++) assert.equal((await report()).status, 401);
    assert.equal((await report()).status, 429);
    assert.equal(getUser.mock.callCount(), 30);
  });
  it('never reflects sensitive provider exceptions', async () => {
    getUser.mock.mockImplementation(async () => {
      throw new Error(`Authorization: ${token} secret-url?token=${token}`);
    });
    const response = await report();
    assert.equal(response.status, 503);
    assert.ok(!response.text.includes(token));
    assert.equal(response.headers['cache-control'], 'no-store');
  });
  it('bounds global authentication attempts even across different IPs', async () => {
    app.enable('trust proxy');
    getUser.mock.mockImplementation(async () => {
      throw new SubtitleReportError(401, 'Jellyfin authentication rejected.');
    });
    for (let n = 0; n < 120; n++) {
      assert.equal(
        (await report().set('X-Forwarded-For', `192.0.2.${n + 1}`)).status,
        401
      );
    }
    assert.equal(
      (await report().set('X-Forwarded-For', '192.0.2.200')).status,
      429
    );
    assert.equal(getUser.mock.callCount(), 120);
  });
  it('bounds concurrent provider verifications without timeouts or additional provider requests', async () => {
    await media();
    let release!: () => void;
    let ready!: () => void;
    let started = 0;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const allStarted = new Promise<void>((resolve) => {
      ready = resolve;
    });
    getUser.mock.mockImplementation(async () => {
      if (++started === 8) ready();
      await held;
      return verified;
    });
    const pending = Array.from({ length: 8 }, () =>
      report().then((response) => response)
    );
    try {
      await allStarted;
      assert.equal((await report()).status, 429);
      assert.equal(getUser.mock.callCount(), 8);
    } finally {
      release();
    }
    const responses = await Promise.all(pending);
    assert.equal(
      responses.filter((response) => response.status === 201).length,
      1
    );
    assert.equal(
      responses.filter((response) => response.status === 200).length,
      7
    );
  });
});
