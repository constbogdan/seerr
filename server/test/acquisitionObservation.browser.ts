// Explicit, isolated React/SWR browser acceptance; never contacts providers.
// pnpm test server/test/acquisitionObservation.browser.ts
import { MediaStatus } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import { acquisitionDownload } from '@server/test/acquisitionFixtures';
import { SubtitleBrowser } from '@server/test/subtitleBrowser';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

it(
  'real React/SWR observations survive re-render, detect unchanged replies and reset on navigation/user/quality/unmount',
  { timeout: 120_000 },
  async (t) => {
    const root = path.join(__dirname, '../..');
    const directory = mkdtempSync(
      path.join(tmpdir(), 'seerr-presentation-browser-')
    );
    t.diagnostic(`Isolated artifacts: ${directory}`);
    const loader = path.join(directory, 'loader.cjs');
    writeFileSync(
      loader,
      `const ts=require(${JSON.stringify(require.resolve('typescript'))});
    module.exports=function(source){
      const file=this.resourcePath.replaceAll('\\\\','/');
      if(file.endsWith('/src/hooks/useUser.ts')) return 'export { Permission } from "@server/lib/permissions"; export const useUser=()=>({user:{id:window.viewer},hasPermission:()=>true});';
      if(file.endsWith('/src/hooks/useSettings.ts')) return 'export default ()=>({currentSettings:{}});';
      return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2021}}).outputText;
    };`
    );
    writeFileSync(
      path.join(directory, 'link.js'),
      `import React from 'react'; export default props=>React.createElement('a',props);`
    );
    writeFileSync(
      path.join(directory, 'entry.js'),
      `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import useSWR from 'swr'; import {IntlProvider} from 'react-intl';
    import StatusBadge from '@app/components/StatusBadge';
    import DownloadBlock from '@app/components/DownloadBlock';
    import {getMediaRefreshInterval} from '@app/utils/refreshIntervalHelper';
    window.viewer=1; window.errors=[];
    window.addEventListener('error',e=>window.errors.push(e.message));
    window.addEventListener('unhandledrejection',()=>window.errors.push('rejection'));
    function Probe(){
      const [target,setTarget]=React.useState(200),[quality,setQuality]=React.useState(false),[,render]=React.useState(0);
      const {data,isValidating,mutate}=useSWR('/api/fixture/'+target,url=>fetch(url).then(r=>r.json()),{
        compare:Object.is,revalidateOnFocus:false,revalidateOnReconnect:false,dedupingInterval:0,
        refreshInterval:latest=>getMediaRefreshInterval(latest?.mediaInfo,15000)
      });
      // Keep this fixture below 15s per step. Requests are only explicit mutate
      // or route changes, plus the unchanged existing acquisition cadence.
      React.useEffect(()=>{window.fixture={refresh:()=>mutate(),watchlist:()=>mutate(current=>({...current,onUserWatchlist:!current.onUserWatchlist}),{revalidate:false}),rerender:()=>render(n=>n+1),route:n=>setTarget(n),quality:()=>setQuality(q=>!q),viewer:n=>{window.viewer=n;render(x=>x+1)}}});
      const rows=data?.mediaInfo?.[quality?'downloadStatus4k':'downloadStatus']??[];
      return React.createElement('section',{id:'probe','data-validating':String(isValidating),'data-watchlisted':String(!!data?.onUserWatchlist)},
        React.createElement(StatusBadge,{status:data?.mediaInfo?.status,downloadItem:rows,inProgress:!!rows.length,mediaType:'tv',tmdbId:target,is4k:quality,acquisitionObservation:rows,acquisitionValidating:isValidating}),
        React.createElement('div',{id:'details'},...rows.map((r,i)=>React.createElement(DownloadBlock,{key:i,downloadItem:r,title:'Synthetic Series'}))));
    }
    const root=createRoot(document.getElementById('root'));
    window.remount=()=>root.render(React.createElement(React.StrictMode,null,React.createElement(IntlProvider,{locale:'en'},React.createElement(Probe))));
    window.unmount=()=>root.render(null);window.remount();
  `
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
        ) =>
          compiler.close(() =>
            error || stats.hasErrors()
              ? reject(error ?? Error(stats.toString()))
              : resolve()
          )
      );
    });
    let remaining = 500;
    let finalizing = false;
    let reads = 0;
    let writes = 0;
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET') {
        writes++;
        res.writeHead(405).end();
        return;
      }
      if (req.url?.startsWith('/api/fixture/')) {
        reads++;
        const rows = finalizing
          ? [
              {
                ...acquisitionDownload(1, {
                  title: '',
                  size: 0,
                  sizeLeft: 0,
                  acquisitionPhase: AcquisitionPhase.FINALIZING,
                }),
                episode: {
                  id: 101,
                  seasonNumber: 1,
                  episodeNumber: 1,
                  title: 'Synthetic Episode',
                },
              },
            ]
          : [
              acquisitionDownload(7, {
                downloadId: 'a-queued',
                sizeLeft: 1000,
              }),
              acquisitionDownload(2, {
                downloadId: 'z-advancing',
                sizeLeft: remaining,
              }),
            ];
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            mediaInfo: {
              status: MediaStatus.PROCESSING,
              downloadStatus: rows,
              downloadStatus4k: rows,
            },
          })
        );
      } else if (req.url === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(readFileSync(path.join(directory, 'bundle.js')));
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          '<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>'
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
        remaining = 500;
        finalizing = false;
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
            page.evaluate(
              `new Promise((resolve,reject)=>{const end=Date.now()+8000;function check(){if(${expression})resolve(true);else if(Date.now()>end)reject(Error('Timed out'));else setTimeout(check,20)}check()})`
            );
          const text = `document.querySelector('#probe > :first-child')?.textContent`;
          const idle = `document.querySelector('#probe')?.dataset.validating==='false'`;
          await wait(
            `window.fixture && ${idle} && ${text}?.includes('Searching / Waiting')`
          );
          remaining = 100;
          await page.evaluate('window.fixture.refresh()');
          await wait(`${idle} && ${text}?.includes('DownloadingS1E2')`);
          assert.equal(
            await page.evaluate(
              `document.querySelector('#probe > :first-child [role="progressbar"]')?.getAttribute('aria-valuenow')`
            ),
            '90'
          );
          const readsBeforeRender = reads;
          await page.evaluate('window.fixture.rerender()');
          await wait(`${text}?.includes('DownloadingS1E2')`);
          assert.equal(
            reads,
            readsBeforeRender,
            'ordinary render does not fetch'
          );
          for (const membership of ['true', 'false']) {
            await page.evaluate('window.fixture.watchlist()');
            await wait(
              `document.querySelector('#probe')?.dataset.watchlisted==='${membership}' && ${idle} && ${text}?.includes('DownloadingS1E2')`
            );
            assert.equal(
              await page.evaluate(
                `document.querySelector('#probe > :first-child [role="progressbar"]')?.getAttribute('aria-valuenow')`
              ),
              '90'
            );
            assert.equal(
              reads,
              readsBeforeRender,
              'cache projection does not fetch'
            );
          }
          await page.evaluate('window.fixture.refresh()');
          await wait(`${idle} && ${text}?.includes('Searching / Waiting')`);
          remaining = 90;
          await page.evaluate('window.fixture.refresh()');
          await wait(`${text}?.includes('DownloadingS1E2')`);
          await page.evaluate('window.fixture.quality()');
          await wait(`${text}?.includes('Searching / Waiting')`);
          remaining = 80;
          await page.evaluate('window.fixture.refresh()');
          await wait(`${text}?.includes('DownloadingS1E2')`);
          await page.evaluate('window.fixture.viewer(2)');
          await wait(`${text}?.includes('Searching / Waiting')`);
          remaining = 70;
          await page.evaluate('window.fixture.refresh()');
          await wait(`${text}?.includes('DownloadingS1E2')`);
          await page.evaluate('window.fixture.route(201)');
          await wait(`${idle} && ${text}?.includes('Searching / Waiting')`);
          remaining = 60;
          await page.evaluate('window.fixture.refresh()');
          await wait(`${text}?.includes('DownloadingS1E2')`);
          await page.evaluate('window.unmount()');
          await wait(`!document.querySelector('#probe')`);
          // Remount returns to route 200, whose last cached sample had 70
          // remaining. Keep its fresh reply identical: movement between a
          // cached sample and revalidation would legitimately prove activity,
          // not leaked component-local history.
          remaining = 70;
          await page.evaluate('window.remount()');
          await wait(`${idle} && ${text}?.includes('Searching / Waiting')`);
          finalizing = true;
          await page.evaluate('window.fixture.refresh()');
          await wait(`${text}?.includes('FinalizingS1E1')`);
          assert.equal(
            await page.evaluate(
              `document.querySelector('#details [title]')?.getAttribute('title')`
            ),
            'S01E01 — Synthetic Episode'
          );
          assert.equal(
            await page.evaluate(
              `document.querySelector('#details [title]')?.textContent`
            ),
            'S01E01 — Synthetic Episode'
          );
          assert.deepEqual(await page.evaluate('window.errors'), []);
          assert.deepEqual(page.failures, []);
          t.diagnostic(
            `${mobile ? 'Touch' : 'Desktop'}: activity delta, Watchlist-only cache projections, identical reply, re-render, quality/user/route/unmount reset and Finalizing identity passed.`
          );
        } catch (error) {
          t.diagnostic(
            JSON.stringify(
              await page.evaluate(
                '({text:document.body.innerText,errors:window.errors,hasFixture:!!window.fixture})'
              )
            )
          );
          t.diagnostic(`Synthetic GET count: ${reads}`);
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
