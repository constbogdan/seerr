// Explicit isolated React/SWR regression; no application/provider writes.
// pnpm test server/test/requesterFilter.browser.ts
import { SubtitleBrowser } from '@server/test/subtitleBrowser';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

it(
  'Requested By: real React/SWR selection, routing, permissions and bounded user pages',
  { timeout: 120_000 },
  async (t) => {
    const root = path.join(__dirname, '../..');
    const directory = mkdtempSync(
      path.join(tmpdir(), 'seerr-requester-browser-')
    );
    t.diagnostic(`Isolated Chromium artifacts: ${directory}`);
    writeFileSync(
      path.join(directory, 'loader.cjs'),
      `
    const ts = require(${JSON.stringify(require.resolve('typescript'))});
    module.exports = function(source) {
      const file = this.resourcePath.replaceAll('\\\\','/');
      if (file.endsWith('/hooks/useUser.ts')) return \`
        import {Permission,hasPermission} from '@server/lib/permissions';
        export {Permission};
        export const useUser = ({id}={}) => ({user:id?window.fixture.users.find(x=>x.id===id):{id:1,displayName:'Current viewer',permissions:window.fixture.permissions},hasPermission:(p,o)=>hasPermission(p,window.fixture.permissions,o)});
      \`;
      if (file.endsWith('/components/RequestList/RequestItem/index.tsx')) return 'import React from "react"; export default ({request}) => React.createElement("output",{"data-request":request.id},request.requestedBy.id);';
      if (file.endsWith('/components/Common/PageTitle/index.tsx')) return 'export default () => null;';
      return ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2021}}).outputText;
    };
  `
    );
    writeFileSync(
      path.join(directory, 'router.js'),
      'export const useRouter=()=>window.fixture.router;'
    );
    writeFileSync(
      path.join(directory, 'link.js'),
      'import React from "react"; export default ({children,href,...p})=>React.createElement("a",{...p,href},children);'
    );
    writeFileSync(
      path.join(directory, 'entry.js'),
      `
    import React,{useState,useEffect} from 'react';
    import {createRoot} from 'react-dom/client';
    import {SWRConfig} from 'swr';
    import {IntlProvider} from 'react-intl';
    import RequestList from '@app/components/RequestList';
    const f=window.fixture={reads:[],permissions:2,errors:[],users:Array.from({length:105},(_,i)=>({id:i+1,displayName:'Viewer '+(i+1),permissions:0,includeInUserMetrics:false}))};
    window.addEventListener('error',e=>f.errors.push(e.message));
    window.addEventListener('unhandledrejection',()=>f.errors.push('unhandled rejection'));
    const requests=Array.from({length:32},(_,i)=>({id:i+1,requestedBy:{id:i%2?103:1},type:i%3?'movie':'tv',status:i%4?'pending':'approved'}));
    const fetcher=async url=>{
      f.reads.push(url);
      const u=new URL(url,'https://fixture.test');
      await new Promise(r=>setTimeout(r,20));
      if(u.pathname==='/api/v1/user') {
        if(f.failUsers || (f.failMore && u.searchParams.get('skip')==='100')) throw new Error('Synthetic unavailable directory');
        const skip=Number(u.searchParams.get('skip')||0),take=Number(u.searchParams.get('take'));
        return {pageInfo:{pages:Math.ceil(f.users.length/take),results:f.users.length},results:f.users.slice(skip,skip+take)};
      }
      const owner=u.searchParams.get('requestedBy'),status=u.searchParams.get('filter'),type=u.searchParams.get('mediaType');
      let rows=requests.filter(x=>(!owner||x.requestedBy.id===Number(owner))&&(status==='all'||status===x.status)&&(type==='all'||type===x.type));
      if(u.searchParams.get('sortDirection')==='desc') rows.reverse();
      const take=Number(u.searchParams.get('take')),skip=Number(u.searchParams.get('skip'));
      return {pageInfo:{pages:Math.ceil(rows.length/take),results:rows.length},results:rows.slice(skip,skip+take)};
    };
    function Probe() {
      const [route,setRoute]=useState(()=>({pathname:f.path||'/requests',query:Object.fromEntries(new URL(location.href).searchParams)}));
      const navigate=(target)=>{
        const query=target.query||{}; const url=target.pathname+(Object.keys(query).length?'?'+new URLSearchParams(query):'');
        history.pushState({},'',url); setRoute({pathname:target.pathname,query}); return Promise.resolve(true);
      };
      f.router={...route,asPath:location.pathname+location.search,push:navigate,replace:(pathname,path)=>{
        const url=new URL(path||pathname,location.href); const query=Object.fromEntries(url.searchParams);
        history.replaceState({},'',url); setRoute({pathname:route.pathname,query}); return Promise.resolve(true);
      }};
      useEffect(()=>{const pop=()=>setRoute({pathname:f.path||'/requests',query:Object.fromEntries(new URL(location.href).searchParams)});window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[]);
      return React.createElement(RequestList);
    }
    const root=createRoot(document.getElementById('app')); let version=0;
    f.mount=(permissions=2,path='/requests')=>{
      f.permissions=permissions; f.path=path; f.reads=[];
      root.render(React.createElement(SWRConfig,{key:++version,value:{provider:()=>new Map(),fetcher,revalidateOnFocus:false,shouldRetryOnError:false}},React.createElement(IntlProvider,{locale:'en'},React.createElement(Probe))));
    };
    f.mount();
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
          compiler.close(() =>
            error || stats.hasErrors()
              ? reject(error ?? new Error(stats.toString()))
              : resolve()
          )
      );
    });
    const browser = await SubtitleBrowser.start(
      path.join(directory, 'profile'),
      ''
    );
    let assertions = 0;
    const equal = (actual: unknown, expected: unknown, message?: string) => {
      assert.deepEqual(actual, expected, message);
      assertions++;
    };
    try {
      const bundle = readFileSync(
        path.join(directory, 'bundle.js'),
        'utf8'
      ).replace(/<\/script/gi, '<\\/script');
      const page = await browser.page(
        `<div id="app"></div><script>window.process={env:{}};localStorage.setItem('rl-filter-settings',JSON.stringify({currentFilter:'all',currentSort:'added',currentPageSize:5,currentSortDirection:'asc'}));</script><script>${bundle}</script>`,
        'http://127.0.0.1:1',
        'https://fixture.test'
      );
      const wait = async (condition: string) => {
        for (let i = 0; i < 200; i++) {
          if (
            await page.evaluate<boolean>(
              `Boolean(window.fixture && (${condition}))`
            )
          )
            return;
          await new Promise((r) => setTimeout(r, 25));
        }
        t.diagnostic(
          JSON.stringify(
            await page.evaluate(
              '({errors:fixture.errors,reads:fixture.reads,html:document.body.innerText})'
            )
          )
        );
        assert.fail(`Timed out: ${condition}`);
      };
      const select =
        'document.querySelector("[aria-label=\\"Requested By\\"]")';
      const change = async (selector: string, value: string) => {
        await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
        await wait(
          `document.querySelector(${JSON.stringify(selector)}).querySelector('option[value="${value}"]')?.disabled===false`
        );
        return page.evaluate(
          `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`
        );
      };
      await wait(`${select}?.options.length===102`);
      equal(await page.evaluate(`${select}.value`), 'all');
      equal(
        await page.evaluate(`${select}.className`),
        'rounded-r-only min-w-0 flex-1'
      );
      equal(
        await page.evaluate(
          'fixture.reads.filter(x=>x.startsWith("/api/v1/user?")).length'
        ),
        1
      );
      await change('[aria-label="Requested By"]', 'more');
      await wait(`${select}?.options.length===106`);
      equal(
        await page.evaluate(
          'fixture.reads.filter(x=>x.startsWith("/api/v1/user?")).length'
        ),
        2
      );
      equal(
        await page.evaluate(`${select}.value`),
        'all',
        'paging the directory does not change requester'
      );
      await page.evaluate(
        'fixture.router.push({pathname:"/requests",query:{page:"3",filter:"all"}})'
      );
      await wait('fixture.reads.some(x=>x.includes("skip=10"))');
      await change('[aria-label="Requested By"]', '103');
      await wait(
        'fixture.router.query.userId==="103" && document.querySelectorAll("[data-request]").length===5'
      );
      equal(await page.evaluate('fixture.router.query'), {
        filter: 'all',
        userId: '103',
      });
      await wait('document.body.innerText.includes("16")');
      await change('#mediaType', 'movie');
      await change('#filter', 'pending');
      await change('#sort', 'modified');
      await wait(
        'fixture.reads.some(x=>x.includes("requestedBy=103")&&x.includes("mediaType=movie")&&x.includes("filter=pending")&&x.includes("sort=modified"))'
      );
      await change('[aria-label="Requested By"]', '1');
      await wait(
        'fixture.router.query.userId==="1" && !!document.querySelector("#pageSize")'
      );
      equal(
        await page.evaluate(
          '[document.querySelector("#mediaType").value,document.querySelector("#filter").value,document.querySelector("#sort").value,document.querySelector("#pageSize").value]'
        ),
        ['movie', 'pending', 'modified', '5']
      );
      await page.evaluate('history.back()');
      await wait(`${select}?.value==='103'`);
      await page.evaluate('history.forward()');
      await wait(`${select}?.value==='1'`);
      await page.evaluate('fixture.mount()');
      await wait(`${select}?.value==='1'`);
      await change('[aria-label="Requested By"]', 'all');
      await wait('!fixture.router.query.userId');
      equal(
        await page.evaluate(
          'new URL(location.href).searchParams.has("userId")'
        ),
        false
      );
      for (const [permission, visible] of [
        [2, true],
        [16, true],
        [16384, true],
        [32, false],
        [8, false],
      ]) {
        await page.evaluate(`fixture.mount(${permission})`);
        await wait(
          'fixture.reads.some(x=>x.startsWith("/api/v1/request?")) && document.querySelectorAll("[data-request]").length>0'
        );
        equal(await page.evaluate(`!!${select}`), visible);
        if (!visible)
          equal(
            await page.evaluate(
              'fixture.reads.some(x=>x.startsWith("/api/v1/user?"))'
            ),
            false
          );
      }
      for (const [route, id] of [
        ['/profile/requests', '1'],
        ['/users/[userId]/requests', '103'],
      ]) {
        await page.evaluate(
          `history.replaceState({},'', '/requests?userId=103');fixture.mount(2,${JSON.stringify(route)})`
        );
        await wait(
          `fixture.reads.some(x=>x.includes('requestedBy=${id}')) && document.querySelectorAll('[data-request]').length>0`
        );
        equal(await page.evaluate(`!!${select}`), false);
      }
      await page.evaluate(
        'history.replaceState({},"","/requests");fixture.failUsers=true;fixture.mount()'
      );
      await wait(`${select}?.querySelector('option[value="retry"]')`);
      equal(await page.evaluate(`${select}.value`), 'all');
      await page.evaluate('fixture.failUsers=false');
      await change('[aria-label="Requested By"]', 'retry');
      await wait(`${select}?.querySelector('option[value="more"]')`);
      equal(
        await page.evaluate(
          'fixture.reads.filter(x=>x.startsWith("/api/v1/user?")).length'
        ),
        2
      );
      await page.evaluate('fixture.failMore=true');
      await change('[aria-label="Requested By"]', 'more');
      await wait(`${select}?.querySelector('option[value="retry"]')`);
      await page.evaluate('fixture.failMore=false');
      await change('[aria-label="Requested By"]', 'retry');
      await wait(`${select}?.options.length===106`);
      equal(
        await page.evaluate(
          'fixture.reads.filter(x=>x.startsWith("/api/v1/user?")).map(x=>new URL(x,location.href).searchParams.get("skip"))'
        ),
        ['0', '0', '100', '100'],
        'retry only reads the missing directory page'
      );
      equal(await page.evaluate('fixture.errors'), []);
      t.diagnostic(
        `${assertions} Chromium assertions passed. Desktop/mobile layout is checked separately against the real harness CSS.`
      );
      await page.close();
    } finally {
      await browser.close();
    }
  }
);
