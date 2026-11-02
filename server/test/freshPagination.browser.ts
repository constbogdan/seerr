// Explicit isolated Chromium regression using the existing browser driver.
// pnpm test server/test/freshPagination.browser.ts
import { SubtitleBrowser } from '@server/test/subtitleBrowser';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

it(
  'Fresh: real React/SWR pagination, stale responses, typed identities and targeted cache invalidation',
  { timeout: 120_000 },
  async (t) => {
    const root = path.join(__dirname, '../..');
    const directory = mkdtempSync(path.join(tmpdir(), 'seerr-fresh-browser-'));
    t.diagnostic(`Isolated Chromium artifacts: ${directory}`);
    writeFileSync(
      path.join(directory, 'loader.cjs'),
      `
    const ts = require(${JSON.stringify(require.resolve('typescript'))});
    module.exports = function(source) {
      const file = this.resourcePath.replaceAll('\\\\', '/');
      if (file.endsWith('/hooks/useSettings.ts')) return 'export default () => ({currentSettings: {hideAvailable:true}});';
      if (file.endsWith('/hooks/useUser.ts')) return 'export const Permission = {MANAGE_BLOCKLIST:1}; export const useUser = () => ({hasPermission:()=>true});';
      if (file.endsWith('/hooks/useToasts.tsx')) return 'export default () => ({addToast:()=>{}});';
      if (file.endsWith('/components/TitleCard/index.tsx')) return 'import React from "react"; const Card = ({id,mediaType,title}) => React.createElement("i", {"data-card":mediaType+":"+id,"data-sort":title}); Card.Placeholder=()=>React.createElement("i", {"data-placeholder":true}); export default Card;';
      if (file.endsWith('/components/Common/PageTitle/index.tsx')) return 'export default () => null;';
      if (file.endsWith('/components/PersonCard/index.tsx') || file.endsWith('/components/MediaSlider/ShowMoreCard/index.tsx')) return 'export default () => null;';
      if (file.endsWith('/components/Slider/index.tsx')) return 'import React from "react"; export default ({items}) => React.createElement("div", {id:"slider"}, items);';
      return ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext, jsx:ts.JsxEmit.ReactJSX, target:ts.ScriptTarget.ES2021}}).outputText;
    };
  `
    );
    writeFileSync(
      path.join(directory, 'link.js'),
      'import React from "react"; export default props => React.createElement("a", props);'
    );
    writeFileSync(
      path.join(directory, 'router.js'),
      'export const useRouter = () => window.fixture.router;'
    );
    writeFileSync(
      path.join(directory, 'entry.js'),
      `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {SWRConfig} from 'swr';
    import {IntlProvider} from 'react-intl';
    import axios from 'axios';
    import useDiscover from '@app/hooks/useDiscover';
    import FreshCacheInvalidation from '@app/components/Fresh/FreshCacheInvalidation';
    import WatchlistItemCount from '@app/components/Discover/DiscoverWatchlist/WatchlistItemCount';
    import MediaSlider from '@app/components/MediaSlider';
    import Fresh from '@app/components/Fresh';
    import ListView from '@app/components/Common/ListView';
    const fixture = window.fixture = {reads:[], revision:0, errors:[], held:[]};
    fixture.mutateSettings = () => axios.put('/api/v1/settings/fresh', {});
    fixture.block = () => axios.post('/api/v1/blocklist', {});
    fixture.unblock = () => axios.delete('/api/v1/blocklist/collection/1');
    fixture.failedSave = () => axios.put('/api/v1/settings/fresh', 'fail').catch(()=>undefined);
    window.addEventListener('error', e => fixture.errors.push(e.message));
    window.addEventListener('unhandledrejection', () => fixture.errors.push('unhandled rejection'));
    axios.defaults.adapter = async config => {
      const u = new URL(config.url, 'http://fixture.test');
      if (config.method !== 'get') {
        if (config.data === 'fail') throw new Error('fixture failed save');
        fixture.revision += config.method === 'delete' ? -1 : 1;
        return {data:{},status:200,statusText:'OK',headers:{},config};
      }
      fixture.reads.push(config.url);
      const page = Number(u.searchParams.get('page') || 1);
      let total = fixture.scenario === 'empty' ? 0 : fixture.scenario === 'hidden' ? 61 : fixture.scenario === 'typed' ? 2 : 40;
      if (fixture.revision) total = 23 - (fixture.revision - 1);
      if (u.searchParams.get('mediaType') === 'tv') total = 1;
      if (fixture.scenario.startsWith('scroll') || fixture.scenario === 'shared') total = 81;
      let results = Array.from({length:Math.max(0,Math.min(20,total-(page-1)*20))}, (_,i) => ({
        id:(page-1)*20+i+1,mediaType:u.searchParams.get('mediaType') === 'tv' ? 'tv' : 'movie',
        title:'Fixture',name:'Fixture',mediaInfo:{status:fixture.scenario === 'hidden' && page<4 ? 5 : 1}
      }));
      if (fixture.scenario === 'typed') results = [{id:1,mediaType:'movie'},{id:1,mediaType:'tv'}];
      if (fixture.scenario === 'duplicates' && page === 2) results[0].id = 1;
      if (fixture.scenario.startsWith('scroll')) {
        const sort = u.searchParams.get('sort');
        const offset = ['freshest','vote_average','oldest','vote_count'].indexOf(sort)*1000;
        results = results.map(x=>({...x,id:x.id+offset,title:sort}));
        await new Promise(r=>setTimeout(r,25));
      }
      const data = {page,totalResults:total,totalPages:Math.ceil(total/20),results};
      if (fixture.scenario === 'error' || (fixture.scenario === 'late-error' && page === 2)) throw new Error('fixture unavailable');
      if (fixture.hold) {
        fixture.hold = false;
        await new Promise(resolve => fixture.held.push(resolve));
        fixture.heldReturned = true;
      } else if (u.searchParams.get('mediaType') === 'tv') await new Promise(r => setTimeout(r,150));
      return {data,status:200,statusText:'OK',headers:{},config};
    };
    function Probe() {
      const [query,setQuery] = useState({mediaType:'all',sort:'freshest'});
      const shared = fixture.scenario === 'shared';
      const d = useDiscover(shared?'/api/v1/discover/movies':'/api/v1/fresh',query,shared?undefined:{initialSize:1});
      fixture.query = setQuery; fixture.discover = d;
      if (shared) return React.createElement(ListView,{items:d.titles,isLoading:d.isLoadingInitialData||d.isLoadingMore,isEmpty:d.isEmpty,isReachingEnd:d.isReachingEnd,onScrollBottom:d.fetchMore});
      return React.createElement('main',{},
        React.createElement(WatchlistItemCount,{count:d.firstResultData?.totalResults,loading:d.isLoadingInitialData||d.isValidating||d.hasError}),
        React.createElement('output',{id:'titles'}, d.titles.map(x=>x.mediaType+':'+x.id).join(',')));
    }
    function ScrollProbe() {
      const [query,setQuery] = useState({});
      const route = '/fresh'+(Object.keys(query).length?'?'+new URLSearchParams(query):'');
      const navigate = route => new Promise(resolve=>setTimeout(()=>{
        setQuery(Object.fromEntries(new URL(route,'https://fixture.test').searchParams));
        window.scrollTo(0,0);
        resolve(true);
      },0));
      fixture.router = {query,pathname:'/fresh',asPath:route,push:navigate,replace:navigate};
      return React.createElement(Fresh);
    }
    const root = createRoot(document.getElementById('app'));
    fixture.mount = scenario => {
      fixture.scenario=scenario; fixture.reads=[]; fixture.revision=0; fixture.hold=false; fixture.discover=null;
      fixture.cache = new Map([['/api/v1/unrelated',{data:{untouched:true}}]]);
      root.render(React.createElement(SWRConfig,{key:scenario,value:{provider:()=>fixture.cache,fetcher:url=>axios.get(url).then(r=>r.data),shouldRetryOnError:false,revalidateOnFocus:false}},
        React.createElement(IntlProvider,{locale:'en'},React.createElement(React.Fragment,{},
          React.createElement(FreshCacheInvalidation),React.createElement(scenario.startsWith('scroll')?ScrollProbe:Probe),
          scenario==='cache' ? React.createElement(MediaSlider,{title:'Fresh',sliderKey:'fresh',url:'/api/v1/fresh',linkUrl:'/fresh'}) : null))));
    };
    fixture.mount('pages');
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
          extensions: ['.tsx', '.ts', '.js'],
          modules: [path.join(root, 'node_modules'), 'node_modules'],
          alias: {
            '@app': path.join(root, 'src'),
            '@server': path.join(root, 'server'),
            'next/link$': path.join(directory, 'link.js'),
            'next/router$': path.join(directory, 'router.js'),
          },
        },
        module: {
          rules: [
            {
              test: /\.tsx?$/,
              exclude: /node_modules/,
              use: path.join(directory, 'loader.cjs'),
            },
          ],
        },
      });
      compiler.run(
        (
          error: Error | null,
          stats: { hasErrors: () => boolean; toString: () => string }
        ) =>
          compiler.close(() => {
            if (error || stats.hasErrors())
              reject(error ?? new Error(stats.toString()));
            else resolve();
          })
      );
    });
    const browser = await SubtitleBrowser.start(
      path.join(directory, 'profile'),
      ''
    );
    try {
      const bundle = readFileSync(
        path.join(directory, 'bundle.js'),
        'utf8'
      ).replace(/<\/script/gi, '<\\/script');
      const page = await browser.page(
        `<style>body{margin:0}svg{width:24px;height:24px}.cards-vertical{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:16px;padding:0;list-style:none}.cards-vertical [data-card],.cards-vertical [data-placeholder]{display:block;height:210px}@media(max-width:500px){.cards-vertical{grid-template-columns:repeat(2,minmax(0,1fr))}}</style><div id="app"></div><script>window.process={env:{}};window.bootErrors=[];window.addEventListener('error', e=>window.bootErrors.push(e.message));</script><script>${bundle}</script>`,
        'http://127.0.0.1:1',
        'https://fixture.test'
      );
      const wait = async (condition: string) => {
        for (let i = 0; i < 200; i++) {
          if (await page.evaluate<boolean>(`window.fixture && (${condition})`))
            return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        t.diagnostic(
          JSON.stringify(
            await page.evaluate(
              '({boot:window.bootErrors,errors:window.fixture?.errors,reads:window.fixture?.reads,cards:document.querySelectorAll(".cards-vertical [data-card]").length,sort:document.querySelector("[aria-label=\\"Sort Fresh media\\"]")?.value,height:document.documentElement.offsetHeight,viewport:innerHeight})'
            )
          )
        );
        assert.fail(`Timed out: ${condition}`);
      };
      const idle =
        'fixture.discover?.firstResultData && !fixture.discover.isValidating';
      await wait(idle);
      assert.equal(
        await page.evaluate('fixture.discover.isReachingEnd'),
        false,
        '40 results must not end on page one'
      );
      await page.evaluate('for(let i=0;i<20;i++) fixture.discover.fetchMore()');
      await wait(
        'fixture.discover.titles.length===40 && !fixture.discover.isValidating'
      );
      await page.evaluate('for(let i=0;i<20;i++) fixture.discover.fetchMore()');
      assert.equal(await page.evaluate('fixture.reads.length'), 2);
      assert.equal(await page.evaluate('fixture.discover.isReachingEnd'), true);
      await page.evaluate('fixture.discover.setPageCount(1)');
      await wait(
        'fixture.discover.titles.length===20 && !fixture.discover.isValidating'
      );
      await page.evaluate('fixture.discover.fetchMore()');
      await wait(
        'fixture.discover.titles.length===40 && !fixture.discover.isValidating'
      );
      assert.equal(
        await page.evaluate('fixture.reads.length'),
        2,
        'same-query reset reuses cached pages without being fenced out'
      );
      await page.evaluate("fixture.query({mediaType:'all',sort:'oldest'})");
      await wait(
        "fixture.reads.some(x=>x.includes('sort=oldest')) && fixture.discover.titles.length===20 && !fixture.discover.isValidating"
      );
      assert.equal(await page.evaluate('fixture.discover.pageCount'), 1);
      await page.evaluate("fixture.query({mediaType:'tv',sort:'oldest'})");
      await wait("fixture.reads.some(x=>x.includes('mediaType=tv'))");
      assert.equal(
        await page.evaluate('fixture.discover.titles.length'),
        0,
        'previous query cards are not retained'
      );
      await page.evaluate("fixture.query({mediaType:'movie',sort:'freshest'})");
      await wait(
        'fixture.discover.titles.length===20 && !fixture.discover.isValidating'
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(
        (
          await page.evaluate<string>(
            'document.querySelector("#titles").textContent'
          )
        ).startsWith('movie:')
      );
      for (const scenario of ['hidden', 'empty', 'typed', 'error']) {
        await page.evaluate(`fixture.mount(${JSON.stringify(scenario)})`);
        await wait(scenario === 'error' ? 'fixture.discover.hasError' : idle);
        if (scenario === 'hidden') {
          await wait(
            'fixture.discover.titles.length===1 && fixture.discover.isReachingEnd'
          );
          assert.equal(await page.evaluate('fixture.reads.length'), 4);
        } else if (scenario === 'typed') {
          assert.deepEqual(
            await page.evaluate(
              'fixture.discover.titles.map(x=>x.mediaType+":"+x.id)'
            ),
            ['movie:1', 'tv:1']
          );
        } else {
          assert.equal(await page.evaluate('fixture.reads.length'), 1);
          assert.equal(
            await page.evaluate('fixture.discover.isReachingEnd'),
            scenario === 'empty'
          );
          assert.equal(
            await page.evaluate(
              '!!document.querySelector("[data-testid=watchlist-filtered-item-count]")'
            ),
            scenario === 'empty'
          );
        }
      }
      for (const scenario of ['duplicates', 'late-error']) {
        await page.evaluate(`fixture.mount(${JSON.stringify(scenario)})`);
        await wait(idle);
        await page.evaluate('fixture.discover.fetchMore()');
        await wait(
          scenario === 'duplicates'
            ? 'fixture.discover.isReachingEnd'
            : 'fixture.discover.hasError'
        );
        await page.evaluate(
          'for(let i=0;i<20;i++) fixture.discover.fetchMore()'
        );
        assert.equal(await page.evaluate('fixture.reads.length'), 2);
        assert.equal(
          await page.evaluate('fixture.discover.titles.length'),
          scenario === 'duplicates' ? 39 : 20
        );
      }
      await page.evaluate("fixture.mount('cache')");
      await wait(
        'document.querySelectorAll("#slider [data-card]").length===20 && !fixture.discover.isValidating'
      );
      assert.match(
        await page.evaluate<string>('document.body.textContent'),
        /40 items/
      );
      const before = await page.evaluate<number>('fixture.reads.length');
      await page.evaluate('fixture.failedSave()');
      assert.equal(
        await page.evaluate('fixture.reads.length'),
        before,
        'failed saves do not invalidate'
      );
      // Invoke the real Axios instance used by the app through the fixture bridge.
      await page.evaluate('fixture.discover.fetchMore()');
      await wait(
        'fixture.discover.titles.length===40 && !fixture.discover.isValidating'
      );
      // A non-network synthetic response exercises the application's interceptor.
      await page.evaluate('fixture.hold=true; void fixture.discover.mutate()');
      await wait('fixture.held.length===1');
      // The bundle exposes only test commands, never credentials or real endpoints.
      await page.evaluate('fixture.mutateSettings()');
      await wait(
        'fixture.discover.firstResultData?.totalResults===23 && !fixture.discover.isValidating'
      );
      await page.evaluate('fixture.held.shift()()');
      await wait('fixture.heldReturned');
      await page.evaluate(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
      );
      assert.equal(
        await page.evaluate('fixture.discover.firstResultData.totalResults'),
        23
      );
      assert.match(
        await page.evaluate<string>('document.body.textContent'),
        /23 items/
      );
      assert.equal(
        await page.evaluate(
          'document.querySelectorAll("#slider [data-card]").length'
        ),
        20
      );
      await page.evaluate('fixture.block()');
      await wait(
        'fixture.discover.firstResultData?.totalResults===22 && !fixture.discover.isValidating'
      );
      await page.evaluate('fixture.unblock()');
      await wait(
        'fixture.discover.firstResultData?.totalResults===23 && !fixture.discover.isValidating'
      );
      assert.deepEqual(
        await page.evaluate('fixture.cache.get("/api/v1/unrelated").data'),
        { untouched: true }
      );
      assert.ok((await page.evaluate<number>('fixture.reads.length')) > before);
      // Real Fresh -> ListView -> useVerticalScroll, not direct fetchMore calls.
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 1300,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const cards = 'document.querySelectorAll(".cards-vertical [data-card]")';
      const scroll = async () => {
        await page.evaluate(
          'window.scrollTo(0,document.documentElement.scrollHeight); for(let i=0;i<20;i++) window.dispatchEvent(new Event("scroll"))'
        );
      };
      for (const width of [1300, 390]) {
        if (width === 390)
          await page.send('Emulation.setDeviceMetricsOverride', {
            width,
            height: 1000,
            deviceScaleFactor: 1,
            mobile: false,
          });
        await page.evaluate(`fixture.mount('scroll-${width}')`);
        await wait(
          `${cards}.length>=20 && !!document.querySelector('[data-testid=watchlist-filtered-item-count]')`
        );
        if ((await page.evaluate<number>(`${cards}.length`)) === 20)
          await scroll();
        await wait(`${cards}.length===40`);
        for (const sort of [
          'vote_average',
          'oldest',
          'freshest',
          'vote_count',
          'vote_average',
        ]) {
          await page.evaluate(`(()=>{
            const select=document.querySelector('[aria-label="Sort Fresh media"]');
            select.value=${JSON.stringify(sort)};
            select.dispatchEvent(new Event('change',{bubbles:true}));
          })()`);
          await wait(
            `document.querySelector('[aria-label="Sort Fresh media"]').value===${JSON.stringify(sort)} && ${cards}.length>=20`
          );
          if (width === 390) await scroll();
          // Cached sorts keep shouldFetch true while the callback changes.
          await wait(`${cards}.length===40`);
          assert.deepEqual(
            await page.evaluate(
              `Array.from(${cards},x=>x.dataset.sort).filter(x=>x!==${JSON.stringify(sort)})`
            ),
            [],
            'only the active sort is rendered'
          );
        }
        for (const length of [60, 80, 81]) {
          await scroll();
          await wait(`${cards}.length===${length}`);
        }
        const reads = await page.evaluate<number>('fixture.reads.length');
        await scroll();
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(await page.evaluate('fixture.reads.length'), reads);
        assert.equal(
          await page.evaluate(
            `new Set(Array.from(${cards},x=>x.dataset.card)).size`
          ),
          81
        );
        assert.deepEqual(
          await page.evaluate(
            'fixture.reads.map(url=>new URL(url,"https://fixture.test")).filter(u=>u.searchParams.get("sort")==="vote_average").map(u=>Number(u.searchParams.get("page")))'
          ),
          [1, 2, 3, 4, 5],
          'cached sorts and repeated scrolls do not duplicate or exceed pages'
        );
      }
      // Other discovery lists retain their default three-page initial load.
      await page.evaluate("window.scrollTo(0,0); fixture.mount('shared')");
      await wait(`${cards}.length===60 && !fixture.discover.isValidating`);
      assert.equal(await page.evaluate('fixture.discover.pageCount'), 3);
      for (const length of [80, 81]) {
        await scroll();
        await wait(`${cards}.length===${length}`);
      }
      assert.equal(await page.evaluate('fixture.discover.isReachingEnd'), true);
      await scroll();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(
        await page.evaluate(
          'fixture.reads.map(url=>Number(new URL(url,"https://fixture.test").searchParams.get("page")))'
        ),
        [1, 2, 3, 4, 5]
      );
      assert.deepEqual(await page.evaluate('fixture.errors'), []);
      await page.close();
    } finally {
      await browser.close();
    }
  }
);
