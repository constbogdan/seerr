// Explicit optional acceptance: pnpm test server/test/subtitleReporting.browser.ts
// Real Chromium + real, certificate-pinned HTTPS. All provider calls are mocked.
import csurf from '@dr.pogodin/csurf';
import { SubtitleJellyfin } from '@server/api/subtitleJellyfin';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { SubtitleReportError } from '@server/lib/subtitleIssue';
import {
  SUBTITLE_REPORT_PATH,
  isSubtitleReportRequest,
} from '@server/middleware/subtitleReporting';
import { createSubtitleReportingRoutes } from '@server/routes/subtitleReporting';
import { IssueCommentSubscriber } from '@server/subscriber/IssueCommentSubscriber';
import { IssueSubscriber } from '@server/subscriber/IssueSubscriber';
import { setupTestDb } from '@server/test/db';
import { SubtitleBrowser } from '@server/test/subtitleBrowser';
import cookieParser from 'cookie-parser';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it, mock } from 'node:test';

const origin = 'https://jellyfin.vaulttek.dev';
const itemId = 'a'.repeat(32);
const seriesId = 'b'.repeat(32);
const episodeId = 'd'.repeat(32);
const seasonId = 'e'.repeat(32);
const specialsSeasonId = 'f'.repeat(32);
const specialsEpisodeId = '1'.repeat(32);
const userId = 'c'.repeat(32);
let validToken = true;
mock.method(SubtitleJellyfin.prototype, 'getUser', async () => {
  if (!validToken)
    throw new SubtitleReportError(401, 'Jellyfin authentication rejected.');
  return { Id: userId, Policy: { IsDisabled: false } };
});
mock.method(
  SubtitleJellyfin.prototype,
  'getItem',
  async (_user: string, id: string) =>
    id === seasonId || id === specialsSeasonId
      ? {
          Id: id,
          Type: 'Season',
          SeriesId: seriesId,
          IndexNumber: id === seasonId ? 2 : 0,
        }
      : id === episodeId || id === specialsEpisodeId
        ? {
            Id: id,
            Type: 'Episode',
            SeriesId: seriesId,
            ParentIndexNumber: id === episodeId ? 2 : 0,
            IndexNumber: 4,
          }
        : {
            Id: id,
            Type: id === seriesId ? 'Series' : 'Movie',
            Name: 'Fixture Media',
            ProductionYear: 2025,
            ProviderIds: { Tmdb: '123' },
          }
);
for (const [prototype, method] of [
  [IssueSubscriber.prototype, 'sendIssueNotification'],
  [IssueCommentSubscriber.prototype, 'sendIssueCommentNotification'],
] as const) {
  mock.method(
    prototype as unknown as Record<string, () => Promise<void>>,
    method,
    async () => undefined
  );
}
setupTestDb();
let browser: SubtitleBrowser;
let server: ReturnType<typeof createServer>;
let directory: string;
let apiOrigin: string;
let clientSource: string;
let redirectResponse = false;
let redirectTargetHits = 0;
let certificate: Buffer;
let handler = createSubtitleReportingRoutes();
const received: { method: string; origin?: string; auth: boolean }[] = [];

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'seerr-subtitle-https-'));
  clientSource = await readFile(
    path.join(
      __dirname,
      '../../public/integrations/jellyfin-subtitle-report.js'
    ),
    'utf8'
  );
  const certPath = path.join(directory, 'fixture.crt');
  const keyPath = path.join(directory, 'fixture.key');
  execFileSync(
    process.env.SUBTITLE_TEST_OPENSSL ||
      (process.platform === 'win32'
        ? 'C:/Program Files/Git/usr/bin/openssl.exe'
        : 'openssl'),
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-days',
      '1',
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  certificate = await readFile(certPath);
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  const csrf = csurf({ cookie: true });
  app.use((req, res, next) =>
    isSubtitleReportRequest(req) ? next() : csrf(req, res, next)
  );
  // Deliberately misbehaving test upstream; NOT a production route modification.
  app.use((req, res, next) => {
    if (req.path === '/redirect-target') redirectTargetHits++;
    if (
      redirectResponse &&
      req.path === SUBTITLE_REPORT_PATH &&
      req.method === 'POST'
    ) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      return res.redirect(307, `${apiOrigin}/redirect-target`);
    }
    next();
  });
  app.use(
    OpenApiValidator.middleware({
      apiSpec: path.join(__dirname, '../../seerr-api.yml'),
      validateRequests: true,
      validateResponses: true,
    })
  );
  app.use(SUBTITLE_REPORT_PATH, (req, res, next) => {
    received.push({
      method: req.method,
      origin: req.get('Origin'),
      auth: !!req.get('Authorization'),
    });
    handler(req, res, next);
  });
  app.post('/api/v1/issue', (_req, res) => res.sendStatus(201));
  app.use(
    (
      error: { status?: number; message: string },
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      void next;
      res.status(error.status || 500).json({ message: error.message });
    }
  );
  server = createServer(
    { key: await readFile(keyPath), cert: certificate },
    app
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(5058, '127.0.0.1', resolve);
  });
  apiOrigin = 'https://localhost:5058';
  const pin = createHash('sha256')
    .update(
      new X509Certificate(certificate).publicKey.export({
        format: 'der',
        type: 'spki',
      })
    )
    .digest('base64');
  browser = await SubtitleBrowser.start(
    path.join(directory, 'browser-profile'),
    pin
  );
});

beforeEach(async () => {
  const settings = getSettings();
  settings.main.applicationUrl = apiOrigin;
  Object.assign(settings.jellyfin, {
    ip: '127.0.0.1',
    port: 8096,
    urlBase: '',
    externalHostname: origin,
    subtitleReportingEnabled: true,
  });
  const user = await getRepository(User).findOneByOrFail({
    email: 'demo@seerr.dev',
  });
  user.jellyfinUserId = userId;
  user.permissions = Permission.CREATE_ISSUES;
  await getRepository(User).save(user);
  await getRepository(Media).save(
    new Media({
      mediaType: MediaType.MOVIE,
      tmdbId: 123,
      status: MediaStatus.AVAILABLE,
    })
  );
  await getRepository(Media).save(
    new Media({
      mediaType: MediaType.TV,
      tmdbId: 123,
      status: MediaStatus.AVAILABLE,
    })
  );
  handler = createSubtitleReportingRoutes();
  redirectResponse = false;
  redirectTargetHits = 0;
  validToken = true;
  received.length = 0;
});

after(async () => {
  if (browser) await browser.close();
  if (server?.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory)
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
});

function postExpression() {
  return `fetch(${JSON.stringify(apiOrigin + SUBTITLE_REPORT_PATH)}, {method:'POST', mode:'cors', credentials:'omit', redirect:'error', headers:{'Content-Type':'application/json', Authorization:'Bearer fixture-user-token'}, body:JSON.stringify({itemId:${JSON.stringify(itemId)}})}).then(async r=>({status:r.status, body:await r.json()})).catch(()=>({blocked:true}))`;
}

describe('direct HTTPS subtitle reporting acceptance', () => {
  it('permits the exact Jellyfin origin over real TLS with preflight and token-only CSRF handling', async () => {
    const page = await browser.page(
      '<!doctype html><title>Isolated Jellyfin-origin fixture</title>',
      apiOrigin,
      origin
    );
    try {
      assert.deepEqual(
        await page.evaluate('[location.origin, isSecureContext]'),
        [origin, true]
      );
      const permission = await page.evaluate(
        "navigator.permissions.query({name:'loopback-network'}).then(p=>p.state).catch(()=> 'unsupported')"
      );
      assert.equal(permission, 'granted');
      assert.deepEqual(
        await page.evaluate(postExpression()),
        {
          status: 201,
          body: { status: 'created' },
        },
        JSON.stringify(page.failures)
      );
      assert.deepEqual(
        received.map((request) => request.method),
        ['OPTIONS', 'POST']
      );
      assert.equal(received[0].auth, false);
      assert.equal(received[1].auth, true);
      assert.ok(received.every((request) => request.origin === origin));
      assert.equal(await getRepository(Issue).count(), 1);
      assert.deepEqual(await page.evaluate(postExpression()), {
        status: 200,
        body: { status: 'already-reported' },
      });
    } finally {
      await page.close();
    }
  });
  it('blocks unrelated browser origins before an authenticated POST reaches the handler', async () => {
    const page = await browser.page(
      '<!doctype html><title>Unrelated-origin fixture</title>',
      apiOrigin,
      'https://unrelated.invalid'
    );
    try {
      assert.deepEqual(await page.evaluate(postExpression()), {
        blocked: true,
      });
      assert.deepEqual(
        received.map((request) => request.method),
        ['OPTIONS']
      );
      assert.equal(await getRepository(Issue).count(), 0);
    } finally {
      await page.close();
    }
  });
  it('returns readable sanitized authentication errors to the allowed origin for expired tokens', async () => {
    validToken = false;
    const page = await browser.page(
      '<!doctype html><title>Expired-token fixture</title>',
      apiOrigin,
      origin
    );
    try {
      assert.deepEqual(await page.evaluate(postExpression()), {
        status: 401,
        body: { message: 'Jellyfin authentication rejected.' },
      });
      assert.equal(await getRepository(Issue).count(), 0);
    } finally {
      await page.close();
    }
  });
  it('continues rejecting ordinary Seerr mutations without CSRF tokens', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpsRequest(
        `${apiOrigin}/api/v1/issue`,
        { method: 'POST', ca: certificate },
        (res) => {
          res.resume();
          resolve(res.statusCode || 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

// DOM fixtures mirror the inspected 10.10.7 controls, with no production scripts,
// real credentials or network access. The configured script talks to Stage A.
function detailHtml(id = itemId) {
  return `<!doctype html><style>body{background:#181818;color:white}button{min-height:44px;min-width:44px}.mainDetailButtons{display:flex;flex-wrap:wrap}.hide{display:none}</style>
    <div class="itemDetailPage"><div class="mainDetailButtons">
      <button class="btnUserRating" data-id="${id}">Favorite</button>
      <span id="custom-jellyfin-likes" data-item-id="${id}"><button class="jf-like-button like">Like</button><button class="jf-like-button dislike">Dislike</button></span>
      <button class="btnMoreCommands">More</button></div></div>
    <script>
    history.replaceState({},'', '#/details?id=${id}');
    window.fixtureTypes=${JSON.stringify({ [itemId]: 'Movie', [seriesId]: 'Series', [episodeId]: 'Episode', [seasonId]: 'Season', [specialsSeasonId]: 'Season', [specialsEpisodeId]: 'Episode' })};
    window.fixtureSeasonIndexes=${JSON.stringify({ [seasonId]: 2, [specialsSeasonId]: 0 })};
    window.fixtureToken='fixture-user-token'; window.fixtureUser=${JSON.stringify(userId)};
    window.reads=[];
    window.ApiClient={getCurrentUserId:()=>window.fixtureUser,accessToken:()=>window.fixtureToken,
      getItem:async(user,id)=>{window.reads.push({user,id});return {Id:id,Type:window.fixtureTypes[id]||'Season',IndexNumber:window.fixtureSeasonIndexes[id]}}};
    window.waitForFixture=(selector,text)=>new Promise((resolve,reject)=>{
      const check=()=>{const el=document.querySelector(selector);return el && (!text || el.textContent.includes(text))};
      if(check()){resolve(true);return;}
      const observer=new MutationObserver(()=>{if(check()){observer.disconnect();clearTimeout(deadline);resolve(true)}});
      const deadline=setTimeout(()=>{observer.disconnect();reject(Error('Fixture DOM condition timed out'))},5000);
      observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true});
    });
    </script>`;
}

async function clientPage(id = itemId, configured = apiOrigin, setup = '') {
  const page = await browser.page(detailHtml(id), apiOrigin, origin);
  if (setup) await page.evaluate(setup);
  await page.evaluate(
    clientSource.replace(
      "const SEERR_ORIGIN = '';",
      `const SEERR_ORIGIN = ${JSON.stringify(configured)};`
    )
  );
  return page;
}
type FixturePage = Awaited<ReturnType<typeof clientPage>>;
async function ready(page: FixturePage) {
  await page.evaluate("waitForFixture('#seerr-subtitle-report')");
}
async function clickAndToast(page: FixturePage, message: string) {
  await page.evaluate(
    "document.querySelectorAll('.toast').forEach(toast=>toast.remove());document.querySelector('#seerr-subtitle-report').click()"
  );
  await page.evaluate(
    `waitForFixture('.toast:last-child',${JSON.stringify(message)})`
  );
}

describe('Jellyfin Injector subtitle action', () => {
  it('ships no configured destination or Seerr credentials, token storage, logging or polling', () => {
    assert.match(clientSource, /const SEERR_ORIGIN = '';/);
    assert.doesNotMatch(
      clientSource,
      /x-api-key|x-api-user|localStorage|sessionStorage|console\.|setInterval|https:\/\/[^\s'"`]+/i
    );
  });
  for (const [kind, id] of [
    ['Movie', itemId],
    ['Series', seriesId],
    ['Episode', episodeId],
    ['Season', seasonId],
    ['Specials Episode', specialsEpisodeId],
  ]) {
    it(`reports the authoritative current ${kind} item with no navigation, then acknowledges duplicates`, async () => {
      const page = await clientPage(id);
      try {
        await ready(page);
        assert.equal(
          await page.evaluate(
            "document.querySelector('#seerr-subtitle-report').previousElementSibling.id"
          ),
          'custom-jellyfin-likes'
        );
        await clickAndToast(page, 'Subtitle issue reported.');
        const saved = (await getRepository(Issue).find())[0];
        assert.match(
          saved.comments[0].message,
          new RegExp(`Jellyfin item ID: ${id}`)
        );
        assert.equal(
          saved.media.mediaType,
          kind === 'Movie' ? MediaType.MOVIE : MediaType.TV
        );
        assert.equal(
          saved.problemSeason,
          kind === 'Season' || kind === 'Episode' ? 2 : 0
        );
        assert.equal(
          saved.problemEpisode,
          kind === 'Episode' || kind === 'Specials Episode' ? 4 : 0
        );
        await clickAndToast(page, 'already been reported');
        assert.equal(await getRepository(Issue).count(), 1);
        assert.equal(
          await page.evaluate('location.hash'),
          `#/details?id=${id}`
        );
        assert.deepEqual(
          await page.evaluate('[localStorage.length,sessionStorage.length]'),
          [0, 0]
        );
      } finally {
        await page.close();
      }
    });
  }
  it('keeps the shipped empty configuration disabled even for forced clicks and DOM-supplied URLs', async () => {
    const page = await clientPage(
      itemId,
      '',
      "document.body.dataset.seerrOrigin='https://untrusted.invalid'"
    );
    try {
      await ready(page);
      assert.equal(
        await page.evaluate(
          "document.querySelector('#seerr-subtitle-report').disabled"
        ),
        true
      );
      await page.evaluate(
        "document.querySelector('#seerr-subtitle-report').dispatchEvent(new MouseEvent('click',{bubbles:true}))"
      );
      assert.equal(received.length, 0);
    } finally {
      await page.close();
    }
  });
  it('rejects insecure, credential-bearing or non-origin configuration values', async () => {
    for (const invalid of [
      'http://localhost:5058',
      'https://user:password@localhost:5058',
      `${apiOrigin}/path`,
      `${apiOrigin}?token=bad`,
      `${apiOrigin}#fragment`,
    ]) {
      const page = await clientPage(itemId, invalid);
      try {
        await ready(page);
        assert.equal(
          await page.evaluate(
            "document.querySelector('#seerr-subtitle-report').disabled"
          ),
          true
        );
      } finally {
        await page.close();
      }
    }
    assert.equal(received.length, 0);
  });
  it('sends exactly the itemId with the current token and safe fetch options, suppressing rapid duplicate clicks', async () => {
    const page = await clientPage(
      itemId,
      apiOrigin,
      `window.requests=[]; window.fetch=(url,options)=>{window.requests.push({url,options});return new Promise(resolve=>window.finishRequest=resolve)}`
    );
    try {
      await ready(page);
      await page.evaluate(
        "window.fixtureToken='current-fixture-token';const b=document.querySelector('#seerr-subtitle-report');b.click();b.dispatchEvent(new MouseEvent('click',{bubbles:true}));"
      );
      assert.equal(await page.evaluate('requests.length'), 1);
      assert.deepEqual(
        await page.evaluate(
          "({url:requests[0].url, method:requests[0].options.method, mode:requests[0].options.mode,credentials:requests[0].options.credentials,redirect:requests[0].options.redirect,headers:requests[0].options.headers,body:JSON.parse(requests[0].options.body),disabled:document.querySelector('#seerr-subtitle-report').disabled})"
        ),
        {
          url: apiOrigin + SUBTITLE_REPORT_PATH,
          method: 'POST',
          mode: 'cors',
          credentials: 'omit',
          redirect: 'error',
          headers: {
            Authorization: 'Bearer current-fixture-token',
            'Content-Type': 'application/json',
          },
          body: { itemId },
          disabled: true,
        }
      );
      await page.evaluate(
        "finishRequest(new Response(JSON.stringify({status:'created'}),{status:201,headers:{'Content-Type':'application/json'}}))"
      );
      await page.evaluate(
        "waitForFixture('.toast:last-child','Subtitle issue reported.')"
      );
      assert.equal(
        await page.evaluate(
          "document.querySelector('#seerr-subtitle-report').disabled"
        ),
        false
      );
    } finally {
      await page.close();
    }
  });
  it('shows fixed error toasts without reflecting provider payloads or secrets', async () => {
    const page = await clientPage(
      itemId,
      apiOrigin,
      "window.replyStatus=401;window.fetch=async()=>new Response(JSON.stringify({message:'sensitive-provider-payload'}),{status:window.replyStatus})"
    );
    try {
      await ready(page);
      for (const [status, text] of [
        [401, 'session expired'],
        [403, 'not allowed'],
        [422, 'cannot be reported'],
        [429, 'Too many'],
        [500, 'Could not report'],
      ]) {
        await page.evaluate(`window.replyStatus=${status}`);
        await clickAndToast(page, String(text));
      }
      assert.equal(
        await page.evaluate(
          "document.body.textContent.includes('sensitive-provider-payload')"
        ),
        false
      );
      assert.equal(received.length, 0);
    } finally {
      await page.close();
    }
  });
  it('handles an absent session token without a request', async () => {
    const page = await clientPage(itemId, apiOrigin, "window.fixtureToken=''");
    try {
      await ready(page);
      await clickAndToast(page, 'Sign in to Jellyfin');
      assert.equal(received.length, 0);
    } finally {
      await page.close();
    }
  });
  it('rejects HTTPS redirects without forwarding authorization to another endpoint', async () => {
    redirectResponse = true;
    const page = await clientPage();
    try {
      await ready(page);
      await clickAndToast(page, 'Could not report');
      assert.equal(redirectTargetHits, 0);
      assert.equal(await getRepository(Issue).count(), 0);
    } finally {
      await page.close();
    }
  });
  it('discards stale item reads, uses the new SPA identity, and cleans up hidden/destroyed views', async () => {
    const page = await clientPage(
      itemId,
      apiOrigin,
      'window.pendingReads={};ApiClient.getItem=(_user,id)=>new Promise(resolve=>pendingReads[id]=resolve)'
    );
    try {
      await page.evaluate(
        `history.replaceState({},'', '#/details?id=${seriesId}');document.querySelector('.btnUserRating').dataset.id=${JSON.stringify(seriesId)};document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewshow'));`
      );
      await page.evaluate(
        `pendingReads[${JSON.stringify(itemId)}]({Id:${JSON.stringify(itemId)},Type:'Movie'})`
      );
      assert.equal(
        await page.evaluate(
          "document.querySelectorAll('#seerr-subtitle-report').length"
        ),
        0
      );
      await page.evaluate(
        `pendingReads[${JSON.stringify(seriesId)}]({Id:${JSON.stringify(seriesId)},Type:'Series'})`
      );
      await ready(page);
      await clickAndToast(page, 'Subtitle issue reported.');
      assert.equal(
        (await getRepository(Issue).find())[0].media.mediaType,
        MediaType.TV
      );
      await page.evaluate(
        "document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewbeforehide'))"
      );
      assert.equal(
        await page.evaluate(
          "document.querySelectorAll('#seerr-subtitle-report').length"
        ),
        0
      );
      await page.evaluate(
        `ApiClient.getItem=async(_user,id)=>({Id:id,Type:'Series'});document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewshow',{detail:{isRestored:true}}))`
      );
      await ready(page);
      await page.evaluate(
        "document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewdestroy'))"
      );
      assert.equal(
        await page.evaluate(
          "document.querySelectorAll('#seerr-subtitle-report').length"
        ),
        0
      );
    } finally {
      await page.close();
    }
  });
  it('hides unsupported content and guards mismatched returned identities', async () => {
    for (const getItem of [
      "async(_u,id)=>({Id:id,Type:'Season'})",
      "async(_u,id)=>({Id:id,Type:'Season',IndexNumber:0})",
      "async(_u,id)=>({Id:id,Type:'Season',IndexNumber:-1})",
      "async(_u,id)=>({Id:id,Type:'Season',IndexNumber:1.5})",
      "async(_u,id)=>({Id:id,Type:'Season',IndexNumber:2147483648})",
      "async(_u,id)=>({Id:id,Type:'Season',IndexNumber:'2'})",
      "async()=>({Id:'different',Type:'Movie'})",
    ]) {
      const page = await clientPage(
        itemId,
        apiOrigin,
        `ApiClient.getItem=${getItem}`
      );
      try {
        assert.equal(
          await page.evaluate(
            "document.querySelectorAll('#seerr-subtitle-report').length"
          ),
          0
        );
      } finally {
        await page.close();
      }
    }
    assert.equal(received.length, 0);
  });
  it('updates regular Season scope during SPA navigation and hides Specials Seasons without disturbing Specials Episodes', async () => {
    const page = await clientPage(seriesId);
    try {
      await ready(page);
      // Native Likes does not support Seasons; retain the native Favorite anchor.
      await page.evaluate(
        "document.querySelector('#custom-jellyfin-likes').remove()"
      );
      for (const id of [
        seasonId,
        specialsSeasonId,
        specialsEpisodeId,
        seasonId,
      ]) {
        await page.evaluate(
          `history.replaceState({},'', '#/details?id=${id}');document.querySelector('.btnUserRating').dataset.id='${id}';document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewshow'));`
        );
        if (id === specialsSeasonId) {
          assert.equal(
            await page.evaluate(
              "document.querySelectorAll('#seerr-subtitle-report').length"
            ),
            0
          );
          continue;
        }
        await ready(page);
        assert.equal(
          await page.evaluate(
            "document.querySelectorAll('#seerr-subtitle-report').length"
          ),
          1
        );
        assert.equal(
          await page.evaluate(
            "document.querySelector('#seerr-subtitle-report').previousElementSibling.className"
          ),
          'btnUserRating'
        );
        await clickAndToast(
          page,
          id === seasonId && (await getRepository(Issue).count()) > 0
            ? 'already been reported'
            : 'Subtitle issue reported.'
        );
      }
      assert.deepEqual(
        (await getRepository(Issue).find())
          .map((issue) => `${issue.problemSeason}/${issue.problemEpisode}`)
          .sort(),
        ['0/4', '2/0']
      );
      assert.equal(
        received.filter((request) => request.method === 'POST').length,
        3
      );
    } finally {
      await page.close();
    }
  });
  it('does not duplicate on repeated rendering/injection and removes all handlers on disposal', async () => {
    const page = await clientPage();
    try {
      await ready(page);
      await page.evaluate(
        clientSource.replace(
          "const SEERR_ORIGIN = '';",
          `const SEERR_ORIGIN = ${JSON.stringify(apiOrigin)};`
        )
      );
      await page.evaluate(
        "document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewshow'));document.querySelector('.mainDetailButtons').appendChild(document.createElement('span'))"
      );
      assert.equal(
        await page.evaluate(
          "document.querySelectorAll('#seerr-subtitle-report').length"
        ),
        1
      );
      await page.evaluate(
        "window.__seerrSubtitleReporter.dispose();document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewshow'))"
      );
      assert.equal(
        await page.evaluate(
          "document.querySelectorAll('#seerr-subtitle-report').length"
        ),
        0
      );
    } finally {
      await page.close();
    }
  });
  it('aborts in-flight work on navigation without a stale toast, and keeps Like/Dislike actions separate', async () => {
    const page = await clientPage(
      itemId,
      apiOrigin,
      "window.likeClicks=0;document.querySelector('.like').onclick=()=>likeClicks++;window.fetch=(_url,options)=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>{window.requestAborted=true;reject(new Error('aborted'))})})"
    );
    try {
      await ready(page);
      await page.evaluate(
        "document.querySelector('.like').click();document.querySelector('#seerr-subtitle-report').click();document.querySelector('.itemDetailPage').dispatchEvent(new CustomEvent('viewbeforehide'));document.querySelector('.itemDetailPage').classList.add('hide')"
      );
      assert.deepEqual(
        await page.evaluate(
          '[likeClicks,requestAborted,document.querySelectorAll(".toast").length]'
        ),
        [1, true, 0]
      );
      assert.equal(received.length, 0);
    } finally {
      await page.close();
    }
  });
  it('supports mobile touch and keyboard activation without changing other controls', async () => {
    const page = await clientPage(episodeId);
    try {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 375,
        height: 812,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await ready(page);
      const rect = await page.evaluate<{ x: number; y: number }>(
        "(()=>{const r=document.querySelector('#seerr-subtitle-report').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()"
      );
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [rect],
      });
      await page.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await page.evaluate(
        "waitForFixture('.toast:last-child','Subtitle issue reported.')"
      );
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.evaluate(
        "document.querySelector('#seerr-subtitle-report').focus()"
      );
      assert.equal(
        await page.evaluate('document.activeElement.id'),
        'seerr-subtitle-report'
      );
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        text: '\r',
      });
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
      });
      await page.evaluate(
        "waitForFixture('.toast:last-child','already been reported')"
      );
      assert.equal(await getRepository(Issue).count(), 1);
      assert.equal(
        await page.evaluate(
          'document.documentElement.scrollWidth <= innerWidth'
        ),
        true
      );
    } finally {
      await page.close();
    }
  });
});
