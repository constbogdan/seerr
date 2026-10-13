import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  R11_BROWSER_REPETITIONS,
  R11_PAGE_SIZES,
  R11_PERFORMANCE_TARGETS,
  R11_VIEWPORT_WIDTHS,
  createR11LibraryResponse,
  createR11SeriesDetail,
  createR11WatchlistPage,
} from './fixtures';

const PROXY_PORT = 5070;
const DEBUG_PORT = 9229;
const root = resolve(__dirname, '../../../..');
const delay = (milliseconds: number) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const rounded = (value: number) => Math.round(value * 1000) / 1000;

const listenerTrackerSource = `
  (() => {
    if (globalThis.__r11ListenerTracker) return;
    const originalAdd = EventTarget.prototype.addEventListener;
    const originalRemove = EventTarget.prototype.removeEventListener;
    const targetIds = new WeakMap();
    const listenerIds = new WeakMap();
    const active = new Map();
    const operations = { add: new Map(), remove: new Map() };
    let nextTargetId = 1;
    let nextListenerId = 1;
    const increment = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    const targetCategory = (target) => {
      if (target === window) return 'Window';
      if (target === document) return 'Document';
      if (target instanceof Element) return 'Element:' + target.tagName.toLowerCase();
      return target?.constructor?.name ?? 'EventTarget';
    };
    const capture = (options) =>
      typeof options === 'boolean' ? options : Boolean(options?.capture);
    const identity = (target, type, listener, options) => {
      let targetId = targetIds.get(target);
      if (!targetId) {
        targetId = nextTargetId++;
        targetIds.set(target, targetId);
      }
      let listenerId = listenerIds.get(listener);
      if (!listenerId) {
        listenerId = nextListenerId++;
        listenerIds.set(listener, listenerId);
      }
      return targetId + '|' + type + '|' + listenerId + '|' + Number(capture(options));
    };
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      const result = originalAdd.call(this, type, listener, options);
      if (listener && (typeof listener === 'function' || typeof listener === 'object')) {
        const key = identity(this, type, listener, options);
        const group = targetCategory(this) + ':' + type;
        if (!active.has(key)) {
          active.set(key, group);
          increment(operations.add, group);
        }
      }
      return result;
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      const result = originalRemove.call(this, type, listener, options);
      if (listener && (typeof listener === 'function' || typeof listener === 'object')) {
        const key = identity(this, type, listener, options);
        const group = active.get(key);
        if (group) {
          active.delete(key);
          increment(operations.remove, group);
        }
      }
      return result;
    };
    const sortedObject = (entries) =>
      Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
    globalThis.__r11ListenerTracker = {
      snapshot: () => {
        const activeByGroup = new Map();
        for (const group of active.values()) increment(activeByGroup, group);
        return {
          active: sortedObject(activeByGroup),
          added: sortedObject(operations.add),
          removed: sortedObject(operations.remove),
        };
      },
    };
  })();
`;

const json = (response: ServerResponse, body: unknown, status = 200) => {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

const publicSettings = {
  initialized: true,
  applicationTitle: 'R11 Local Benchmark',
  applicationUrl: '',
  hideAvailable: false,
  hideBlocklisted: false,
  hideRequested: false,
  localLogin: true,
  mediaServerLogin: true,
  movie4kEnabled: false,
  series4kEnabled: false,
  discoverRegion: '',
  streamingRegion: '',
  originalLanguage: '',
  mediaServerType: 2,
  partialRequestsEnabled: true,
  enableSpecialEpisodes: false,
  cacheImages: false,
  vapidPublic: '',
  enablePushRegistration: false,
  locale: 'en',
  emailEnabled: false,
  newPlexLogin: true,
  youtubeUrl: '',
  versionCheck: false,
  plexClientIdentifier: 'r11-local-only',
  freshEnabled: true,
};

const adminUser = {
  id: 1,
  warnings: [],
  username: 'r11-admin',
  displayName: 'R11 Administrator',
  email: 'r11@example.invalid',
  avatar: '',
  permissions: 2,
  userType: 3,
  includeInUserMetrics: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  requestCount: 0,
  settings: { locale: 'en' },
};

const titleDetails = (id: number, tv: boolean) => ({
  id,
  ...(tv
    ? { name: `R11 Series ${id}`, firstAirDate: '2026-01-01' }
    : { title: `R11 Movie ${id}`, releaseDate: '2026-01-01' }),
  posterPath: null,
  backdropPath: null,
  overview: 'Deterministic local benchmark presentation.',
  voteAverage: 7.5,
  mediaInfo: null,
});

const assertSupportedProductionBuild = async () => {
  const buildId = (
    await readFile(join(root, '.next', 'BUILD_ID'), 'utf8')
  ).trim();
  const manifest = JSON.parse(
    await readFile(join(root, '.next', 'build-manifest.json'), 'utf8')
  ) as { pages?: Record<string, string[]> };
  const libraryFiles = manifest.pages?.['/library'] ?? [];
  assert.ok(
    libraryFiles.length > 0,
    'The production build has no /library entry'
  );
  const javascript = (
    await Promise.all(
      libraryFiles
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFile(join(root, '.next', file), 'utf8'))
    )
  ).join('\n');
  assert.equal(
    /\/_next\/static\/media\/(?:radarr|sonarr)\.[^"']+\.svg/.test(javascript),
    false,
    'Unsupported SVG module output detected. Rebuild with pnpm build:next; do not use next build --webpack.'
  );
  return {
    buildId,
    requiredCommand: 'pnpm build:next',
    svgModuleSemantics: 'react-component',
  } as const;
};

const startMockApp = async (requestLog: string[]) => {
  await access(join(root, '.next', 'BUILD_ID'));
  Reflect.set(process.env, 'NODE_ENV', 'production');
  Reflect.set(process.env, 'HOST', '127.0.0.1');
  Reflect.set(process.env, 'PORT', String(PROXY_PORT));
  const { default: next } = await import('next');
  const app = next({
    dev: false,
    dir: root,
    hostname: '127.0.0.1',
    port: PROXY_PORT,
  });
  await app.prepare();
  const nextHandler = app.getRequestHandler();
  const coldPresentationBatchId = '11111111-1111-4111-8111-111111111111';
  let coldPresentationReady = false;
  const pendingColdPresentationResponses: ServerResponse[] = [];
  const releaseColdPresentation = () => {
    if (coldPresentationReady) return;
    coldPresentationReady = true;
    for (const pendingResponse of pendingColdPresentationResponses.splice(0)) {
      json(pendingResponse, {
        state: 'complete',
        revision: 1,
        pendingCount: 0,
      });
    }
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${PROXY_PORT}`);
    requestLog.push(`${request.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname.startsWith('/api/v1/')) {
      if (url.pathname === '/api/v1/settings/public')
        return json(response, publicSettings);
      if (url.pathname === '/api/v1/auth/me') return json(response, adminUser);
      if (url.pathname === '/api/v1/status')
        return json(response, {
          version: 'r11',
          buildChannel: 'local',
          commitTag: 'r11',
          restartRequired: false,
        });
      if (
        url.pathname === '/api/v1/request/count' ||
        url.pathname === '/api/v1/issue/count'
      )
        return json(response, { count: 0 });
      if (url.pathname === '/api/v1/settings/removal')
        return json(response, {
          removalDelayDays: 60,
          removalScanEnabled: false,
          removalProcessingEnabled: false,
          movie: {
            enabled: false,
            minimumAgeMonths: 3,
            inactivityMonths: 1,
            itemsPerRun: 10,
          },
          series: {
            enabled: false,
            minimumAgeMonths: 3,
            inactivityMonths: 1,
            itemsPerRun: 10,
          },
        });
      if (url.pathname === '/api/v1/library/bulk-actions/eligibility')
        return json(response, { results: [] });
      if (url.pathname === '/api/v1/library/selection-size')
        return json(response, {
          targets: [],
          sizeBytes: String(10 * 1024 ** 3),
          fileCount: 1,
          unknownFileCount: 0,
        });
      if (url.pathname === '/api/v1/library') {
        const count = Number(url.searchParams.get('take') ?? 25);
        const libraryResponse = createR11LibraryResponse(count);
        if (url.searchParams.get('search') === 'R11 cold presentation') {
          if (!coldPresentationReady) {
            return json(response, {
              ...libraryResponse,
              results: libraryResponse.results.map((item) => ({
                ...item,
                title: `Canonical ${item.canonicalMediaId}`,
                posterPath: null,
                backdropPath: null,
                tmdbRating: null,
                collection: null,
              })),
              presentation: {
                state: 'pending',
                batchId: coldPresentationBatchId,
                revision: 0,
                pendingCount: count,
              },
            });
          }
          return json(response, {
            ...libraryResponse,
            results: libraryResponse.results.map((item) => ({
              ...item,
              title: `Localized ${item.title}`,
            })),
            presentation: {
              state: 'complete',
              revision: 1,
              pendingCount: 0,
            },
          });
        }
        return json(response, libraryResponse);
      }
      if (
        url.pathname ===
        `/api/v1/library/presentation-status/${coldPresentationBatchId}`
      ) {
        if (!coldPresentationReady) {
          pendingColdPresentationResponses.push(response);
          return;
        }
        return json(response, {
          state: 'complete',
          revision: 1,
          pendingCount: 0,
        });
      }
      const seriesDetail = url.pathname.match(
        /^\/api\/v1\/library\/(\d+)\/series-detail$/
      );
      if (seriesDetail)
        return json(response, createR11SeriesDetail(Number(seriesDetail[1])));
      if (url.pathname === '/api/v1/library/user-availability')
        return json(response, {
          users: Array.from({ length: 6 }, (_, index) => ({
            id: index + 1,
            displayName: `Viewer ${index + 1}`,
            avatar: null,
            available: true,
          })),
        });
      if (url.pathname === '/api/v1/user')
        return json(response, {
          pageInfo: { pages: 1, page: 1, results: 1, pageSize: 100 },
          results: [adminUser],
        });
      if (url.pathname === '/api/v1/discover/watchlist')
        return json(
          response,
          createR11WatchlistPage(Number(url.searchParams.get('page') ?? 1))
        );
      if (url.pathname === '/api/v1/leaving-soon')
        return json(response, {
          pageInfo: { pages: 1, page: 1, results: 4, pageSize: 20 },
          results: createR11LibraryResponse(8)
            .results.slice(0, 4)
            .map((item) => ({
              canonicalMediaId: item.canonicalMediaId,
              tmdbId: item.tmdbId,
              mediaType: item.mediaType,
              title: item.title,
              year: item.year,
              posterPath: item.posterPath,
              schedules: [
                {
                  id: 90_000 + item.canonicalMediaId,
                  canonicalMediaId: item.canonicalMediaId,
                  targetType: item.mediaType,
                  seasonNumber: null,
                  origin: 'manual',
                  status: 'active',
                  scheduledAt: '2026-10-01T12:00:00.000Z',
                  removeAt: '2026-12-01T12:00:00.000Z',
                  revision: 1,
                },
              ],
            })),
        });
      if (url.pathname === '/api/v1/fresh')
        return json(response, {
          page: 1,
          totalPages: 1,
          totalResults: 8,
          results: Array.from({ length: 8 }, (_, index) => ({
            ...titleDetails(300_000 + index, index % 2 === 1),
            mediaType: index % 2 === 1 ? 'tv' : 'movie',
            freshFirstSeenAt: '2026-10-01T12:00:00.000Z',
          })),
          status: { status: 'ready', refreshing: false, itemCount: 8 },
        });
      if (url.pathname === '/api/v1/request')
        return json(response, {
          pageInfo: { pages: 1, page: 1, results: 0, pageSize: 10 },
          results: [],
          serviceErrors: { radarr: [], sonarr: [] },
        });
      const movie = url.pathname.match(/^\/api\/v1\/movie\/(\d+)$/);
      if (movie) return json(response, titleDetails(Number(movie[1]), false));
      const tv = url.pathname.match(/^\/api\/v1\/tv\/(\d+)$/);
      if (tv) return json(response, titleDetails(Number(tv[1]), true));
      requestLog.push(`UNMOCKED ${url.pathname}${url.search}`);
      return json(
        response,
        { message: `Unmocked R11 endpoint: ${url.pathname}` },
        501
      );
    }

    void nextHandler(request, response);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(PROXY_PORT, '127.0.0.1', resolveListen)
  );
  return {
    releaseColdPresentation,
    close: async () => {
      releaseColdPresentation();
      await closeServer(server);
      await app.close();
    },
  };
};

const waitForHttp = async (url: string, timeoutMilliseconds = 30_000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The isolated process has not bound its local port yet.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const portIsOpen = (port: number) =>
  new Promise<boolean>((resolveOpen) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once('error', () => resolveOpen(false));
  });

const existingPath = async (paths: string[]) => {
  for (const candidate of paths) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next platform-specific location.
    }
  }
  throw new Error('Chrome was not found. Set R11_CHROME_PATH explicitly.');
};

const chromePath = () =>
  process.env.R11_CHROME_PATH
    ? Promise.resolve(process.env.R11_CHROME_PATH)
    : existingPath(
        process.platform === 'win32'
          ? [
              'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
              'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            ]
          : process.platform === 'darwin'
            ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
            : [
                '/usr/bin/google-chrome',
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
              ]
      );

const startChrome = async (profile: string): Promise<ChildProcess> => {
  const executable = await chromePath();
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--metrics-recording-only',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  return child;
};

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

class Cdp {
  private socket: WebSocket;
  private commandId = 0;
  private pending = new Map<number, PendingCommand>();
  private events: { method: string; params: unknown }[] = [];
  private runtimeErrors: { method: string; params: unknown }[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (message.method) {
        this.events.push({ method: message.method, params: message.params });
        if (this.events.length > 100) this.events.shift();
        const consoleType = (message.params as { type?: string } | undefined)
          ?.type;
        if (
          message.method === 'Runtime.exceptionThrown' ||
          (message.method === 'Runtime.consoleAPICalled' &&
            consoleType === 'error')
        ) {
          this.runtimeErrors.push({
            method: message.method,
            params: message.params,
          });
        }
      }
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    };
    this.socket.onclose = () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Chrome DevTools socket closed'));
      }
      this.pending.clear();
    };
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolveOpen, reject) => {
      this.socket.onopen = () => resolveOpen();
      this.socket.onerror = () =>
        reject(new Error('Chrome DevTools socket failed'));
    });
  }

  send(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.commandId;
    return new Promise<Record<string, unknown>>((resolveCommand, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveCommand(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.commandId;
    this.socket.send(JSON.stringify({ id, method, params }));
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      includeCommandLineAPI: true,
    })) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    };
    if (response.exceptionDetails)
      throw new Error(response.exceptionDetails.text);
    return response.result?.value as T;
  }

  close() {
    this.socket.close();
  }

  recentEvents() {
    return this.events;
  }

  errors() {
    return this.runtimeErrors;
  }
}

const cdpJson = async (path: string, options?: RequestInit) => {
  const response = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}${path}`,
    options
  );
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
};

const createTarget = async (url: string) => {
  const version = (await cdpJson('/json/version')) as {
    webSocketDebuggerUrl: string;
  };
  const browser = new Cdp(version.webSocketDebuggerUrl);
  await browser.open();
  const created = (await browser.send('Target.createTarget', { url })) as {
    targetId: string;
  };
  browser.close();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const targets = (await cdpJson('/json/list')) as {
      id: string;
      webSocketDebuggerUrl: string;
    }[];
    const target = targets.find(({ id }) => id === created.targetId);
    if (target?.webSocketDebuggerUrl) return target;
    await delay(100);
  }
  throw new Error(
    `Chrome target ${created.targetId} did not become inspectable`
  );
};

const waitFor = async (
  cdp: Cdp,
  expression: string,
  timeoutMilliseconds = 25_000
) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await cdp.evaluate<boolean>(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for browser condition: ${expression}`);
};

const metricNames = new Set([
  'Documents',
  'Frames',
  'JSEventListeners',
  'Nodes',
  'LayoutCount',
  'RecalcStyleCount',
  'LayoutDuration',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration',
  'JSHeapUsedSize',
  'JSHeapTotalSize',
]);

const performanceMetrics = async (cdp: Cdp) => {
  const response = (await cdp.send('Performance.getMetrics')) as {
    metrics: { name: string; value: number }[];
  };
  return Object.fromEntries(
    response.metrics
      .filter(({ name }) => metricNames.has(name))
      .map(({ name, value }) => [name, value])
  );
};

const pageSnapshotExpression = `(() => {
  const rows = [...document.querySelectorAll('[data-testid^="library-library-row-"]')];
  const nodesPerCard = rows.map((row) => 1 + row.querySelectorAll('*').length);
  const externalServiceLinks = [...document.querySelectorAll('a[aria-label^="Radarr"], a[aria-label^="Sonarr"]')]
    .map((link) => ({
      label: link.getAttribute('aria-label'),
      svgElements: link.querySelectorAll('svg').length,
      imageElements: link.querySelectorAll('img').length,
    }));
  const tooltipTriggers = [...document.querySelectorAll('*')].filter((element) => {
    const listeners = getEventListeners(element);
    return listeners.mouseenter?.length && listeners.mouseleave?.length && listeners.mousemove?.length;
  });
  const clientWidth = document.documentElement.clientWidth;
  const stickyHeader = document.querySelector('[data-testid="library-sticky-header"]');
  const stickyFooter = document.querySelector('[data-testid="library-sticky-pagination"]');
  const stickyContainer = stickyHeader?.parentElement;
  const rect = (element) => {
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, width: bounds.width };
  };
  const overflowElements = [...document.querySelectorAll('body *')]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.right > clientWidth + 0.5 || rect.left < -0.5)
    .map(({ element, rect }) => ({
      tag: element.tagName,
      testId: element.getAttribute('data-testid'),
      className: typeof element.className === 'string' ? element.className : '',
      left: rect.left,
      right: rect.right,
      width: rect.width,
    }));
  return {
    domElements: document.querySelectorAll('*').length,
    rowCount: rows.length,
    nodesPerCard: {
      minimum: Math.min(...nodesPerCard),
      maximum: Math.max(...nodesPerCard),
      mean: nodesPerCard.reduce((sum, value) => sum + value, 0) / nodesPerCard.length,
    },
    firstRowGeometry: rows[0]
      ? (() => {
          const bounds = rows[0].getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            width: bounds.width,
            height: bounds.height,
          };
        })()
      : null,
    focusableElements: document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length,
    tooltipTriggers: tooltipTriggers.length,
    documentMousedownListeners: getEventListeners(document).mousedown?.length ?? 0,
    externalServiceLinks,
    viewport: {
      innerWidth,
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflowPixels: Math.max(0, document.documentElement.scrollWidth - clientWidth),
    },
    overflowElements,
    stickyChrome: {
      container: rect(stickyContainer),
      header: rect(stickyHeader),
      footer: rect(stickyFooter),
    },
    longTasks: globalThis.__r11LongTasks ?? [],
    progressive: globalThis.__r11Progress ?? {
      firstBatchAt: null,
      allCardsAt: null,
      batches: [],
      maximumYieldDelay: 0,
    },
    layoutShifts: globalThis.__r11LayoutShifts ?? [],
  };
})()`;

const measureLibrary = async (size: number, width: number, run: number) => {
  const target = await createTarget('about:blank');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Performance.enable'),
    cdp.send('HeapProfiler.enable'),
  ]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      globalThis.__r11LongTasks = [];
      globalThis.__r11LayoutShifts = [];
      globalThis.__r11Progress = {
        firstBatchAt: null,
        allCardsAt: null,
        batches: [],
        maximumYieldDelay: 0,
      };
      let yieldTimer;
      const inspectLibraryProgress = () => {
        const results = document.querySelector('[data-library-mounted-count]');
        if (!(results instanceof HTMLElement)) return;
        const count = Number(results.dataset.libraryMountedCount ?? 0);
        const now = performance.now();
        const progress = globalThis.__r11Progress;
        if (!progress.batches.some((batch) => batch.count === count)) {
          progress.batches.push({ count, at: now });
        }
        if (count > 0 && progress.firstBatchAt === null) {
          progress.firstBatchAt = now;
          let lastYield = performance.now();
          const measureYield = () => {
            const measuredAt = performance.now();
            progress.maximumYieldDelay = Math.max(
              progress.maximumYieldDelay,
              measuredAt - lastYield
            );
            lastYield = measuredAt;
            if (progress.allCardsAt === null) yieldTimer = setTimeout(measureYield, 0);
          };
          yieldTimer = setTimeout(measureYield, 0);
        }
        if (count >= ${size} && progress.allCardsAt === null) {
          progress.allCardsAt = now;
          if (yieldTimer) clearTimeout(yieldTimer);
        }
      };
      new MutationObserver(inspectLibraryProgress).observe(document, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['data-library-mounted-count'],
      });
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            globalThis.__r11LongTasks.push({ duration: entry.duration, startTime: entry.startTime });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            globalThis.__r11LayoutShifts.push({
              value: entry.value,
              hadRecentInput: entry.hadRecentInput,
            });
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
    `,
  });
  cdp.notify('Runtime.evaluate', {
    expression: `location.href = ${JSON.stringify(
      `http://127.0.0.1:${PROXY_PORT}/library?pageSize=${size}`
    )}`,
  });
  await delay(250);
  try {
    await waitFor(
      cdp,
      `document.querySelectorAll('[data-testid^="library-library-row-"]').length === ${size}`
    );
  } catch (error) {
    const diagnostic = await cdp.evaluate(`({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      rows: document.querySelectorAll('[data-testid^="library-library-row-"]').length,
      body: document.body?.innerText?.slice(0, 1000),
    })`);
    const browserErrors = cdp
      .recentEvents()
      .filter(({ method }) =>
        ['Runtime.exceptionThrown', 'Runtime.consoleAPICalled'].includes(method)
      )
      .map(({ method, params }) => {
        const details = params as {
          type?: string;
          args?: { value?: string; description?: string }[];
          exceptionDetails?: {
            exception?: { description?: string };
          };
        };
        return {
          method,
          type: details.type,
          messages: details.args?.map(
            ({ value, description }) => value ?? description
          ),
          exception: details.exceptionDetails?.exception?.description,
        };
      });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(
        diagnostic
      )}\n${JSON.stringify(browserErrors, null, 2)}`
    );
  }
  await delay(700);

  const tooltipInteraction = await cdp.evaluate<{
    focusOpened: boolean;
    focusClosedWithEscape: boolean;
    openingLatencyMilliseconds: number | null;
    activeDocumentMousedownListeners: number;
    activeTriggerMousemoveListeners: number;
    closedDocumentMousedownListeners: number;
    closedTriggerMousemoveListeners: number;
    hoverOpened: boolean;
    cursorPositionChanged: boolean;
    touchOpened: boolean;
    touchDismissed: boolean;
    rapidOpenCloseStable: boolean;
    accessibleName: string | null;
  }>(`(async () => {
    const inspectListeners = getEventListeners;
    const portal = () => [...document.body.children].find((element) => element.getAttribute('role') === 'tooltip');
    const waitUntil = async (condition, timeout = 1500) => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        if (condition()) return true;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return false;
    };
    const trigger = document.querySelector('[aria-label="Watchlist users"] [aria-label="Viewer 1"]');
    if (!(trigger instanceof HTMLElement)) throw new Error('Missing focus tooltip trigger');
    const startedAt = performance.now();
    trigger.focus();
    const focusOpened = await waitUntil(() => Boolean(portal()));
    const openingLatencyMilliseconds = focusOpened ? performance.now() - startedAt : null;
    await waitUntil(() => (inspectListeners(trigger).mousemove?.length ?? 0) > 0);
    const activeDocumentMousedownListeners = inspectListeners(document).mousedown?.length ?? 0;
    const activeTriggerMousemoveListeners = inspectListeners(trigger).mousemove?.length ?? 0;
    trigger.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
    }));
    const focusClosedWithEscape = await waitUntil(() => !portal());
    const closedDocumentMousedownListeners = inspectListeners(document).mousedown?.length ?? 0;
    const closedTriggerMousemoveListeners = inspectListeners(trigger).mousemove?.length ?? 0;

    const hoverTrigger = document.querySelector('[aria-label="Watched"]');
    if (!(hoverTrigger instanceof HTMLElement)) throw new Error('Missing hover tooltip trigger');
    hoverTrigger.dispatchEvent(new PointerEvent('pointerover', {
      bubbles: true,
      clientX: 120,
      clientY: 160,
      pointerId: 1,
      pointerType: 'mouse',
    }));
    const hoverOpened = await waitUntil(() => Boolean(portal()));
    await waitUntil(() => Boolean(portal()?.style.transform));
    const initialTransform = portal()?.style.transform;
    hoverTrigger.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: 360,
      clientY: 260,
    }));
    const cursorPositionChanged = await waitUntil(
      () => Boolean(initialTransform && portal()?.style.transform !== initialTransform)
    );
    hoverTrigger.dispatchEvent(new PointerEvent('pointerout', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      relatedTarget: document.body,
    }));
    await waitUntil(() => !portal());

    hoverTrigger.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 2,
      pointerType: 'touch',
    }));
    const touchOpened = await waitUntil(() => Boolean(portal()));
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const touchDismissed = await waitUntil(() => !portal());

    for (let index = 0; index < 5; index += 1) {
      hoverTrigger.dispatchEvent(new PointerEvent('pointerover', {
        bubbles: true,
        pointerId: 10 + index,
        pointerType: 'mouse',
      }));
      hoverTrigger.dispatchEvent(new PointerEvent('pointerout', {
        bubbles: true,
        pointerId: 10 + index,
        pointerType: 'mouse',
        relatedTarget: document.body,
      }));
    }
    const rapidOpenCloseStable = await waitUntil(
      () =>
        !portal() &&
        (inspectListeners(document).mousedown?.length ?? 0) === 0 &&
        (inspectListeners(hoverTrigger).mousemove?.length ?? 0) === 0
    );

    return {
      focusOpened,
      focusClosedWithEscape,
      openingLatencyMilliseconds,
      activeDocumentMousedownListeners,
      activeTriggerMousemoveListeners,
      closedDocumentMousedownListeners,
      closedTriggerMousemoveListeners,
      hoverOpened,
      cursorPositionChanged,
      touchOpened,
      touchDismissed,
      rapidOpenCloseStable,
      accessibleName: trigger.getAttribute('aria-label'),
    };
  })()`);
  await cdp.send('HeapProfiler.collectGarbage');
  const snapshot = await cdp.evaluate<{
    domElements: number;
    rowCount: number;
    nodesPerCard: { minimum: number; maximum: number; mean: number };
    firstRowGeometry: {
      left: number;
      right: number;
      width: number;
      height: number;
    } | null;
    focusableElements: number;
    tooltipTriggers: number;
    documentMousedownListeners: number;
    externalServiceLinks: {
      label: string | null;
      svgElements: number;
      imageElements: number;
    }[];
    viewport: {
      innerWidth: number;
      clientWidth: number;
      scrollWidth: number;
      overflowPixels: number;
    };
    overflowElements: unknown[];
    stickyChrome: {
      container: { left: number; right: number; width: number } | null;
      header: { left: number; right: number; width: number } | null;
      footer: { left: number; right: number; width: number } | null;
    };
    longTasks: { duration: number; startTime: number }[];
    progressive: {
      firstBatchAt: number | null;
      allCardsAt: number | null;
      batches: { count: number; at: number }[];
      maximumYieldDelay: number;
    };
    layoutShifts: { value: number; hadRecentInput: boolean }[];
  }>(pageSnapshotExpression);
  const runtimeErrors = cdp.errors();
  const metrics = await performanceMetrics(cdp);
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`);
  return {
    size,
    width,
    run,
    ...snapshot,
    tooltipInteraction,
    runtimeErrors,
    longTaskEntries: snapshot.longTasks,
    longTasks: {
      count: snapshot.longTasks.length,
      totalMilliseconds: snapshot.longTasks.reduce(
        (sum, task) => sum + task.duration,
        0
      ),
      maximumMilliseconds: Math.max(
        0,
        ...snapshot.longTasks.map(({ duration }) => duration)
      ),
    },
    metrics,
  };
};

const measureColdPresentation = async (
  requestLog: string[],
  releaseColdPresentation: () => void
) => {
  const target = await createTarget('about:blank');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const requestStart = requestLog.length;
  const startedAt = performance.now();
  let phase = 'navigation';
  let initialMilliseconds = 0;
  let enrichedMilliseconds = 0;
  let snapshot: {
    rows: number;
    collectionBanners: number;
    localizedTitles: number;
    expanded: boolean;
    expandedSections: number;
    searchValue: string | null;
    locationSearch: string;
  };
  try {
    cdp.notify('Runtime.evaluate', {
      expression: `location.href = ${JSON.stringify(
        `http://127.0.0.1:${PROXY_PORT}/library?search=R11%20cold%20presentation&pageSize=25`
      )}`,
    });
    phase = 'canonical presentation';
    await waitFor(
      cdp,
      `document.body.innerText.includes('Canonical 1') && document.querySelectorAll('[data-testid^="library-library-row-"]').length === 25`
    );
    initialMilliseconds = performance.now() - startedAt;
    phase = 'state preparation';
    const expansionStarted = await cdp.evaluate<boolean>(`(() => {
      const row = document.querySelector('[data-testid="library-library-row-2"]');
      const button = row?.querySelector('button[aria-expanded="false"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert.equal(expansionStarted, true);
    await waitFor(
      cdp,
      `document.querySelectorAll('[data-testid="library-library-row-2"] section').length === 6`
    );
    releaseColdPresentation();
    phase = 'localized presentation';
    await waitFor(
      cdp,
      `document.body.innerText.includes('Localized Movie 1 with representative long title text')`
    );
    enrichedMilliseconds = performance.now() - startedAt;
    phase = 'snapshot';
    snapshot = await cdp.evaluate(`({
      rows: document.querySelectorAll('[data-testid^="library-library-row-"]').length,
      collectionBanners: document.querySelectorAll('[data-testid="library-collection-banner"]').length,
      localizedTitles: [...document.querySelectorAll('[data-testid^="library-library-row-"]')]
        .filter((row) => row.textContent?.includes('Localized ')).length,
      expanded: document.querySelector('[data-testid="library-library-row-2"] button[aria-expanded="true"]') !== null,
      expandedSections: document.querySelectorAll('[data-testid="library-library-row-2"] section').length,
      searchValue: document.querySelector('input[aria-label="Search Library"]')?.value ?? null,
      locationSearch: location.search,
    })`);
  } catch (error) {
    cdp.close();
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`).catch(
      () => undefined
    );
    throw new Error(
      `Cold presentation browser failure during ${phase}: ${
        error instanceof Error ? error.message : String(error)
      }\n${JSON.stringify(requestLog.slice(requestStart), null, 2)}`
    );
  }
  const runtimeErrors = cdp.errors();
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`);
  const requests = requestLog.slice(requestStart);
  return {
    initialMilliseconds: rounded(initialMilliseconds),
    enrichedMilliseconds: rounded(enrichedMilliseconds),
    ...snapshot,
    libraryRequests: requests.filter(
      (entry) =>
        entry.includes(' /api/v1/library?') && entry.includes('search=R11')
    ).length,
    statusRequests: requests.filter((entry) =>
      entry.includes(' /api/v1/library/presentation-status/')
    ).length,
    runtimeErrors,
  };
};

const measureLibraryDomAttribution = async () => {
  const target = await createTarget('about:blank');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  cdp.notify('Runtime.evaluate', {
    expression: `location.href = 'http://127.0.0.1:${PROXY_PORT}/library?pageSize=10'`,
  });
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid^="library-library-row-"]').length === 10`
  );
  await delay(700);

  const attributionExpression = `(() => {
    const stats = (root) => {
      if (!(root instanceof Element)) return null;
      const elements = [root, ...root.querySelectorAll('*')];
      const depth = (element) => {
        let value = 1;
        let cursor = element;
        while (cursor.parentElement && cursor !== root) {
          value += 1;
          cursor = cursor.parentElement;
        }
        return value;
      };
      const tooltipTriggers = elements.filter((element) => {
        const listeners = getEventListeners(element);
        return listeners.mouseenter?.length && listeners.mouseleave?.length && listeners.mousemove?.length;
      });
      const cssHiddenMounted = elements.filter((element) => {
        const style = getComputedStyle(element);
        return element.hidden || style.display === 'none' || style.visibility === 'hidden';
      });
      const ariaHiddenElements = elements.filter((element) => element.getAttribute('aria-hidden') === 'true');
      const redundantWrapperCandidates = elements.filter((element) => {
        if (!['DIV', 'SPAN'].includes(element.tagName) || element.children.length !== 1) return false;
        if ([...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())) return false;
        if (['id', 'role', 'tabindex', 'aria-label', 'aria-labelledby', 'aria-describedby', 'data-testid'].some((name) => element.hasAttribute(name))) return false;
        const listeners = getEventListeners(element);
        return !listeners.click?.length && !listeners.keydown?.length && !listeners.focus?.length;
      });
      return {
        elements: elements.length,
        maximumDepth: Math.max(...elements.map(depth)),
        svgElements: elements.filter((element) => element.tagName === 'svg').length,
        tooltipTriggers: tooltipTriggers.length,
        cssHiddenMounted: cssHiddenMounted.length,
        ariaHiddenElements: ariaHiddenElements.length,
        interactiveElements: root.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length,
        labelledElements: root.querySelectorAll('[aria-label],[aria-labelledby]').length,
        describedElements: root.querySelectorAll('[aria-describedby]').length,
        redundantWrapperCandidates: redundantWrapperCandidates.length,
      };
    };
    const card = (id) => {
      const row = document.querySelector('[data-testid="library-library-row-' + id + '"]');
      if (!(row instanceof HTMLElement)) return null;
      const main = [...row.children].find((child) => child.classList.contains('grid') && child.classList.contains('p-4'));
      const tracks = main ? [...main.children] : [];
      const metadataAndCollection = tracks[3];
      return {
        card: stats(row),
        identityAndArtwork: stats(tracks[0]),
        engagement: stats(tracks[1]),
        ratingAndResolution: stats(tracks[2]),
        metadataAndCollection: stats(metadataAndCollection),
        metadata: stats(metadataAndCollection?.firstElementChild),
        collection: stats(row.querySelector('[data-testid="library-collection-banner"]')),
        actionsAndExternalLinks: stats(tracks[4]),
        expandedSeasons: stats([...row.children].find((child) => child.querySelector('section'))),
      };
    };
    return {
      movie: card(1),
      movieWithCollection: card(5),
      series: card(2),
      mountedTooltipPortals: [...document.body.children].filter((element) => element.classList.contains('z-50') && element.classList.contains('text-sm')).length,
    };
  })()`;

  const collapsed = await cdp.evaluate<Record<string, unknown>>(
    attributionExpression
  );
  const expanded = await cdp.evaluate<boolean>(`(() => {
    const row = document.querySelector('[data-testid="library-library-row-2"]');
    const button = row?.querySelector('button[aria-expanded="false"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(expanded, true, 'The representative Series could not expand');
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="library-library-row-2"] section').length === 6`
  );
  await delay(350);
  const expandedSeries = await cdp.evaluate<Record<string, unknown>>(
    attributionExpression
  );
  const runtimeErrors = cdp.errors();
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`);
  return { collapsed, expandedSeries, runtimeErrors };
};

interface ScrollListenerSnapshot {
  operations: {
    add: { scroll: number; resize: number };
    remove: { scroll: number; resize: number };
  };
  native: { scroll: number; resize: number };
}

const measureScrollHook = async (requestLog: string[]) => {
  const target = await createTarget('about:blank');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 900,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      globalThis.__r11ListenerOps = { add: { scroll: 0, resize: 0 }, remove: { scroll: 0, resize: 0 } };
      const originalAdd = EventTarget.prototype.addEventListener;
      const originalRemove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function(type, ...args) {
        if (this === window && (type === 'scroll' || type === 'resize')) globalThis.__r11ListenerOps.add[type]++;
        return originalAdd.call(this, type, ...args);
      };
      EventTarget.prototype.removeEventListener = function(type, ...args) {
        if (this === window && (type === 'scroll' || type === 'resize')) globalThis.__r11ListenerOps.remove[type]++;
        return originalRemove.call(this, type, ...args);
      };
    `,
  });
  cdp.notify('Runtime.evaluate', {
    expression: `location.href = 'http://127.0.0.1:${PROXY_PORT}/discover/watchlist'`,
  });
  await delay(250);
  await waitFor(
    cdp,
    `document.querySelectorAll('.cards-vertical > li').length >= 60`
  );
  await delay(500);
  const listenerSnapshot = `({
    operations: structuredClone(globalThis.__r11ListenerOps),
    native: {
      scroll: getEventListeners(window).scroll?.length ?? 0,
      resize: getEventListeners(window).resize?.length ?? 0,
    }
  })`;
  const watchlistRequestCount = () =>
    requestLog.filter((entry) => entry.includes(' /api/v1/discover/watchlist'))
      .length;
  const beforeRequests = watchlistRequestCount();
  const before = await cdp.evaluate<ScrollListenerSnapshot>(listenerSnapshot);
  await cdp.evaluate(`(async () => {
    for (let index = 0; index < 5; index += 1) {
      window.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
    return true;
  })()`);
  const afterScroll =
    await cdp.evaluate<ScrollListenerSnapshot>(listenerSnapshot);
  const afterScrollRequests = watchlistRequestCount();
  await cdp.evaluate(`window.dispatchEvent(new Event('scroll')); true`);
  await cdp.evaluate(`void next.router.push('/library?pageSize=10'); true`);
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid^="library-library-row-"]').length === 10`
  );
  await delay(250);
  const afterUnmount =
    await cdp.evaluate<ScrollListenerSnapshot>(listenerSnapshot);
  const afterUnmountRequests = watchlistRequestCount();
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`);
  return {
    before,
    afterScroll,
    afterUnmount,
    watchlistRequests: {
      before: beforeRequests,
      afterScroll: afterScrollRequests,
      afterUnmount: afterUnmountRequests,
    },
  };
};

const measureSharedTooltipCleanup = async () => {
  const target = await createTarget('about:blank');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable')]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  cdp.notify('Runtime.evaluate', {
    expression: `location.href = 'http://127.0.0.1:${PROXY_PORT}/discover/watchlist?owner=all'`,
  });
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid="title-card"]').length >= 1`
  );
  const watchlist = await cdp.evaluate<{
    opened: boolean;
    documentListeners: number;
    labelled: boolean;
  }>(`(async () => {
    const inspectListeners = getEventListeners;
    const waitUntil = async (condition) => {
      const deadline = performance.now() + 1500;
      while (performance.now() < deadline) {
        if (condition()) return true;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return false;
    };
    const trigger = document.querySelector('[data-testid="title-card-owner-region"] [aria-label]');
    if (!(trigger instanceof HTMLElement)) throw new Error('Missing Watchlist owner tooltip');
    trigger.focus();
    const opened = await waitUntil(() => Boolean(document.querySelector('[role="tooltip"]')));
    return {
      opened,
      documentListeners: inspectListeners(document).mousedown?.length ?? 0,
      labelled: Boolean(trigger.getAttribute('aria-label')),
    };
  })()`);
  await cdp.evaluate(`void next.router.push('/library?pageSize=10'); true`);
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid^="library-library-row-"]').length === 10`
  );
  await delay(100);
  const afterUnmount = await cdp.evaluate<{
    documentListeners: number;
    mountedTooltips: number;
  }>(`({
    documentListeners: getEventListeners(document).mousedown?.length ?? 0,
    mountedTooltips: document.querySelectorAll('[role="tooltip"]').length,
  })`);
  const runtimeErrors = cdp.errors();
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`);
  return { watchlist, afterUnmount, runtimeErrors };
};

const measureCrossPageCycles = async () => {
  const target = await createTarget('about:blank');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Performance.enable'),
    cdp.send('HeapProfiler.enable'),
  ]);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: listenerTrackerSource,
  });
  const routes = [
    {
      name: 'library',
      path: '/library?pageSize=25',
      ready: `document.querySelectorAll('[data-testid^="library-library-row-"]').length === 25`,
    },
    {
      name: 'watchlist',
      path: '/discover/watchlist?owner=all',
      ready: `document.querySelectorAll('.cards-vertical > li').length >= 60`,
    },
    {
      name: 'leaving-soon',
      path: '/leaving-soon',
      ready: `document.querySelectorAll('.leaving-soon-card').length === 4`,
    },
    {
      name: 'fresh',
      path: '/fresh',
      ready: `document.querySelectorAll('.cards-vertical > li').length === 8`,
    },
    {
      name: 'requests',
      path: '/requests',
      ready: `document.body.innerText.includes('Requests') && !document.querySelector('[data-testid="loading-spinner"]')`,
    },
  ] as const;
  const samples: Record<string, unknown>[] = [];
  let applicationMounted = false;
  const focusInteractions = !process.argv.includes('--r11f-no-focus');
  const widths = process.argv.includes('--r11f-no-focus')
    ? [1440]
    : [390, 900, 1440];
  for (const width of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: width === 390 ? 844 : 900,
      deviceScaleFactor: 1,
      mobile: width === 390,
    });
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      for (const route of routes) {
        if (applicationMounted) {
          await cdp.evaluate(
            `next.router.push(${JSON.stringify(route.path)}).then(() => true)`
          );
        } else {
          cdp.notify('Runtime.evaluate', {
            expression: `location.href = ${JSON.stringify(
              `http://127.0.0.1:${PROXY_PORT}${route.path}`
            )}`,
          });
          applicationMounted = true;
        }
        try {
          await waitFor(cdp, route.ready);
        } catch (error) {
          const diagnostic = await cdp.evaluate(`({
            route: location.pathname + location.search,
            titleCards: document.querySelectorAll('[data-testid="title-card"]').length,
            libraryRows: document.querySelectorAll('[data-testid^="library-library-row-"]').length,
            leavingSoonCards: document.querySelectorAll('.leaving-soon-card').length,
            body: document.body.innerText.slice(0, 500),
          })`);
          throw new Error(
            `${route.name}: ${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(diagnostic)}`
          );
        }
        await delay(250);
        await cdp.send('HeapProfiler.collectGarbage');
        const metrics = await performanceMetrics(cdp);
        const page = await cdp.evaluate<{
          domElements: number;
          focusableElements: number;
          tooltipPortals: number;
          documentMousedownListeners: number;
          windowScrollListeners: number;
          windowResizeListeners: number;
          overflowPixels: number;
          keyboardFocusEstablished: boolean | null;
          listenerAudit: {
            active: Record<string, number>;
            added: Record<string, number>;
            removed: Record<string, number>;
          } | null;
          liveListenerAudit: {
            total: number;
            byType: Record<string, number>;
            byTarget: Record<string, number>;
            bodyClickSources: { source: string; count: number }[];
          };
        }>(`(async () => {
          const inspectListeners = getEventListeners;
          const first = [...document.querySelectorAll('a[href], button:not([disabled]), input, select')]
            .find((element) => element instanceof HTMLElement && element.offsetParent !== null && element.tabIndex >= 0);
          if (${focusInteractions} && first instanceof HTMLElement) first.focus();
          const keyboardFocusEstablished = document.activeElement === first;
          if (${focusInteractions} && first instanceof HTMLElement) {
            first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            first.blur();
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }
          const liveByType = {};
          const liveByTarget = {};
          let liveTotal = 0;
          const liveTargets = [window, document, ...document.querySelectorAll('*')];
          for (const target of liveTargets) {
            const targetName = target === window
              ? 'Window'
              : target === document
                ? 'Document'
                : 'Element:' + target.tagName.toLowerCase();
            for (const [type, listeners] of Object.entries(inspectListeners(target))) {
              liveByType[type] = (liveByType[type] ?? 0) + listeners.length;
              liveByTarget[targetName] = (liveByTarget[targetName] ?? 0) + listeners.length;
              liveTotal += listeners.length;
            }
          }
          const bodyClickSourceCounts = {};
          for (const entry of inspectListeners(document.body).click ?? []) {
            const source = String(entry.listener)
              .replace(/\\s+/g, ' ')
              .slice(0, 300);
            bodyClickSourceCounts[source] = (bodyClickSourceCounts[source] ?? 0) + 1;
          }
          return {
            domElements: document.querySelectorAll('*').length,
            focusableElements: document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])').length,
            tooltipPortals: document.querySelectorAll('[role="tooltip"]').length,
            documentMousedownListeners: inspectListeners(document).mousedown?.length ?? 0,
            windowScrollListeners: inspectListeners(window).scroll?.length ?? 0,
            windowResizeListeners: inspectListeners(window).resize?.length ?? 0,
            overflowPixels: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
            keyboardFocusEstablished: ${focusInteractions}
              ? keyboardFocusEstablished
              : null,
            listenerAudit: globalThis.__r11ListenerTracker?.snapshot() ?? null,
            liveListenerAudit: {
              total: liveTotal,
              byType: liveByType,
              byTarget: liveByTarget,
              bodyClickSources: Object.entries(bodyClickSourceCounts)
                .map(([source, count]) => ({ source, count }))
                .sort((left, right) => right.count - left.count),
            },
          };
        })()`);
        samples.push({ width, cycle, page: route.name, ...page, metrics });
      }
    }
  }
  const runtimeErrors = cdp.errors();
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`);
  return { samples, runtimeErrors };
};

const measureLibraryInteractions = async (requestLog: string[]) => {
  const target = await createTarget('about:blank');
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Performance.enable'),
  ]);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      globalThis.__r11LongTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            globalThis.__r11LongTasks.push({ duration: entry.duration, startTime: entry.startTime });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
    `,
  });
  cdp.notify('Runtime.evaluate', {
    expression: `location.href = 'http://127.0.0.1:${PROXY_PORT}/library?pageSize=100'`,
  });
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid^="library-library-row-"]').length >= 5 && document.querySelector('[data-library-mounted-count]')?.getAttribute('aria-busy') === 'true'`
  );
  const progressiveInteraction = await cdp.evaluate<{
    mountedBefore: number;
    mountedAfter: number;
    selectionLatencyMilliseconds: number;
    selected: boolean;
  }>(`(async () => {
    const checkbox = document.querySelector('[data-testid="library-library-row-1"] input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing progressive selection checkbox');
    globalThis.__r11FirstProgressiveRow = checkbox.closest('[data-testid^="library-library-row-"]');
    const mountedBefore = document.querySelectorAll('[data-testid^="library-library-row-"]').length;
    const startedAt = performance.now();
    checkbox.focus();
    checkbox.click();
    while (document.querySelector('[data-testid="library-selection-count"]')?.textContent?.trim() !== '1') {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const selectionLatencyMilliseconds = performance.now() - startedAt;
    const mountedAfter = document.querySelectorAll('[data-testid^="library-library-row-"]').length;
    document.querySelector('[data-testid="library-library-row-1"] input[type="checkbox"]')?.click();
    while (document.querySelector('[data-testid="library-selection-count"]')?.textContent?.trim() !== '0') {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return {
      mountedBefore,
      mountedAfter,
      selectionLatencyMilliseconds,
      selected: true,
    };
  })()`);
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-testid^="library-library-row-"]').length === 100`
  );
  const progressiveContinuity = await cdp.evaluate<{
    sameFirstRow: boolean;
    focusPreserved: boolean;
    busyAfterCompletion: boolean;
  }>(`({
    sameFirstRow:
      globalThis.__r11FirstProgressiveRow ===
      document.querySelector('[data-testid="library-library-row-1"]'),
    focusPreserved:
      document.activeElement ===
      document.querySelector('[data-testid="library-library-row-1"] input[type="checkbox"]'),
    busyAfterCompletion:
      document.querySelector('[data-library-mounted-count]')?.getAttribute('aria-busy') === 'true',
  })`);
  await delay(700);

  const operations: Record<string, unknown>[] = [];
  const run = async (
    name: string,
    action: string,
    settled: string,
    settleDelay = 250
  ) => {
    await cdp.evaluate(`globalThis.__r11LongTasks = []; true`);
    const before = await performanceMetrics(cdp);
    const requestStart = requestLog.length;
    const startedAt = performance.now();
    const activated = await cdp.evaluate<boolean>(action);
    assert.equal(activated, true, `${name} did not activate`);
    await waitFor(cdp, settled);
    await delay(settleDelay);
    const after = await performanceMetrics(cdp);
    const longTasks = await cdp.evaluate<{ duration: number }[]>(
      `globalThis.__r11LongTasks`
    );
    const delta = Object.fromEntries(
      [...metricNames].map((metric) => [
        metric,
        rounded((after[metric] ?? 0) - (before[metric] ?? 0)),
      ])
    );
    operations.push({
      name,
      wallMilliseconds: rounded(performance.now() - startedAt),
      apiRequests: requestLog
        .slice(requestStart)
        .filter((entry) => entry.includes(' /api/v1/library?')).length,
      delta,
      longTasks: {
        count: longTasks.length,
        totalMilliseconds: rounded(
          longTasks.reduce((sum, task) => sum + task.duration, 0)
        ),
        maximumMilliseconds: rounded(
          Math.max(0, ...longTasks.map(({ duration }) => duration))
        ),
      },
    });
  };

  await run(
    'select-one',
    `(() => {
      const checkbox = document.querySelector('[data-testid="library-library-row-1"] input[type="checkbox"]');
      if (!(checkbox instanceof HTMLInputElement)) return false;
      checkbox.click();
      return true;
    })()`,
    `document.querySelector('[data-testid="library-library-row-1"] input[type="checkbox"]')?.checked === true`
  );
  await run(
    'expand-series',
    `(() => {
      const button = document.querySelector('[data-testid="library-library-row-2"] button[aria-expanded="false"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
    `document.querySelectorAll('[data-testid="library-library-row-2"] section').length === 6`,
    350
  );
  await run(
    'collapse-series',
    `(() => {
      const button = document.querySelector('[data-testid="library-library-row-2"] button[aria-expanded="true"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
    `document.querySelectorAll('[data-testid="library-library-row-2"] section').length === 0`
  );
  await run(
    'sort-revalidation',
    `(() => {
      const select = document.querySelector('select[aria-label="Sort"]');
      if (!(select instanceof HTMLSelectElement)) return false;
      select.value = select.value === 'title.asc' ? 'added.desc' : 'title.asc';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    `location.search.includes('sort=') && document.querySelector('[data-library-mounted-count]')?.getAttribute('aria-busy') === 'true'`,
    0
  );
  await run(
    'search-revalidation',
    `(() => {
      const input = document.querySelector('input[aria-label="Search Library"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'R11 interaction');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
    `location.search.includes('search=R11') && document.querySelectorAll('[data-testid^="library-library-row-"]').length === 100`,
    700
  );
  await run(
    'page-size-replacement',
    `(() => {
      const select = document.querySelector('select[aria-label="Items per page"]');
      if (!(select instanceof HTMLSelectElement)) return false;
      select.value = '50';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    `document.querySelectorAll('[data-testid^="library-library-row-"]').length === 50`,
    500
  );

  const stableSelection = await cdp.evaluate<boolean>(
    `document.querySelector('[data-testid="library-library-row-1"] input[type="checkbox"]')?.checked === true`
  );
  const navigationDuringMount = await cdp.evaluate<{
    mountedBeforeNavigation: number;
    path: string;
    remainingLibraryRows: number;
  }>(`(async () => {
    const select = document.querySelector('select[aria-label="Items per page"]');
    if (!(select instanceof HTMLSelectElement)) throw new Error('Missing page-size selector');
    select.value = '100';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    const deadline = performance.now() + 2000;
    while (
      document.querySelector('[data-library-mounted-count]')?.getAttribute('aria-busy') !== 'true' &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const mountedBeforeNavigation = document.querySelectorAll('[data-testid^="library-library-row-"]').length;
    await next.router.push('/requests');
    await new Promise((resolve) => setTimeout(resolve, 500));
    return {
      mountedBeforeNavigation,
      path: location.pathname,
      remainingLibraryRows: document.querySelectorAll('[data-testid^="library-library-row-"]').length,
    };
  })()`);

  const runtimeErrors = cdp.errors();
  cdp.close();
  await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${target.id}`);
  return {
    progressiveInteraction,
    progressiveContinuity,
    operations,
    stableSelection,
    navigationDuringMount,
    runtimeErrors,
  };
};

const assertTooltipMeasurements = (
  library: Awaited<ReturnType<typeof measureLibrary>>[]
) => {
  library.forEach(
    ({
      rowCount,
      size,
      tooltipInteraction,
      tooltipTriggers,
      documentMousedownListeners,
      externalServiceLinks,
      runtimeErrors,
    }) => {
      assert.equal(rowCount, size);
      assert.equal(tooltipTriggers, 0);
      assert.ok(
        documentMousedownListeners <=
          R11_PERFORMANCE_TARGETS.browser.maximumDocumentTooltipListenersClosed
      );
      assert.equal(tooltipInteraction.focusOpened, true, 'focus opens tooltip');
      assert.equal(
        tooltipInteraction.focusClosedWithEscape,
        true,
        'Escape closes focused tooltip'
      );
      assert.equal(
        tooltipInteraction.hoverOpened,
        true,
        'pointer opens tooltip'
      );
      assert.equal(
        tooltipInteraction.cursorPositionChanged,
        true,
        'active tooltip follows cursor'
      );
      assert.equal(tooltipInteraction.touchOpened, true, 'touch opens tooltip');
      assert.equal(
        tooltipInteraction.touchDismissed,
        true,
        'outside press dismisses touch tooltip'
      );
      assert.equal(
        tooltipInteraction.rapidOpenCloseStable,
        true,
        'rapid open/close releases tooltip resources'
      );
      assert.equal(tooltipInteraction.accessibleName, 'Viewer 1');
      assert.ok(tooltipInteraction.activeDocumentMousedownListeners >= 1);
      assert.equal(tooltipInteraction.closedDocumentMousedownListeners, 0);
      assert.ok(tooltipInteraction.activeTriggerMousemoveListeners >= 1);
      assert.equal(tooltipInteraction.closedTriggerMousemoveListeners, 0);
      assert.equal(externalServiceLinks.length, size * 2);
      externalServiceLinks.forEach(({ label, svgElements, imageElements }) => {
        assert.match(label ?? '', /^(Radarr|Sonarr)( 4K)?$/);
        assert.equal(svgElements, 1);
        assert.equal(imageElements, 0);
      });
      assert.deepEqual(runtimeErrors, []);
    }
  );
};

const summarizeTooltipMeasurements = (
  library: Awaited<ReturnType<typeof measureLibrary>>[]
) =>
  R11_PAGE_SIZES.map((size) => {
    const samples = library.filter((entry) => entry.size === size);
    const average = (values: number[]) =>
      rounded(values.reduce((sum, value) => sum + value, 0) / values.length);
    const maximum = (values: number[]) => Math.max(...values);
    const heapBytes = average(
      samples.map(({ metrics }) => metrics.JSHeapUsedSize ?? 0)
    );
    const firstBatchAt = average(
      samples.map(({ progressive }) => progressive.firstBatchAt ?? 0)
    );
    const allCardsAt = average(
      samples.map(({ progressive }) => progressive.allCardsAt ?? 0)
    );
    const longTaskMaximumMilliseconds = maximum(
      samples.map(({ longTasks }) => longTasks.maximumMilliseconds)
    );
    const longTaskTotalMilliseconds = average(
      samples.map(({ longTasks }) => longTasks.totalMilliseconds)
    );
    return {
      cardCount: size,
      domElements: samples[0]?.domElements ?? 0,
      focusableElements: samples[0]?.focusableElements ?? 0,
      closedTooltipDocumentListeners:
        samples[0]?.documentMousedownListeners ?? 0,
      closedTooltipMousemoveTriggers: samples[0]?.tooltipTriggers ?? 0,
      totalJavaScriptListeners: average(
        samples.map(({ metrics }) => metrics.JSEventListeners ?? 0)
      ),
      heapAfterGarbageCollectionBytes: heapBytes,
      heapAfterGarbageCollectionMiB: rounded(heapBytes / 1024 / 1024),
      firstBatchVisibleMilliseconds: firstBatchAt,
      allCardsMountedMilliseconds: allCardsAt,
      progressiveMountDurationMilliseconds: rounded(allCardsAt - firstBatchAt),
      maximumYieldDelayMilliseconds: maximum(
        samples.map(({ progressive }) => progressive.maximumYieldDelay)
      ),
      cumulativeLayoutShift: average(
        samples.map(({ layoutShifts }) =>
          layoutShifts
            .filter(({ hadRecentInput }) => !hadRecentInput)
            .reduce((sum, { value }) => sum + value, 0)
        )
      ),
      mountedBatchCounts: samples[0]?.progressive.batches.map(
        ({ count }) => count
      ),
      longTaskMaximumMilliseconds,
      longTaskTotalMilliseconds,
      scriptDurationSeconds: average(
        samples.map(({ metrics }) => metrics.ScriptDuration ?? 0)
      ),
      tooltipOpeningLatencyMilliseconds: average(
        samples.map(
          ({ tooltipInteraction }) =>
            tooltipInteraction.openingLatencyMilliseconds ?? 0
        )
      ),
      targets: {
        maximumLongTaskMilliseconds:
          R11_PERFORMANCE_TARGETS.browser.maximumLongTaskMillisecondsAt100Cards,
        maximumTotalLongTaskMilliseconds:
          R11_PERFORMANCE_TARGETS.browser
            .maximumTotalLongTaskMillisecondsAt100Cards,
      },
      meetsLongTaskTargets:
        size !== 100 ||
        (longTaskMaximumMilliseconds <=
          R11_PERFORMANCE_TARGETS.browser
            .maximumLongTaskMillisecondsAt100Cards &&
          longTaskTotalMilliseconds <=
            R11_PERFORMANCE_TARGETS.browser
              .maximumTotalLongTaskMillisecondsAt100Cards),
    };
  });

const assertR11DMeasurements = (
  responsive: Awaited<ReturnType<typeof measureLibrary>>[],
  scrollHook: Awaited<ReturnType<typeof measureScrollHook>>
) => {
  responsive.forEach(({ runtimeErrors, viewport, stickyChrome }) => {
    assert.deepEqual(runtimeErrors, []);
    assert.equal(viewport.overflowPixels, 0);
    assert.ok(stickyChrome.container);
    assert.deepEqual(stickyChrome.header, stickyChrome.container);
    assert.deepEqual(stickyChrome.footer, stickyChrome.container);
  });
  assert.deepEqual(scrollHook.afterScroll, scrollHook.before);
  assert.equal(
    scrollHook.afterUnmount.operations.add.scroll,
    scrollHook.afterScroll.operations.add.scroll
  );
  assert.equal(
    scrollHook.afterUnmount.operations.add.resize,
    scrollHook.afterScroll.operations.add.resize
  );
  assert.equal(
    scrollHook.afterUnmount.operations.remove.scroll,
    scrollHook.afterScroll.operations.remove.scroll + 1
  );
  assert.equal(
    scrollHook.afterUnmount.operations.remove.resize,
    scrollHook.afterScroll.operations.remove.resize + 1
  );
  assert.equal(
    scrollHook.afterUnmount.native.scroll,
    scrollHook.afterScroll.native.scroll - 1
  );
  assert.equal(
    scrollHook.afterUnmount.native.resize,
    scrollHook.afterScroll.native.resize - 1
  );
  assert.equal(
    scrollHook.watchlistRequests.afterScroll,
    scrollHook.watchlistRequests.before
  );
  assert.equal(
    scrollHook.watchlistRequests.afterUnmount,
    scrollHook.watchlistRequests.before
  );
};

const closeServer = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose()))
  );

const stopChild = async (child: ChildProcess | undefined) => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    delay(5_000),
  ]);
};

const outputPath = () => {
  const index = process.argv.indexOf('--output');
  return index >= 0 && process.argv[index + 1]
    ? resolve(process.argv[index + 1])
    : undefined;
};

const main = async () => {
  for (const port of [PROXY_PORT, DEBUG_PORT]) {
    if (await portIsOpen(port)) {
      throw new Error(
        `R11 benchmark refuses to reuse occupied local port ${port}`
      );
    }
  }
  const requestLog: string[] = [];
  const profile = await mkdtemp(join(tmpdir(), 'seerr-r11-chrome-'));
  const buildPrecondition = await assertSupportedProductionBuild();
  let chromeProcess: ChildProcess | undefined;
  let mockApp: Awaited<ReturnType<typeof startMockApp>> | undefined;
  try {
    mockApp = await startMockApp(requestLog);
    await waitForHttp(`http://127.0.0.1:${PROXY_PORT}/api/v1/settings/public`);
    chromeProcess = await startChrome(profile);
    if (process.argv.includes('--r11f-interactions-only')) {
      const libraryInteractions = await measureLibraryInteractions(requestLog);
      assert.deepEqual(libraryInteractions.runtimeErrors, []);
      const unmocked = requestLog.filter((entry) =>
        entry.startsWith('UNMOCKED ')
      );
      assert.deepEqual(unmocked, []);
      const result = {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        authority: 'supported-production-turbopack',
        buildPrecondition,
        libraryInteractions,
      };
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      const destination = outputPath();
      if (destination) await writeFile(destination, serialized, 'utf8');
      process.stdout.write(serialized);
      return;
    }
    if (process.argv.includes('--r11f-cross-page-only')) {
      const crossPage = await measureCrossPageCycles();
      assert.deepEqual(crossPage.runtimeErrors, []);
      const crossPageFailures = crossPage.samples.filter(
        (sample) =>
          sample.overflowPixels !== 0 ||
          sample.tooltipPortals !== 0 ||
          sample.documentMousedownListeners !== 0
      );
      assert.deepEqual(crossPageFailures, []);
      const unmocked = requestLog.filter((entry) =>
        entry.startsWith('UNMOCKED ')
      );
      assert.equal(unmocked.length, 0);
      const result = {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        authority: 'supported-production-turbopack',
        buildPrecondition,
        crossPage,
      };
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      const destination = outputPath();
      if (destination) await writeFile(destination, serialized, 'utf8');
      process.stdout.write(serialized);
      return;
    }
    if (process.argv.includes('--cold-presentation-only')) {
      const coldPresentation = await measureColdPresentation(
        requestLog,
        mockApp.releaseColdPresentation
      );
      assert.equal(coldPresentation.rows, 25);
      assert.equal(coldPresentation.localizedTitles, 25);
      assert.ok(coldPresentation.collectionBanners > 0);
      assert.equal(coldPresentation.libraryRequests, 2);
      assert.equal(coldPresentation.statusRequests, 1);
      assert.equal(coldPresentation.expanded, true);
      assert.equal(coldPresentation.expandedSections, 6);
      assert.equal(coldPresentation.searchValue, 'R11 cold presentation');
      assert.match(coldPresentation.locationSearch, /search=R11/);
      assert.deepEqual(coldPresentation.runtimeErrors, []);
      const unmocked = requestLog.filter((entry) =>
        entry.startsWith('UNMOCKED ')
      );
      assert.equal(unmocked.length, 0);
      const result = {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        authority: 'supported-production-turbopack',
        buildPrecondition,
        coldPresentation,
      };
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      const destination = outputPath();
      if (destination) await writeFile(destination, serialized, 'utf8');
      process.stdout.write(serialized);
      return;
    }
    if (process.argv.includes('--r11d-only')) {
      const responsive = [];
      for (const width of R11_VIEWPORT_WIDTHS) {
        responsive.push(await measureLibrary(25, width, 1));
      }
      const scrollHook = await measureScrollHook(requestLog);
      assertR11DMeasurements(responsive, scrollHook);
      const unmocked = requestLog.filter((entry) =>
        entry.startsWith('UNMOCKED ')
      );
      assert.equal(unmocked.length, 0);
      const result = {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        authority: 'supported-production-turbopack',
        buildPrecondition,
        responsive: responsive.map((entry) => ({
          width: entry.width,
          clientWidth: entry.viewport.clientWidth,
          scrollWidth: entry.viewport.scrollWidth,
          overflowPixels: entry.viewport.overflowPixels,
          overflowElements: entry.overflowElements,
          stickyChrome: entry.stickyChrome,
        })),
        scrollHook,
      };
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      const destination = outputPath();
      if (destination) await writeFile(destination, serialized, 'utf8');
      process.stdout.write(serialized);
      return;
    }
    if (process.argv.includes('--r11g-library-only')) {
      const library = [];
      const smoke = process.argv.includes('--r11g-smoke');
      const sizes = smoke ? [100] : R11_PAGE_SIZES;
      const repetitions = smoke ? 1 : R11_BROWSER_REPETITIONS;
      for (const size of sizes) {
        for (let run = 1; run <= repetitions; run += 1) {
          library.push(await measureLibrary(size, 1440, run));
        }
      }
      assertTooltipMeasurements(library);
      const unmocked = requestLog.filter((entry) =>
        entry.startsWith('UNMOCKED ')
      );
      assert.equal(unmocked.length, 0);
      const result = {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        authority: 'supported-production-turbopack',
        buildPrecondition,
        summary: summarizeTooltipMeasurements(library),
        library,
      };
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      const destination = outputPath();
      if (destination) await writeFile(destination, serialized, 'utf8');
      process.stdout.write(serialized);
      return;
    }
    if (process.argv.includes('--r11e-only')) {
      const library = [];
      const smoke = process.argv.includes('--r11e-smoke');
      const sizes = smoke ? [R11_PAGE_SIZES[0]] : R11_PAGE_SIZES;
      const repetitions = smoke ? 1 : R11_BROWSER_REPETITIONS;
      for (const size of sizes) {
        for (let run = 1; run <= repetitions; run += 1) {
          library.push(await measureLibrary(size, 1440, run));
        }
      }
      if (smoke) {
        process.stdout.write(
          `${JSON.stringify(library[0]?.tooltipInteraction, null, 2)}\n`
        );
      }
      assertTooltipMeasurements(library);
      if (smoke) {
        const sharedCleanup = await measureSharedTooltipCleanup();
        process.stdout.write(`${JSON.stringify(sharedCleanup, null, 2)}\n`);
        assert.equal(sharedCleanup.watchlist.opened, true);
        assert.equal(sharedCleanup.watchlist.labelled, true);
        assert.deepEqual(sharedCleanup.afterUnmount, {
          documentListeners: 0,
          mountedTooltips: 0,
        });
        assert.deepEqual(sharedCleanup.runtimeErrors, []);
        return;
      }
      const responsive = [];
      for (const width of R11_VIEWPORT_WIDTHS) {
        responsive.push(await measureLibrary(25, width, 1));
      }
      assertTooltipMeasurements(responsive);
      const sharedCleanup = await measureSharedTooltipCleanup();
      assert.equal(sharedCleanup.watchlist.opened, true);
      assert.equal(sharedCleanup.watchlist.labelled, true);
      assert.ok(sharedCleanup.watchlist.documentListeners >= 1);
      assert.deepEqual(sharedCleanup.afterUnmount, {
        documentListeners: 0,
        mountedTooltips: 0,
      });
      assert.deepEqual(sharedCleanup.runtimeErrors, []);
      const unmocked = requestLog.filter((entry) =>
        entry.startsWith('UNMOCKED ')
      );
      assert.equal(unmocked.length, 0);
      const result = {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        authority: 'supported-production-turbopack',
        buildPrecondition,
        summary: summarizeTooltipMeasurements(library),
        library,
        responsive: responsive.map((entry) => ({
          width: entry.width,
          tooltipInteraction: entry.tooltipInteraction,
          documentMousedownListeners: entry.documentMousedownListeners,
          tooltipTriggers: entry.tooltipTriggers,
          overflowPixels: entry.viewport.overflowPixels,
          runtimeErrors: entry.runtimeErrors,
        })),
        sharedCleanup,
      };
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      const destination = outputPath();
      if (destination) await writeFile(destination, serialized, 'utf8');
      process.stdout.write(serialized);
      return;
    }
    const library = [];
    for (const size of R11_PAGE_SIZES) {
      for (let run = 1; run <= R11_BROWSER_REPETITIONS; run += 1) {
        library.push(await measureLibrary(size, 1440, run));
      }
    }
    const responsive = [];
    for (const width of R11_VIEWPORT_WIDTHS) {
      responsive.push(await measureLibrary(25, width, 1));
    }
    const coldPresentation = await measureColdPresentation(
      requestLog,
      mockApp.releaseColdPresentation
    );
    const domAttribution = await measureLibraryDomAttribution();
    const scrollHook = await measureScrollHook(requestLog);
    assertTooltipMeasurements(library);
    assertR11DMeasurements(responsive, scrollHook);
    assert.equal(coldPresentation.rows, 25);
    assert.equal(coldPresentation.localizedTitles, 25);
    assert.ok(coldPresentation.collectionBanners > 0);
    assert.equal(coldPresentation.libraryRequests, 2);
    assert.equal(coldPresentation.statusRequests, 1);
    assert.equal(coldPresentation.expanded, true);
    assert.equal(coldPresentation.expandedSections, 6);
    assert.equal(coldPresentation.searchValue, 'R11 cold presentation');
    assert.match(coldPresentation.locationSearch, /search=R11/);
    assert.deepEqual(coldPresentation.runtimeErrors, []);
    assert.deepEqual(domAttribution.runtimeErrors, []);
    const unmocked = requestLog.filter((entry) =>
      entry.startsWith('UNMOCKED ')
    );
    assert.equal(unmocked.length, 0);
    const result = {
      schemaVersion: 2,
      measuredAt: new Date().toISOString(),
      authority: 'supported-production-turbopack',
      buildPrecondition,
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        chrome: await cdpJson('/json/version'),
      },
      workload: {
        repetitions: R11_BROWSER_REPETITIONS,
        engagementProfile:
          'six watchlist, six last-active, four watched, three requester users per card',
      },
      library,
      responsive: responsive.map((entry) => ({
        width: entry.width,
        clientWidth: entry.viewport.clientWidth,
        scrollWidth: entry.viewport.scrollWidth,
        overflowPixels: entry.viewport.overflowPixels,
        overflowElements: entry.overflowElements,
        stickyChrome: entry.stickyChrome,
        targetPixels:
          R11_PERFORMANCE_TARGETS.browser.maximumHorizontalOverflowPixels,
        meetsTarget:
          entry.viewport.overflowPixels <=
          R11_PERFORMANCE_TARGETS.browser.maximumHorizontalOverflowPixels,
      })),
      coldPresentation,
      domAttribution,
      scrollHook,
      requestSummary: {
        total: requestLog.length,
        api: requestLog.filter((entry) => entry.includes(' /api/')).length,
        library: requestLog.filter((entry) =>
          entry.includes(' /api/v1/library?')
        ).length,
      },
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    const destination = outputPath();
    if (destination) await writeFile(destination, serialized, 'utf8');
    process.stdout.write(serialized);
  } finally {
    if (chromeProcess?.exitCode === null) {
      try {
        const version = (await cdpJson('/json/version')) as {
          webSocketDebuggerUrl: string;
        };
        const browser = new Cdp(version.webSocketDebuggerUrl);
        await browser.open();
        browser.notify('Browser.close');
        await delay(250);
        browser.close();
      } catch {
        // The process fallback below handles a lost DevTools connection.
      }
      await stopChild(chromeProcess);
    }
    if (mockApp) await mockApp.close();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await rm(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 9) {
          process.stderr.write(
            `R11 Chrome profile cleanup failed: ${String(error)}\n`
          );
          break;
        }
        await delay(250);
      }
    }
  }
};

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
