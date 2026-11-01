// Optional focused acceptance: pnpm test server/test/jellyfinUserLikesCards.browser.ts
// Fresh headless profile + file fixture. No CDP, authenticated browser or provider.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { pathToFileURL } from 'node:url';

it('renders both card structures with responsive native-sized bottom-left controls in Chromium', async (context) => {
  const executable = [
    process.env.SUBTITLE_TEST_CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find(
    (candidate): candidate is string => !!candidate && existsSync(candidate)
  );
  assert.ok(
    executable,
    'An installed Chromium is required for this explicit browser fixture.'
  );
  const directory = await mkdtemp(
    path.join(tmpdir(), 'jellyfin-card-likes-render-')
  );
  const source = await readFile(
    path.resolve('public/integrations/jellyfin-user-likes.js'),
    'utf8'
  );
  const html = `<!doctype html><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'">
    <style>
      /* Pinned 10.10.7 poster/overlay structure, with distinct legacy/MUI sizes.
         See jellyfin-web/v10.10.7/src/components/cardbuilder/card.scss. */
      body { margin:0; font:16px sans-serif; }
      .card { width:200px; margin:8px; display:inline-block; vertical-align:top; }
      .cardScalable { position:relative; contain:layout style; }
      .cardPadder { padding-bottom:150%; }
      .cardContent, .cardOverlayContainer { position:absolute; inset:0; }
      .cardImageContainer { display:block; width:100%; height:100%; }
      .cardOverlayContainer { opacity:0; }
      .cardOverlayContainer > a { position:absolute; inset:0; }
      .card:hover .cardOverlayContainer { opacity:1; }
      .cardOverlayButton-br { display:flex; position:absolute; bottom:0; right:0; }
      .cardOverlayButton { box-sizing:border-box; width:2.5em; height:2.5em; padding:.25em; margin:0; border:0; font-size:88%; }
      .mui .cardOverlayButton { width:2em; height:2em; font-size:1em; }
      .cardOverlayButton svg, .cardOverlayButton .material-icons { font-size:1.5em; width:1em; height:1em; }
      .innerCardFooter { position:absolute; bottom:0; left:0; width:100%; height:6px; }
      .cardIndicators { position:absolute; right:0; top:0; }
      .rating-overlay-container { position:absolute; left:0; top:0; }
    </style><div id="cards"></div><pre id="report">pending</pre>
    <script>
      const user='1'.repeat(32), server='2'.repeat(32);
      const itemId=n=>n.toString(16).padStart(32,'0');
      const data=new Map([
        [itemId(1),{Id:itemId(1),Type:'Movie',UserData:{Played:false,Likes:true}}],
        [itemId(2),{Id:itemId(2),Type:'Series',UserData:{Played:false,Likes:false}}],
        [itemId(3),{Id:itemId(3),Type:'Movie',UserData:{Played:false,Likes:null}}],
        [itemId(4),{Id:itemId(4),Type:'Movie'}],
      ]);
      const calls=[]; const writes=[];
      window.ApiClient={getCurrentUserId:()=>user,serverId:()=>server,deviceId:()=>'fixture',
        getSessions:async()=>[{DeviceId:'fixture',UserId:user,AdditionalUsers:[]}],
        getItem:async(u,id)=>structuredClone(data.get(id)),
        getItems:async(u,q)=>{calls.push(q.Ids.split(','));return {Items:q.Ids.split(',').map(id=>structuredClone(data.get(id))).filter(Boolean)};},
        updateUserItemRating:async(u,id,v)=>{writes.push('rate');data.get(id).UserData.Likes=v;},
        clearUserItemRating:async(u,id)=>{writes.push('clear');data.get(id).UserData.Likes=null;},
        markPlayed:async()=>writes.push('played'),markUnplayed:async()=>writes.push('unplayed')};
      // Deterministic observer delivery: layout/CSS and MutationObserver are real.
      // --dump-dom virtual time does not drive compositor animation frames.
      window.IntersectionObserver=class {constructor(callback){this.callback=callback;} observe(target){queueMicrotask(()=>this.callback([{target,isIntersecting:true}]))} unobserve(){} disconnect(){} };
      const resizeObservers=[];
      window.ResizeObserver=class {constructor(callback){this.callback=callback;this.targets=new Set();resizeObservers.push(this);} observe(target){this.targets.add(target);} unobserve(target){this.targets.delete(target);} disconnect(){this.targets.clear();} };
      function card(n,type='Movie',modern=true){
        const id=itemId(n);const element=document.createElement('div');
        element.className='card portraitCard card-hoverable '+(modern?'mui':'legacy');
        Object.assign(element.dataset,{id,type,serverid:server,context:type==='Movie'?'movies':'tvshows'});
        const image=modern?'<div class="cardContent"><div class="cardImageContainer coveredImage"><div class="rating-overlay-container">7.5</div><div class="cardIndicators">✓</div></div></div>':'<a class="cardContent cardImageContainer" href="#/details?id='+id+'&serverId='+server+'"></a>';
        element.innerHTML='<div class="cardScalable"><div class="cardPadder"></div>'+image+'<div class="cardOverlayContainer itemAction MuiBox-root"><a class="cardImageContainer" href="#/details?id='+id+'&serverId='+server+'"></a><div class="cardOverlayButton-br flex">'+[1,2,3].map(()=>'<button class="cardOverlayButton"><svg viewBox="0 0 24 24"></svg></button>').join('')+'</div></div><div class="innerCardFooter"></div></div>';
        document.getElementById('cards').append(element);return element;
      }
      const movie=card(1),series=card(2,'Series'),neutral=card(3),unknown=card(4);
      const related=card(1,'Movie',false),episode=card(1,'Episode');
      const detailPage=document.createElement('div');
      detailPage.className='itemDetailPage';
      detailPage.innerHTML='<div class="detailButtons"><button class="btnFavorite">Favorite</button></div>';
      document.body.appendChild(detailPage);
      location.hash='#/details?id='+itemId(3)+'&serverId='+server;
    </script><script>${source}</script><script>
      const checks=[];const check=(name,pass,details)=>{checks.push({name,pass:!!pass});if(!pass)throw Error(name+' '+JSON.stringify(details));};
      const wait=async()=>{await new Promise(resolve=>setTimeout(resolve,50));for(const observer of resizeObservers)observer.callback([...observer.targets].map(target=>({target})));await new Promise(resolve=>setTimeout(resolve,0));};
      const visible=node=>{const css=getComputedStyle(node);return css.display!=='none'&&css.opacity!=='0'&&node.getBoundingClientRect().width>0;};
      const close=(a,b)=>Math.abs(a-b)<1.1;
      setTimeout(async()=>{try {
        await wait();
        check('Movie and Series primary grids',!!movie.querySelector('.jf-card-likes')&&!!series.querySelector('.jf-card-likes'));
        check('Legacy recommendations retained',!!related.querySelector('.jf-card-likes'));
        check('Episode excluded',!episode.querySelector('.jf-card-likes'));
        check('Persistent Like',visible(movie.querySelector('.like'))&&!visible(movie.querySelector('.dislike')));
        check('Persistent Dislike',visible(series.querySelector('.dislike'))&&!visible(series.querySelector('.like')));
        check('Confirmed Neutral uncluttered',!visible(neutral.querySelector('.like'))&&!visible(neutral.querySelector('.dislike'))&&!visible(neutral.querySelector('.jf-reveal')));
        check('Unknown distinct',unknown.querySelector('.jf-card-likes').classList.contains('unknown')&&visible(unknown.querySelector('.jf-reveal'))&&unknown.querySelector('.like').disabled);
        check('Selected colors',getComputedStyle(movie.querySelector('.like')).color==='rgb(3, 169, 244)'&&getComputedStyle(series.querySelector('.dislike')).color==='rgb(244, 67, 54)');
        const transparent=node=>getComputedStyle(node).backgroundColor==='rgba(0, 0, 0, 0)';
        check('Resting selected icons have no background',transparent(movie.querySelector('.like'))&&transparent(series.querySelector('.dislike')));
        const detail=detailPage.querySelector('#custom-jellyfin-likes');
        check('Both detail controls remain available',!!detail&&detail.querySelectorAll('button').length===2&&[...detail.querySelectorAll('button')].every(button=>!button.disabled));
        const gray='rgba(255, 255, 255, 0.76)';
        for(const root of [neutral.querySelector('.jf-card-likes'),detail]) {
          const surface=root===detail?'Detail':'Card';
          check(surface+' unselected native gray',[...root.querySelectorAll('button')].every(button=>getComputedStyle(button).color===gray));
          for(const [kind,color] of [['like','rgb(3, 169, 244)'],['dislike','rgb(244, 67, 54)']]) {
            const button=root.querySelector('.'+kind);
            button.focus();
            check(surface+' '+kind+' focus color/background/outline',getComputedStyle(button).color===color&&transparent(button)&&getComputedStyle(button).outlineStyle==='solid');
            button.blur();
            check(surface+' '+kind+' blur restores gray',getComputedStyle(button).color===gray&&transparent(button));
            button.classList.add('selected');
            check(surface+' '+kind+' selected stays background-free',getComputedStyle(button).color===color&&transparent(button));
            button.classList.remove('selected');
          }
        }
        const detailButton=detail.querySelector('.like');
        check('Detail dimensions and spacing unchanged',close(detailButton.getBoundingClientRect().width,parseFloat(getComputedStyle(detailButton).fontSize)*3)&&close(detailButton.getBoundingClientRect().height,parseFloat(getComputedStyle(detailButton).fontSize)*3)&&getComputedStyle(detail.querySelector('.material-icons')).fontSize==='24px'&&getComputedStyle(detail).gap==='2px');
        // --dump-dom has no mouse driver. Exercise the exact shipped :hover
        // declarations through controlled selector mirrors; focus above is real.
        const hoverRules=[...document.styleSheets].flatMap(sheet=>[...sheet.cssRules]).filter(rule=>rule.selectorText?.includes(':hover'));
        const hoverStyle=document.createElement('style');
        hoverStyle.textContent=hoverRules.map(rule=>rule.selectorText.replace(/:hover/g,'.fixture-hover')+'{'+rule.style.cssText+'}').join('');
        document.head.appendChild(hoverStyle);
        neutral.classList.add('fixture-hover');
        check('Hover exposes both neutral card controls',visible(neutral.querySelector('.like'))&&visible(neutral.querySelector('.dislike')));
        for(const root of [neutral.querySelector('.jf-card-likes'),detail]) {
          for(const [kind,color] of [['like','rgb(3, 169, 244)'],['dislike','rgb(244, 67, 54)']]) {
            const button=root.querySelector('.'+kind);
            button.classList.add('fixture-hover');
            check((root===detail?'Detail':'Card')+' '+kind+' hover color without background',getComputedStyle(button).color===color&&transparent(button));
            button.classList.remove('fixture-hover');
          }
        }
        neutral.classList.remove('fixture-hover');
        hoverStyle.remove();
        check('Icons are smaller than native glyphs',close(parseFloat(getComputedStyle(movie.querySelector('.like .material-icons')).fontSize),parseFloat(getComputedStyle(movie.querySelector('.cardOverlayButton svg')).fontSize)*.8));
        const initialReads=calls.length;
        for(const background of ['white','black']) {
          movie.querySelector('.cardContent').style.backgroundColor=background;
          await wait();
          check('Transparent icon with contrast shadow on '+background,transparent(movie.querySelector('.like'))&&getComputedStyle(movie.querySelector('.like')).textShadow!=='none'&&getComputedStyle(movie.querySelector('.like')).color==='rgb(3, 169, 244)');
        }
        check('Presentation has no additional reads',calls.length===initialReads);
        for(const element of [movie,related]) for(const width of [120,180,320]) {
          element.style.width=width+'px';await wait();
          const poster=element.querySelector('.cardScalable').getBoundingClientRect();
          const selected=element.querySelector('.like').getBoundingClientRect();
          const native=element.querySelector('.cardOverlayButton').getBoundingClientRect();
          const nativeGroup=element.querySelector('.cardOverlayButton-br').getBoundingClientRect();
          const clearance=nativeGroup.left-poster.left<native.width?nativeGroup.height:6;
          check((element===movie?'MUI':'Legacy')+' '+width+' anchor/size',close(selected.left,poster.left)&&close(selected.bottom,poster.bottom-clearance)&&close(selected.width,native.width)&&close(selected.height,native.height),{selected,native,poster,clearance,style:element.querySelector('.jf-card-likes').getAttribute('style')});
          element.querySelector('.like').focus();await wait();
          check('Focus reveals both '+width,visible(element.querySelector('.like'))&&visible(element.querySelector('.dislike')));
          check('Focused native-size hit target stays background-free '+width,close(element.querySelector('.like').getBoundingClientRect().width,native.width)&&transparent(element.querySelector('.like'))&&transparent(element.querySelector('.dislike')));
          check('Chromium 83-compatible focus ring '+width,getComputedStyle(element.querySelector('.like')).outlineStyle==='solid');
          const actions=element.querySelector('.cardOverlayButton-br').getBoundingClientRect();
          for(const control of element.querySelectorAll('.jf-preference')) {
            const rect=control.getBoundingClientRect();
            check('No native collision '+width,rect.right<=actions.left+1||rect.bottom<=actions.top+1);
          }
          element.querySelector('.like').blur();
          check('Resting background clears after blur '+width,transparent(element.querySelector('.like')));
        }
        movie.style.transform='scale(.8)';await wait();
        const poster=movie.querySelector('.cardScalable').getBoundingClientRect(),selected=movie.querySelector('.like').getBoundingClientRect();
        check('Transformed poster stays anchored',close(selected.left,poster.left)&&close(selected.bottom,poster.bottom-6*.8));
        movie.style.transform='';
        const before=calls.length;const old=movie;movie.remove();const replacement=card(1);await wait();
        check('Sorting/navigation replacement',replacement.querySelectorAll('.jf-card-likes').length===1&&visible(replacement.querySelector('.like'))&&!old.querySelector('.jf-card-likes'));
        check('Replacement reuses state',calls.length===before);
        neutral.querySelector('.jf-reveal').click();await wait();
        check('Explicit reveal works',neutral.querySelector('.jf-reveal').getAttribute('aria-expanded')==='true'&&visible(neutral.querySelector('.like'))&&visible(neutral.querySelector('.dislike')));
        check('Touch-style reveal stays background-free',[...neutral.querySelectorAll('.jf-card-likes button')].every(transparent));
        neutral.querySelector('.like').blur();
        let navigation=0;document.getElementById('cards').addEventListener('click',()=>navigation++);
        replacement.querySelector('.like').click();await wait();
        check('Selection click does not navigate',navigation===0&&writes.join(',')==='clear');
        check('Duplicate cards agree',!related.querySelector('.like').classList.contains('selected'));
        window.__jellyfinLikesInstalled.dispose();
        check('Cleanup',!document.querySelector('.jf-card-likes'));
        document.getElementById('report').textContent=JSON.stringify({passed:true,checks});
      } catch(error) {document.getElementById('report').textContent=JSON.stringify({passed:false,checks,error:error.message});}},0);
    </script>`;
  const file = path.join(directory, 'fixture.html');
  await writeFile(file, html);
  const result = spawnSync(
    executable,
    [
      '--headless=new',
      '--dump-dom',
      '--virtual-time-budget=10000',
      '--run-all-compositor-stages-before-draw',
      '--disable-renderer-backgrounding',
      `--user-data-dir=${path.join(directory, 'profile')}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--no-proxy-server',
      '--allow-pre-commit-input',
      pathToFileURL(file).href,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    'The isolated headless fixture must exit successfully.'
  );
  const report = result.stdout.match(/<pre id="report">(.*?)<\/pre>/s)?.[1];
  assert.ok(
    report && report !== 'pending',
    `Fixture did not finish; evidence: ${file}`
  );
  const parsed = JSON.parse(report) as {
    passed: boolean;
    checks: { name: string; pass: boolean }[];
    error?: string;
  };
  assert.equal(parsed.passed, true, JSON.stringify(parsed));
  assert.ok(parsed.checks.length >= 35);
  assert.equal(
    parsed.checks.every((check) => check.pass),
    true
  );
  context.diagnostic(
    `${parsed.checks.length} rendered Chromium assertions passed; offline fixture: ${file}`
  );
});
