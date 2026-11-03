// Explicit synthetic acceptance, never part of the default application suite:
// SUBTITLE_TEST_CHROME=<Chromium path> pnpm test server/test/acquisitionPresentation.browser.ts
// Real StatusBadge/Tooltip/DownloadBlock + SWR, actual component hook options,
// real 15-second foreground timers. Only an ephemeral GET-only loopback fixture.
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import { acquisitionDownload } from '@server/test/acquisitionFixtures';
import {
  acquisitionHookSource,
  acquisitionSurfaces,
} from '@server/test/acquisitionPolling';
import { SubtitleBrowser } from '@server/test/subtitleBrowser';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import ts from 'typescript';

it(
  'desktop and touch: real badges refresh coherently at 15 seconds and stop after cleanup',
  { timeout: 240_000 },
  async (t) => {
    const root = path.join(__dirname, '../..');
    const directory = mkdtempSync(
      path.join(tmpdir(), 'seerr-stage-b-browser-')
    );
    t.diagnostic(`Synthetic browser artifacts: ${directory}`);
    const loader = path.join(directory, 'loader.cjs');
    // Test-only compiler artifacts. Never replaces a repository loader or file.
    writeFileSync(
      loader,
      `const ts = require(${JSON.stringify(require.resolve('typescript'))});
    module.exports = function(source) {
      if (this.resourcePath.replaceAll('\\\\','/').endsWith('/src/hooks/useUser.ts'))
        return 'export { Permission } from "@server/lib/permissions"; export const useUser = () => ({ hasPermission: () => false });';
      return ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2021
      }}).outputText;
    };`
    );
    const hooks = Object.keys(acquisitionSurfaces)
      .map((surface) =>
        acquisitionHookSource(surface as keyof typeof acquisitionSurfaces)
      )
      .join('\n');
    const entry = ts.transpileModule(
      `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import useSWR, { SWRConfig } from 'swr';
    import { IntlProvider } from 'react-intl';
    import axios from 'axios';
    import StatusBadge from '@app/components/StatusBadge';
    import DownloadBlock from '@app/components/DownloadBlock';
    import { getRequestRefreshInterval, getMediaRefreshInterval, getRequestDownloadStatus } from '@app/utils/refreshIntervalHelper';
    ${hooks}
    const hooks = { RequestCard, RequestItem, MovieDetails, TvDetails };
    window.fixtureErrors ??= [];
    window.addEventListener('error', event => window.fixtureErrors.push(event.message));
    window.addEventListener('unhandledrejection', () => window.fixtureErrors.push('rejection'));
    const parent = {
      id: 71, type: 'tv', is4k: false, status: 5,
      seasons: [{ seasonNumber: 1, status: 5 }],
      media: { status: 5, downloadStatus: [] }
    };
    function Probe({ surface }) {
      const request = surface === 'RequestItem' ? { ...parent, id: 72, seasons: [{seasonNumber: 2, status: 5}] } : parent;
      const { data, isValidating } = hooks[surface]({
        request, movie: { id: 200, mediaInfo: parent.media }, tv: { id: 200, mediaInfo: parent.media },
        routeMovieId: 200, routeTvId: 200,
        detailsCacheKey: ['/api/v1/' + (surface === 'MovieDetails' ? 'movie' : 'tv') + '/200', 'synthetic-user'],
        useSWR, axios, getRequestRefreshInterval, getMediaRefreshInterval
      });
      const media = data?.media ?? data?.mediaInfo;
      const rows = getRequestDownloadStatus(media?.downloadStatus,
        surface.startsWith('Request') ? request.seasons.map(s => s.seasonNumber) : []);
      const interval = surface.startsWith('Request') ? getRequestRefreshInterval(data, 15000) : getMediaRefreshInterval(media, 15000);
      return <section id={surface} data-stage={data?.fixtureStage} data-interval={interval} data-entries={rows.length}>
        <h2>{surface}</h2>
        <StatusBadge status={media?.status} downloadItem={rows} acquisitionObservation={media?.downloadStatus} acquisitionValidating={isValidating} inProgress={!!rows.length} mediaType={surface === 'MovieDetails' ? 'movie' : 'tv'} title="Synthetic Series" />
        <details><summary>Synthetic queue inspection</summary><ul>{rows.map((row, index) => <li key={index}><DownloadBlock downloadItem={row} title="Synthetic Series" /></li>)}</ul></details>
      </section>;
    }
    createRoot(document.getElementById('root')).render(
      <SWRConfig value={{ fetcher: url => fetch(url).then(r => r.json()) }}>
        <IntlProvider locale="en">{Object.keys(hooks).map(surface => <Probe key={surface} surface={surface}/>)}</IntlProvider>
      </SWRConfig>);
  `,
      {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2021,
        },
      }
    ).outputText;
    writeFileSync(path.join(directory, 'entry.js'), entry);
    // Navigation is not under test; no Next router or application server needed.
    writeFileSync(
      path.join(directory, 'link.js'),
      `import React from 'react'; export default function Link(props) { return React.createElement('a', props); }`
    );
    const webpack = createRequire(__filename)(
      'next/dist/compiled/webpack/webpack'
    ).webpack;
    await new Promise<void>((resolve, reject) => {
      const compiler = webpack({
        mode: 'development',
        devtool: false,
        context: root,
        target: 'web',
        entry: path.join(directory, 'entry.js'),
        output: { path: directory, filename: 'bundle.js' },
        resolve: {
          extensions: ['.tsx', '.ts', '.js', '.mjs'],
          modules: [path.join(root, 'node_modules'), 'node_modules'],
          alias: {
            '@app': path.join(root, 'src'),
            '@server': path.join(root, 'server'),
            'next/link$': path.join(directory, 'link.js'),
          },
        },
        module: {
          rules: [
            { test: /\.tsx?$/, exclude: /node_modules/, use: loader },
            { test: /\.svg$/, use: require.resolve('@svgr/webpack') },
          ],
        },
      });
      compiler.run(
        (
          error: Error | null,
          stats: { hasErrors: () => boolean; toString: () => string }
        ) => {
          compiler.close(() => {
            if (error || stats.hasErrors())
              reject(error ?? new Error(stats.toString()));
            else resolve();
          });
        }
      );
    });
    execFileSync(
      process.execPath,
      [
        require.resolve('tailwindcss/lib/cli'),
        '-c',
        path.join(root, 'tailwind.config.js'),
        '--content',
        [
          'src/components/StatusBadge/index.tsx',
          'src/components/DownloadBlock/index.tsx',
          'src/components/DownloadBlock/DownloadProgress.tsx',
          'src/components/Common/Badge/index.tsx',
          'src/components/Common/Tooltip/index.tsx',
        ]
          .map((file) => path.join(root, file))
          .join(','),
        '-o',
        path.join(directory, 'styles.css'),
      ],
      { cwd: root, windowsHide: true }
    );

    let stage = 0;
    const reads = new Map<string, number[]>();
    let writes = 0;
    const snapshot = (url: string) => {
      const episode = (season: number, number: number, active: boolean) =>
        acquisitionDownload(number, {
          downloadId: `synthetic-${season}-${number}`,
          episode: {
            id: season * 100 + number,
            seasonNumber: season,
            episodeNumber: number,
            absoluteEpisodeNumber: number,
          },
          // Real Sonarr/SAB queue shape: positive ETA and downloading state
          // also appear on queued zero-byte peers. Only sample deltas prove
          // activity, including an advancing Season 2 peer in stage 2.
          status: 'downloading',
          sizeLeft:
            number === 1 ? 570 : stage === 0 ? 1000 : stage === 2 ? 100 : 230,
          timeLeft: active ? '00:05:00' : '00:10:00',
        });
      const rows =
        stage === 3
          ? []
          : [1, 2].flatMap((season) =>
              stage === 2 && season === 1
                ? [
                    acquisitionDownload(2, {
                      downloadId: 'synthetic-finalizing',
                      episode: {
                        id: 102,
                        seasonNumber: 1,
                        episodeNumber: 2,
                        absoluteEpisodeNumber: 2,
                      },
                      acquisitionPhase: AcquisitionPhase.FINALIZING,
                      sizeLeft: 0,
                    }),
                  ]
                : [
                    episode(season, 1, stage === 0),
                    episode(season, 2, stage !== 0),
                  ]
            );
      const status =
        stage === 3
          ? MediaRequestStatus.COMPLETED
          : MediaRequestStatus.APPROVED;
      const request = {
        id: url.endsWith('72') ? 72 : 71,
        type: 'tv',
        is4k: false,
        status,
        seasons: [{ seasonNumber: url.endsWith('72') ? 2 : 1, status }],
      };
      const media = {
        status: stage === 3 ? MediaStatus.AVAILABLE : MediaStatus.PROCESSING,
        downloadStatus: rows,
        requests: [request],
      };
      return url.startsWith('/api/v1/request/')
        ? { ...request, media, fixtureStage: stage }
        : { id: 200, mediaInfo: media, fixtureStage: stage };
    };
    const server = http.createServer((request, response) => {
      if (request.method !== 'GET') {
        writes++;
        response.writeHead(405).end();
        return;
      }
      const url = request.url ?? '';
      if (url.startsWith('/api/')) {
        reads.set(url, [...(reads.get(url) ?? []), Date.now()]);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(snapshot(url)));
      } else if (url === '/bundle.js' || url === '/styles.css') {
        response.setHeader(
          'Content-Type',
          url.endsWith('.js') ? 'text/javascript' : 'text/css'
        );
        response.end(readFileSync(path.join(directory, url.slice(1))));
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><script>window.fixtureErrors=[];window.addEventListener("error",event=>window.fixtureErrors.push(event.message));</script></head><body style="background:#111827;color:#eee;padding:16px"><div id="root"></div><script src="/bundle.js"></script></body></html>'
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    let browser: SubtitleBrowser | undefined;
    try {
      browser = await SubtitleBrowser.start(
        path.join(directory, 'profile'),
        ''
      );
      for (const mobile of [false, true]) {
        stage = 0;
        reads.clear();
        const page: Awaited<ReturnType<SubtitleBrowser['page']>> =
          await browser.page('', origin, origin);
        try {
          await page.send('Emulation.setDeviceMetricsOverride', {
            width: mobile ? 390 : 1280,
            height: 844,
            deviceScaleFactor: 1,
            mobile,
          });
          await page.send('Emulation.setTouchEmulationEnabled', {
            enabled: mobile,
          });
          const wait = (expression: string) =>
            page.evaluate(`new Promise((resolve, reject) => {
          const end = Date.now() + 19000;
          function check() { if (${expression}) resolve(true); else if (Date.now() > end) reject(new Error('Timed out')); else setTimeout(check, 50); } check();
        })`);
          const badge = (id: string) =>
            `document.querySelector('#${id} > span')`;
          const text = (id: string) => `${badge(id)}?.textContent`;
          const synchronized = (value: number) =>
            `[...document.querySelectorAll('#root > section')].length === 4 && [...document.querySelectorAll('#root > section')].every(section => section.dataset.stage === '${value}')`;
          await wait(
            `${synchronized(0)} && ${text('RequestCard')}?.includes('Searching / Waiting') && document.querySelector('#RequestCard').dataset.entries === '2'`
          );
          assert.equal(
            await page.evaluate(
              `${badge('RequestCard')}.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')`
            ),
            '43'
          );
          stage = 1;
          await wait(
            `${synchronized(1)} && ${text('RequestCard')}?.includes('DownloadingS1E2')`
          );
          assert.equal(
            await page.evaluate(
              `${badge('RequestCard')}.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')`
            ),
            '77'
          );
          // Inspect the real per-row component. Badge's pre-existing forwarding
          // limitation prevents its Tooltip handlers from receiving hover/touch;
          // do not change that unrelated interaction to make acceptance pass.
          await page.evaluate(
            `document.querySelector('#RequestCard details').open = true`
          );
          assert.equal(
            await page.evaluate(
              `document.querySelectorAll('#RequestCard details li').length`
            ),
            2
          );
          assert.equal(
            await page.evaluate(
              `document.querySelector('#RequestCard details').textContent.includes('77%')`
            ),
            true
          );
          stage = 2;
          await wait(
            `${synchronized(2)} && ${text('RequestCard')}?.includes('FinalizingS1E2') && ${text('RequestItem')}?.includes('DownloadingS2E2')`
          );
          assert.equal(
            await page.evaluate(
              `${badge('RequestCard')}.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow')`
            ),
            false
          );
          stage = 3;
          await wait(
            `${synchronized(3)} && [...document.querySelectorAll('#root > section')].every(section => section.dataset.interval === '0' && section.textContent.includes('Available') && !section.querySelector('[role="progressbar"]'))`
          );
          const counts = [...reads].map(([url, times]) => ({
            url,
            times: [...times],
          }));
          assert.equal(counts.length, 4);
          for (const { times } of counts) {
            assert.equal(
              times.length,
              4,
              'one initial GET and three 15-second refreshes'
            );
            for (let i = 1; i < times.length; i++)
              assert.ok(
                times[i] - times[i - 1] >= 14_500 &&
                  times[i] - times[i - 1] < 18_000,
                'foreground cadence remains 15 seconds'
              );
          }
          await page.evaluate(
            'new Promise(resolve => setTimeout(resolve, 16000))'
          );
          assert.deepEqual(
            [...reads].map(([url, times]) => ({ url, times: [...times] })),
            counts,
            'terminal response stops polling despite stale parent'
          );
          assert.deepEqual(await page.evaluate('window.fixtureErrors'), []);
          assert.deepEqual(page.failures, []);
          const screenshot = await page.send('Page.captureScreenshot', {
            format: 'png',
          });
          writeFileSync(
            path.join(directory, mobile ? 'mobile.png' : 'desktop.png'),
            Buffer.from(String(screenshot.data), 'base64')
          );
          t.diagnostic(
            `${mobile ? 'Touch 390px' : 'Desktop 1280px'}: coherent replacement, cross-Season Finalizing, four single 15s pollers, terminal shutdown and detailed rows passed.`
          );
        } catch (error) {
          t.diagnostic(
            JSON.stringify(
              await page.evaluate(
                '({text:document.body.innerText, errors:window.fixtureErrors})'
              )
            )
          );
          t.diagnostic(
            `Failed synthetic stage ${stage}; reads ${JSON.stringify([...reads].map(([url, times]) => ({ url, count: times.length })))}`
          );
          throw error;
        } finally {
          await page.close();
        }
      }
      assert.equal(writes, 0);
    } finally {
      await browser?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);
