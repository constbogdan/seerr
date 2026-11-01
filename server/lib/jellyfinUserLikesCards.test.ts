import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

type Data = { Played: boolean; Likes?: boolean | null };
type Item = { Id: string; Type: string; UserData?: Data; SeriesId?: string };
type State = {
  known: boolean;
  rating: boolean | null;
  busy: boolean;
  failed: boolean;
};
const { createPreferences } = createRequire(__filename)(
  path.resolve('public/integrations/jellyfin-user-likes.js')
) as {
  createPreferences: (
    api: object,
    current: () => boolean,
    reads?: { active: number; wake: Set<() => void> }
  ) => {
    observe(id: string, data: Data, version?: number): void;
    notify(id: string, data: Data): void;
    fence(): number;
    subscribe(id: string, listener: (state: State) => void): () => void;
    load(id: string): void;
    cancelLoad(id: string): void;
    apply(
      id: string,
      value: boolean,
      current?: () => boolean,
      sourceId?: string
    ): Promise<{ rating: boolean | null; partial: boolean } | null>;
    dispose(): void;
  };
};
const id = (n: number) => n.toString(16).padStart(32, '0');
const USER = id(9000);
const SERVER = id(9001);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const items = new Map<string, Item>();
  const reads: {
    ids: string[];
    task: ReturnType<typeof deferred<{ Items: Item[] }>>;
  }[] = [];
  const writes: string[] = [];
  let current = true;
  let user = USER;
  let failWatched = false;
  const api = {
    getCurrentUserId: () => user,
    serverId: () => SERVER,
    deviceId: () => 'fixture',
    getSessions: async () => [
      { DeviceId: 'fixture', UserId: user, AdditionalUsers: [] },
    ],
    getItem: async (_user: string, key: string) =>
      structuredClone(items.get(key)),
    getItems: (_user: string, options: { Ids: string; Limit: number }) => {
      const ids = options.Ids.split(',');
      assert.equal(options.Limit, ids.length);
      const task = deferred<{ Items: Item[] }>();
      reads.push({ ids, task });
      return task.promise;
    },
    updateUserItemRating: async (
      _user: string,
      key: string,
      value: boolean
    ) => {
      writes.push(`rate:${value}`);
      items.get(key)!.UserData!.Likes = value;
    },
    clearUserItemRating: async (_user: string, key: string) => {
      writes.push('clear');
      items.get(key)!.UserData!.Likes = null;
    },
    markPlayed: async () => {
      writes.push('played');
      if (failWatched) throw Error('fixture');
    },
    markUnplayed: async () => {
      writes.push('unplayed');
      if (failWatched) throw Error('fixture');
    },
  };
  const store = createPreferences(api, () => current && user === USER);
  function add(n: number, rating: boolean | null = null, type = 'Movie') {
    const item: Item & { UserData: Data } = {
      Id: id(n),
      Type: type,
      UserData: { Played: false, Likes: rating },
    };
    items.set(item.Id, item);
    return item;
  }
  function watch(key: string) {
    let state!: State;
    const off = store.subscribe(key, (next) => {
      state = next;
    });
    return {
      get state() {
        return state;
      },
      off,
    };
  }
  return {
    api,
    store,
    add,
    watch,
    reads,
    writes,
    switchUser: () => {
      user = id(9002);
    },
    leave: () => {
      current = false;
    },
    fail: (value: boolean) => {
      failWatched = value;
    },
  };
}

describe('shared Jellyfin card preference state', () => {
  it('keeps Unknown distinct from Neutral, false and true; missing data never clears state', () => {
    const f = fixture();
    const item = f.add(1);
    const a = f.watch(item.Id);
    assert.equal(a.state.known, false);
    f.store.observe(item.Id, { Played: false });
    assert.equal(a.state.known, true);
    assert.equal(a.state.rating, null);
    f.store.observe(item.Id, { Played: false, Likes: false });
    assert.equal(a.state.rating, false);
    f.store.observe(item.Id, {} as Data);
    assert.equal(a.state.rating, false);
    f.store.observe(item.Id, { Played: false, Likes: true });
    assert.equal(a.state.rating, true);
  });
  it('deduplicates duplicate-card reads and shares mutation locks, results and V1 watched effects', async () => {
    const f = fixture();
    const item = f.add(1);
    const a = f.watch(item.Id);
    const b = f.watch(item.Id);
    f.store.load(item.Id);
    f.store.load(item.Id);
    await tick();
    assert.equal(f.reads.length, 1);
    f.reads[0].task.resolve({ Items: [item] });
    await tick();
    const write = f.store.apply(item.Id, false);
    assert.equal(a.state.busy, true);
    assert.equal(b.state.busy, true);
    assert.equal(await f.store.apply(item.Id, true), null);
    await write;
    assert.deepEqual(f.writes, ['rate:false', 'played']);
    assert.equal(a.state.rating, false);
    assert.equal(b.state.rating, false);
    await f.store.apply(item.Id, true);
    assert.deepEqual(f.writes, ['rate:false', 'played', 'rate:true']);
    assert.equal(a.state.rating, true);
    await f.store.apply(item.Id, true);
    assert.equal(a.state.rating, null);
    assert.equal(f.writes.at(-1), 'clear');
  });
  it('preserves a partial saved rating and retries only the watched step across duplicate cards', async () => {
    const f = fixture();
    const item = f.add(1, null, 'Series');
    const a = f.watch(item.Id);
    f.store.observe(item.Id, item.UserData!);
    f.fail(true);
    assert.equal((await f.store.apply(item.Id, false))?.partial, true);
    assert.equal(a.state.rating, false);
    a.off();
    const b = f.watch(item.Id);
    f.fail(false);
    assert.equal((await f.store.apply(item.Id, false))?.partial, false);
    assert.deepEqual(f.writes, ['rate:false', 'played', 'played']);
    await f.store.apply(item.Id, false);
    assert.equal(b.state.rating, null);
    assert.deepEqual(f.writes.slice(-2), ['clear', 'unplayed']);
  });
  it('revalidates detail Episode/Season parents on every action and rejects changed top-level identity', async () => {
    for (const type of ['Episode', 'Season']) {
      const f = fixture();
      const parent = f.add(1, null, 'Series');
      const child = f.add(2, null, type);
      child.SeriesId = parent.Id;
      f.watch(parent.Id);
      f.store.observe(parent.Id, parent.UserData!);
      await f.store.apply(parent.Id, false, () => true, child.Id);
      assert.deepEqual(f.writes, ['rate:false', 'played']);
      const other = f.add(3, null, 'Series');
      child.SeriesId = other.Id;
      await assert.rejects(
        f.store.apply(parent.Id, false, () => true, child.Id)
      );
      assert.deepEqual(f.writes, ['rate:false', 'played']);
    }
  });
  it('fences stale batch and detail/parent reads against later mutations and observations', async () => {
    const f = fixture();
    const item = f.add(1, null, 'Series');
    const a = f.watch(item.Id);
    const old = structuredClone(item);
    const fence = f.store.fence();
    f.store.load(item.Id);
    await tick();
    f.store.observe(item.Id, item.UserData!);
    await f.store.apply(item.Id, true);
    f.reads[0].task.resolve({ Items: [old] });
    f.store.observe(item.Id, old.UserData!, fence);
    await tick();
    assert.equal(a.state.rating, true);
    f.store.observe(item.Id, { Played: false, Likes: false });
    assert.equal(a.state.rating, false);
  });
  it('bounds batches at 50 and concurrency at two, including hung requests', async () => {
    const f = fixture();
    for (let n = 1; n <= 151; n++) {
      const item = f.add(n);
      f.watch(item.Id);
      f.store.load(item.Id);
    }
    await tick();
    assert.equal(f.reads.length, 2);
    assert.deepEqual(
      f.reads.map((row) => row.ids.length),
      [50, 50]
    );
    await tick();
    assert.equal(f.reads.length, 2);
    f.reads[0].task.resolve({ Items: [] });
    await tick();
    assert.equal(f.reads.length, 3);
    assert.equal(f.reads[2].ids.length, 50);
    f.reads[1].task.reject(Error('fixture'));
    await tick();
    assert.equal(f.reads.length, 4);
    assert.equal(f.reads[3].ids.length, 1);
    f.store.dispose();
    for (const row of f.reads.slice(2)) row.task.resolve({ Items: [] });
    await tick();
    assert.equal(f.reads.length, 4);
  });
  it('keeps the two-read limit across account changes until old requests really settle', async () => {
    const f = fixture();
    const reads = { active: 0, wake: new Set<() => void>() };
    const old = createPreferences(f.api, () => true, reads);
    for (let n = 1; n <= 101; n++) {
      old.subscribe(id(n), () => {});
      old.load(id(n));
    }
    await tick();
    assert.equal(f.reads.length, 2);
    old.dispose();
    const next = createPreferences(f.api, () => true, reads);
    next.subscribe(id(102), () => {});
    next.load(id(102));
    await tick();
    assert.equal(f.reads.length, 2);
    f.reads[0].task.resolve({ Items: [] });
    await tick();
    assert.equal(f.reads.length, 3);
    assert.deepEqual(f.reads[2].ids, [id(102)]);
    next.dispose();
    f.reads[1].task.resolve({ Items: [] });
    f.reads[2].task.resolve({ Items: [] });
    await tick();
    assert.equal(reads.active, 0);
    assert.equal(reads.wake.size, 0);
  });
  it('resolves notifications during a mutation with one bounded fresh read, not replayed stale data', async () => {
    const f = fixture();
    const item = f.add(1);
    const a = f.watch(item.Id);
    const old = structuredClone(item);
    f.store.load(item.Id);
    await tick();
    f.store.observe(item.Id, item.UserData!);
    const action = f.store.apply(item.Id, true);
    f.store.notify(item.Id, { Played: true, Likes: false });
    await action;
    await tick();
    assert.equal(a.state.rating, true);
    assert.equal(f.reads.length, 1);
    f.reads[0].task.resolve({ Items: [old] });
    await tick();
    assert.equal(f.reads.length, 2);
    assert.equal(a.state.rating, true);
    f.reads[1].task.resolve({ Items: [item] });
    await tick();
    assert.equal(a.state.rating, true);
    assert.deepEqual(f.writes, ['rate:true']);
  });
  it('bounds cache at 512, evicts unused entries and does not evict subscribed or busy entries', async () => {
    const f = fixture();
    const subscriptions = [];
    for (let n = 1; n <= 512; n++) subscriptions.push(f.watch(f.add(n).Id));
    let extra = false;
    const off = f.store.subscribe(id(513), () => {
      extra = true;
    });
    assert.equal(extra, false);
    off();
    subscriptions[0].off();
    f.store.subscribe(id(513), () => {
      extra = true;
    });
    assert.equal(extra, true);
    assert.equal(subscriptions[1].state.known, false);
  });
  it('cancels detached/offscreen pending reads and does not automatically retry failed reads', async () => {
    const f = fixture();
    const item = f.add(1);
    const a = f.watch(item.Id);
    f.store.load(item.Id);
    f.store.cancelLoad(item.Id);
    await tick();
    assert.equal(f.reads.length, 0);
    f.store.load(item.Id);
    await tick();
    f.reads[0].task.reject(Error('fixture'));
    await tick();
    assert.equal(a.state.known, false);
    assert.equal(a.state.failed, true);
    await tick();
    assert.equal(f.reads.length, 1);
    f.store.load(item.Id);
    await tick();
    assert.equal(f.reads.length, 2);
    a.off();
    f.reads[1].task.resolve({ Items: [] });
  });
  it('rejects stale-user/server results and actions and removes subscriptions on disposal', async () => {
    const f = fixture();
    const item = f.add(1);
    const a = f.watch(item.Id);
    f.store.load(item.Id);
    await tick();
    f.switchUser();
    f.reads[0].task.resolve({ Items: [item] });
    await tick();
    assert.equal(a.state.known, false);
    assert.equal(await f.store.apply(item.Id, false), null);
    assert.deepEqual(f.writes, []);
    f.store.dispose();
    f.store.observe(item.Id, { Played: true, Likes: true });
    assert.equal(a.state.known, false);
  });
  it('preserves prior confirmed state if a rating write fails, without compensating writes', async () => {
    const f = fixture();
    const item = f.add(1, true);
    const a = f.watch(item.Id);
    f.store.observe(item.Id, item.UserData!);
    f.api.updateUserItemRating = async () => {
      throw Error('fixture');
    };
    await assert.rejects(f.store.apply(item.Id, false));
    assert.equal(a.state.rating, true);
    assert.equal(a.state.failed, true);
    assert.equal(a.state.busy, false);
    assert.deepEqual(f.writes, []);
  });
});

// A deterministic DOM fixture exercises the installed controller and real helpers.
// It does not pretend to validate CSS layout or an authenticated Jellyfin server.
function domFixture() {
  const f = fixture();
  f.add(1, true);
  f.add(2, false, 'Series');
  f.add(3);
  const env = runInNewContext(
    String.raw`(() => {
    class Element {
      constructor(tag='div') { this.tagName=tag.toUpperCase(); this.children=[]; this.dataset={}; this.listeners={}; this.attributes={}; this.className=''; this.style={setProperty(name,value){this[name]=value;}};
        this.classList={contains:name=>this.className.split(' ').includes(name),toggle:(name,on)=>{const classes=new Set(this.className.split(' ').filter(Boolean)); const yes=on??!classes.has(name);yes?classes.add(name):classes.delete(name);this.className=[...classes].join(' ');return yes;},remove:name=>this.classList.toggle(name,false)}; }
      get isConnected() {return this.connected||!!this.parentElement?.isConnected;}
      appendChild(node) {node.remove();this.children.push(node);node.parentElement=this;return node;}
      remove() {if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);this.parentElement=null;}
      after(node) {this.parentElement.appendChild(node);}
      setAttribute(name,value){this.attributes[name]=value;}
      getAttribute(name){return this.attributes[name]??null;}
      addEventListener(name,fn){(this.listeners[name]??=new Set()).add(fn);}
      removeEventListener(name,fn){this.listeners[name]?.delete(fn);}
      matches(selector){return selector.split(',').some(part=>{part=part.trim();const tag=part.match(/^[a-z]+/i)?.[0];if(tag&&tag.toUpperCase()!==this.tagName)return false;
        if(part.startsWith('#'))return this.id===part.slice(1);
        if([...part.matchAll(/\.([\w-]+)/g)].some(m=>!this.classList.contains(m[1])))return false;
        if([...part.matchAll(/\[data-([\w-]+)\]/g)].some(m=>this.dataset[m[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]===undefined))return false;
        return !part.includes(':not')||!this.classList.contains('hide');});}
      closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
      querySelectorAll(selector){return selector.split(',').flatMap(part=>{const pieces=part.split('>').map(s=>s.trim());let nodes;if(pieces[0]===':scope'){nodes=[this];pieces.shift();}else{const all=node=>node.children.flatMap(n=>[n,...all(n)]);const first=pieces.shift();nodes=all(this).filter(n=>n.matches(first));}for(const piece of pieces)nodes=nodes.flatMap(n=>n.children.filter(c=>c.matches(piece)));return nodes;});}
      querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
      getBoundingClientRect(){return this.rect||{height:4,width:180};}
      get offsetWidth(){return this.rect?.width||0;} get offsetHeight(){return this.rect?.height||0;}
      get offsetLeft(){return this.rect?.left||0;} get clientWidth(){return this.offsetWidth;}
    }
    const body=new Element();body.connected=true;const head=new Element();head.connected=true;
    const document=new Element();Object.assign(document,{body,head,createElement:tag=>new Element(tag)});
    let detail=null;
    document.querySelector=selector=>selector.includes('itemDetailPage')?detail:body.querySelector(selector);
    document.querySelectorAll=selector=>body.querySelectorAll(selector);
    const window=new Element();const observers=[];const intersections=[];const resizes=[];
    class MutationObserver{constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}
    class IntersectionObserver{constructor(fn){this.fn=fn;intersections.push(this);this.targets=new Set();}observe(n){this.targets.add(n);}unobserve(n){this.targets.delete(n);}disconnect(){this.targets.clear();}}
    class ResizeObserver{constructor(fn){this.fn=fn;resizes.push(this);this.targets=new Set();}observe(n){this.targets.add(n);}unobserve(n){this.targets.delete(n);}disconnect(){this.targets.clear();}}
    function card(id,type='Movie',server='${SERVER}',legacy=true){const card=new Element();card.className='card';card.dataset={id,type,serverid:server};const scalable=new Element();scalable.className='cardScalable';card.appendChild(scalable);const content=new Element(legacy?'a':'div');content.className=legacy?'cardImageContainer cardContent':'cardContent';scalable.appendChild(content);body.appendChild(card);return card;}
    function library(id,type='Movie',server='${SERVER}') {const item=card(id,type,server,false);item.className='card portraitCard card-hoverable card-withuserdata';item.dataset.context=type==='Movie'?'movies':'tvshows';
      const scalable=item.children[0];const image=new Element();image.className='cardImageContainer coveredImage';scalable.children[0].appendChild(image);
      const overlay=new Element();overlay.className='cardOverlayContainer itemAction MuiBox-root css-0';const link=new Element('a');link.className='cardImageContainer';link.setAttribute('href','#/details?id='+id+'&serverId='+server);overlay.appendChild(link);
      const actions=new Element();actions.className='MuiButtonGroup-root cardOverlayButton-br flex';actions.rect={width:90,height:30,left:90};overlay.appendChild(actions);const button=new Element('button');button.className='MuiIconButton-root cardOverlayButton';button.rect={width:30,height:30};const icon=new Element('svg');icon.computed={fontSize:'24px'};button.appendChild(icon);actions.appendChild(button);scalable.appendChild(overlay);scalable.rect={width:180,height:270};return item;}
    const location={hash:'#/home'};
    function details(id){detail=new Element();detail.className='itemDetailPage';const bar=new Element();bar.className='detailButtons';const favorite=new Element();favorite.className='btnFavorite';body.appendChild(detail);detail.appendChild(bar);bar.appendChild(favorite);detail.querySelector=()=>bar;location.hash='#/details?id='+id;return bar;}
    const events=new Set();window.Events={on:(source,name,fn)=>events.add(fn),off:(source,name,fn)=>events.delete(fn)};window.ServerNotifications={};
    return {window,document,Element,MutationObserver,IntersectionObserver,ResizeObserver,observers,intersections,resizes,events,card,library,details,location,URLSearchParams,queueMicrotask,getComputedStyle:node=>node.computed||{right:'0px',bottom:'0px',fontSize:'16px'},setTimeout:()=>0};
  })()`,
    { URLSearchParams, queueMicrotask }
  );
  env.window.ApiClient = f.api;
  const source = readFileSync(
    path.resolve('public/integrations/jellyfin-user-likes.js'),
    'utf8'
  );
  const run = () => runInNewContext(source, env);
  const fire = (host: typeof env.window, name: string) => {
    for (const listener of host.listeners[name] || [])
      listener({ target: host });
  };
  const scan = async () => {
    fire(env.window, 'hashchange');
    await tick();
  };
  const visible = () =>
    env.intersections[0].fn(
      [...env.intersections[0].targets].map((target: object) => ({
        target,
        isIntersecting: true,
      }))
    );
  return { ...f, env, run, fire, scan, visible };
}

describe('standard card injection lifecycle', () => {
  it('parses the exact shipped script as ES2020, rejecting the logical-assignment regression', () => {
    // Reuse the existing ESLint parser; no runtime dependency or transpilation.
    const { parse } = createRequire(require.resolve('eslint/package.json'))(
      'espree'
    ) as {
      parse(source: string, options: { ecmaVersion: number }): unknown;
    };
    assert.throws(
      () =>
        parse('let subscription; subscription ||= true;', {
          ecmaVersion: 2020,
        }),
      /Unexpected token/
    );
    const source = readFileSync(
      path.resolve('public/integrations/jellyfin-user-likes.js'),
      'utf8'
    );
    assert.doesNotThrow(() => parse(source, { ecmaVersion: 2020 }));
  });
  it('keeps details and V1 actions working without either card observer API', async () => {
    for (const name of ['IntersectionObserver', 'ResizeObserver']) {
      const f = domFixture();
      const card = f.env.library(id(1));
      const bar = f.env.details(id(1));
      f.env[name] = undefined;
      f.run();
      await tick();
      assert.equal(card.querySelector('.jf-card-likes'), null);
      assert.equal(bar.children.length, 2);
      assert.equal(bar.children[1].children[0].disabled, false);
      const event = { preventDefault() {}, stopPropagation() {} };
      for (const listener of bar.children[1].children[1].listeners.click)
        await listener(event);
      assert.deepEqual(f.writes, ['rate:false', 'played']);
      assert.equal(f.reads.length, 0);
      f.env.window.__jellyfinLikesInstalled.dispose();
      assert.equal(bar.children.length, 1);
      assert.equal(f.env.events.size, 0);
    }
  });
  it('contains card observer constructor failures and follows SPA detail navigation', async () => {
    for (const name of ['IntersectionObserver', 'ResizeObserver']) {
      const f = domFixture();
      const bar = f.env.details(id(1));
      f.env[name] = class {
        constructor() {
          throw Error('fixture constructor failure');
        }
      };
      f.run();
      await tick();
      assert.equal(bar.children[1].children[0].disabled, false);
      f.env.location.hash = `#/details?id=${id(2)}`;
      await f.scan();
      assert.equal(bar.children.length, 2);
      assert.equal(bar.children[1].dataset.itemId, id(2));
      assert.equal(
        bar.children[1].children[1].attributes['aria-pressed'],
        'true'
      );
      f.env.window.__jellyfinLikesInstalled.dispose();
      assert.equal(
        f.env.intersections.every(
          (observer: { targets: Set<unknown> }) => observer.targets.size === 0
        ),
        true
      );
      assert.equal(f.reads.length, 0);
    }
  });
  it('contains card discovery and asynchronous positioning failures without disabling details', async () => {
    for (const failure of ['discovery', 'position']) {
      const f = domFixture();
      const card = f.env.library(id(1));
      const bar = f.env.details(id(1));
      if (failure === 'discovery') {
        const query = f.env.document.body.querySelectorAll.bind(
          f.env.document.body
        );
        f.env.document.body.querySelectorAll = (selector: string) => {
          if (selector.startsWith('.card['))
            throw Error('fixture discovery failure');
          return query(selector);
        };
      } else
        f.env.getComputedStyle = () => {
          throw Error('fixture positioning failure');
        };
      f.run();
      await tick();
      if (failure === 'position') {
        f.visible();
        await tick();
      }
      assert.equal(card.querySelector('.jf-card-likes'), null);
      assert.equal(bar.children[1].children[0].disabled, false);
      assert.equal(
        bar.children[1].children[0].attributes['aria-pressed'],
        'true'
      );
      assert.equal(f.reads.length, 0);
      assert.equal(f.env.intersections[0].targets.size, 0);
      assert.equal(f.env.resizes[0].targets.size, 0);
      f.env.window.__jellyfinLikesInstalled.dispose();
      assert.equal(f.env.observers[0].disconnected, true);
    }
  });
  it('falls back to V1 MutationObserver options if optional card attributes are rejected', async () => {
    const f = domFixture();
    const bar = f.env.details(id(1));
    const options: object[] = [];
    f.env.MutationObserver.prototype.observe = (
      _target: unknown,
      value: { attributes?: boolean }
    ) => {
      options.push(value);
      if (value.attributes)
        throw Error('fixture attribute observation unsupported');
    };
    f.run();
    await tick();
    assert.equal(options.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(options[1])), {
      childList: true,
      subtree: true,
    });
    assert.equal(bar.children[1].children[0].disabled, false);
    f.env.window.__jellyfinLikesInstalled.dispose();
  });
  it('treats native notification hooks as optional without changing shared action semantics', async () => {
    const f = domFixture();
    const bar = f.env.details(id(1));
    f.env.window.Events.on = () => {
      throw Error('fixture notification attach failure');
    };
    f.env.window.Events.off = () => {
      throw Error('fixture notification detach failure');
    };
    f.run();
    await tick();
    assert.equal(bar.children[1].children[0].disabled, false);
    for (const listener of bar.children[1].children[0].listeners.click)
      await listener({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(f.writes, ['clear']);
    f.env.window.__jellyfinLikesInstalled.dispose();
    assert.equal(f.env.window.__jellyfinLikesInstalled, undefined);
    assert.equal(f.env.observers[0].disconnected, true);
  });
  it('enhances the supplied primary Movie/Series grid structure and retains recommendation, Home and Search cards', async () => {
    const f = domFixture();
    const movie = f.env.library(id(1));
    const series = f.env.library(id(2), 'Series');
    const moreLike = f.env.card(id(1));
    const home = f.env.card(id(2), 'Series');
    const search = f.env.card(id(1));
    f.run();
    await tick();
    for (const card of [movie, series, moreLike, home, search]) {
      const root = card.querySelector('.jf-card-likes');
      assert.ok(root);
      assert.equal(root.parentElement, card.querySelector('.cardScalable'));
      assert.equal(root.closest('a'), null);
      assert.equal(card.querySelectorAll('.jf-card-likes').length, 1);
    }
    f.visible();
    await tick();
    assert.equal(f.reads.length, 1);
    assert.deepEqual(f.reads[0].ids, [id(1), id(2)]);
    f.reads[0].task.resolve({
      Items: [f.add(1, true), f.add(2, false, 'Series')],
    });
    await tick();
    assert.equal(
      movie.querySelector('.like').attributes['aria-pressed'],
      'true'
    );
    assert.equal(
      series.querySelector('.dislike').attributes['aria-pressed'],
      'true'
    );
    assert.equal(
      moreLike.querySelector('.like').attributes['aria-pressed'],
      'true'
    );
    f.env.window.__jellyfinLikesInstalled.dispose();
  });
  it('rejects unsupported types and mismatched new-renderer navigation identities', async () => {
    const f = domFixture();
    const episode = f.env.library(id(1), 'Episode');
    const season = f.env.library(id(2), 'Season');
    const mismatch = f.env.library(id(1));
    mismatch
      .querySelector('a')
      .setAttribute('href', `#/details?id=${id(2)}&serverId=${SERVER}`);
    const wrongServer = f.env.library(id(1));
    wrongServer
      .querySelector('a')
      .setAttribute('href', `#/details?id=${id(1)}&serverId=${id(99)}`);
    f.run();
    await tick();
    for (const card of [episode, season, mismatch, wrongServer])
      assert.equal(card.querySelector('.jf-card-likes'), null);
    f.env.window.__jellyfinLikesInstalled.dispose();
  });
  it('enhances sorting/navigation replacements from mutation subtrees without a whole-document rescan', async () => {
    const f = domFixture();
    const card = f.env.library(id(1));
    let fullScans = 0;
    const queryAll = f.env.document.body.querySelectorAll.bind(
      f.env.document.body
    );
    f.env.document.body.querySelectorAll = (selector: string) => {
      if (selector.startsWith('.card[')) fullScans++;
      return queryAll(selector);
    };
    f.run();
    await tick();
    f.visible();
    await tick();
    f.reads[0].task.resolve({ Items: [f.add(1, true)] });
    await tick();
    assert.equal(fullScans, 1);
    const old = card.querySelector('.jf-card-likes');
    card.remove();
    const container = new f.env.Element();
    f.env.document.body.appendChild(container);
    const replacement = f.env.library(id(1));
    container.appendChild(replacement);
    f.env.observers[0].fn([
      {
        type: 'childList',
        target: f.env.document.body,
        addedNodes: [container],
        removedNodes: [card],
      },
    ]);
    await tick();
    f.visible();
    await tick();
    assert.equal(old.isConnected, false);
    assert.equal(replacement.querySelectorAll('.jf-card-likes').length, 1);
    assert.equal(
      replacement.querySelector('.like').attributes['aria-pressed'],
      'true'
    );
    assert.equal(f.reads.length, 1);
    assert.equal(fullScans, 1);
    // A recycled card's identity changes in place, without replacing its node.
    replacement.dataset.id = id(2);
    replacement.dataset.type = 'Series';
    replacement
      .querySelector('a')
      .setAttribute('href', `#/details?id=${id(2)}&serverId=${SERVER}`);
    f.env.observers[0].fn([
      { type: 'attributes', attributeName: 'data-id', target: replacement },
    ]);
    await tick();
    f.visible();
    await tick();
    assert.equal(replacement.querySelectorAll('.jf-card-likes').length, 1);
    assert.equal(replacement.querySelector('.like').disabled, true);
    assert.deepEqual(f.reads[1].ids, [id(2)]);
    assert.equal(fullScans, 1);
    f.reads[1].task.resolve({ Items: [f.add(2, false, 'Series')] });
    await tick();
    assert.equal(
      replacement.querySelector('.dislike').attributes['aria-pressed'],
      'true'
    );
    f.env.window.__jellyfinLikesInstalled.dispose();
  });
  it('supports only legacy Movie/Series, outside links; batches duplicate visible cards and injects once', async () => {
    const f = domFixture();
    const movie = f.env.card(id(1));
    const duplicate = f.env.card(id(1));
    const series = f.env.card(id(2), 'Series');
    const episode = f.env.card(id(3), 'Episode');
    const season = f.env.card(id(4), 'Season');
    const react = f.env.card(id(5), 'Movie', SERVER, false);
    const other = f.env.card(id(6), 'Movie', id(99));
    f.run();
    await tick();
    for (const card of [movie, duplicate, series]) {
      assert.equal(
        card.children[0].children[1].className,
        'jf-card-likes unknown'
      );
      assert.equal(
        card.children[0].children[1].parentElement,
        card.children[0]
      );
    }
    for (const card of [episode, season, react, other])
      assert.equal(card.children[0].children.length, 1);
    assert.equal(f.reads.length, 0);
    f.visible();
    await tick();
    assert.equal(f.reads.length, 1);
    assert.deepEqual(f.reads[0].ids, [id(1), id(2)]);
    f.reads[0].task.resolve({
      Items: [f.add(1, true), f.add(2, false, 'Series')],
    });
    await tick();
    assert.match(
      movie.children[0].children[1].children[0].className,
      /selected/
    );
    assert.match(
      series.children[0].children[1].children[1].className,
      /selected/
    );
    f.run();
    await f.scan();
    assert.equal(movie.children[0].children.length, 2);
    f.env.window.__jellyfinLikesInstalled.dispose();
    assert.equal(movie.children[0].children.length, 1);
    assert.equal(f.env.events.size, 0);
    assert.equal(f.env.intersections[0].targets.size, 0);
    assert.equal(f.env.resizes[0].targets.size, 0);
    assert.equal(f.env.observers[0].disconnected, true);
  });
  it('stops card navigation; supports touch reveal, shared updates, DOM replacement and identity recycling', async () => {
    const f = domFixture();
    const card = f.env.card(id(1));
    const duplicate = f.env.card(id(1));
    f.run();
    await tick();
    f.visible();
    await tick();
    f.reads[0].task.resolve({ Items: [f.add(1, true)] });
    await tick();
    const root = card.children[0].children[1];
    let prevented = 0;
    let stopped = 0;
    const event = {
      preventDefault: () => prevented++,
      stopPropagation: () => stopped++,
    };
    for (const listener of root.children[2].listeners.click)
      await listener(event);
    assert.equal(root.attributes['aria-expanded'], undefined);
    assert.equal(root.children[2].attributes['aria-expanded'], 'true');
    for (const listener of root.children[0].listeners.click)
      await listener(event);
    assert.equal(prevented, 2);
    assert.equal(stopped, 2);
    assert.deepEqual(f.writes, ['clear']);
    assert.doesNotMatch(
      duplicate.children[0].children[1].children[0].className,
      /selected/
    );
    card.remove();
    await f.scan();
    assert.equal(root.isConnected, false);
    const replacement = f.env.card(id(1));
    f.env.observers[0].fn([
      {
        type: 'childList',
        target: f.env.document.body,
        addedNodes: [replacement],
        removedNodes: [],
      },
    ]);
    await f.scan();
    f.visible();
    await tick();
    assert.equal(f.reads.length, 1); // Reuses confirmed Neutral, not another provider call.
    replacement.dataset.type = 'Episode';
    f.env.observers[0].fn([{ type: 'attributes', target: replacement }]);
    await tick();
    assert.equal(replacement.children[0].children.length, 1);
    f.env.window.__jellyfinLikesInstalled.dispose();
  });
  it('cleans old account controls and notifications and ignores late old-user reads', async () => {
    const f = domFixture();
    const card = f.env.card(id(1));
    f.run();
    await tick();
    f.visible();
    await tick();
    const root = card.children[0].children[1];
    f.switchUser();
    await f.scan();
    assert.equal(root.isConnected, false);
    assert.equal(f.env.events.size, 1);
    f.reads[0].task.resolve({ Items: [f.add(1, true)] });
    await tick();
    assert.equal(card.children[0].children[1].children[0].disabled, true);
    f.env.window.__jellyfinLikesInstalled.dispose();
  });
  it('uses native unscaled sizes, keeps the bottom anchor and stacks only to avoid native actions', async () => {
    const f = domFixture();
    const card = f.env.card(id(1));
    const scalable = card.children[0];
    scalable.rect = { width: 120, height: 180 };
    const footer = new f.env.Element();
    footer.className = 'innerCardFooter';
    footer.rect = { width: 120, height: 8 };
    const actions = new f.env.Element();
    actions.className = 'cardOverlayButton-br';
    actions.rect = { width: 90, height: 32, left: 30 };
    const button = new f.env.Element('button');
    button.rect = { width: 28, height: 32 };
    actions.appendChild(button);
    scalable.appendChild(footer);
    scalable.appendChild(actions);
    f.run();
    await tick();
    f.visible();
    await tick();
    const root = scalable.children[3];
    assert.equal(root.style['--jf-likes-bottom'], '8px');
    assert.equal(root.style['--jf-likes-width'], '28px');
    assert.equal(root.style['--jf-likes-height'], '32px');
    assert.equal(root.classList.contains('stacked'), true);
    scalable.rect.width = 240;
    actions.rect.left = 150;
    f.env.resizes[0].fn([{ target: scalable }]);
    assert.equal(root.style['--jf-likes-bottom'], '8px');
    assert.equal(root.classList.contains('stacked'), false);
    // Theme transforms affect rectangles, not offset dimensions.
    scalable.getBoundingClientRect = () => ({ width: 480, height: 720 });
    actions.getBoundingClientRect = () => ({ width: 180, height: 64 });
    f.env.resizes[0].fn([{ target: scalable }]);
    assert.equal(root.style['--jf-likes-height'], '32px');
    assert.equal(root.style['--jf-likes-bottom'], '8px');
    actions.rect.left = 20;
    f.env.resizes[0].fn([{ target: actions }]);
    assert.equal(root.style['--jf-likes-bottom'], '32px');
    footer.remove();
    f.env.observers[0].fn([
      { type: 'childList', addedNodes: [], removedNodes: [footer] },
    ]);
    await tick();
    assert.equal(root.isConnected, false);
    assert.equal(f.env.resizes[0].targets.has(footer), false);
    f.env.window.__jellyfinLikesInstalled.dispose();
    assert.equal(f.env.resizes[0].targets.size, 0);
  });
  it('shares detail/card state in both directions and accepts only this API client native notifications', async () => {
    const f = domFixture();
    const card = f.env.card(id(1));
    const bar = f.env.details(id(1));
    f.run();
    await tick();
    f.visible();
    await tick();
    const root = card.children[0].children[1];
    const detail = bar.children[1];
    assert.equal(detail.children[0].attributes['aria-pressed'], 'true');
    const event = { preventDefault() {}, stopPropagation() {} };
    for (const listener of root.children[0].listeners.click)
      await listener(event);
    assert.equal(detail.children[0].attributes['aria-pressed'], 'false');
    for (const listener of detail.children[1].listeners.click)
      await listener(event);
    assert.equal(root.children[1].attributes['aria-pressed'], 'true');
    assert.deepEqual(f.writes, ['clear', 'rate:false', 'played']);
    for (const listener of f.env.events)
      listener(null, {}, { ItemId: id(1), Played: false, Likes: true });
    assert.equal(detail.children[1].attributes['aria-pressed'], 'true');
    for (const listener of f.env.events)
      listener(null, f.api, { ItemId: id(1), Played: false, Likes: true });
    assert.equal(detail.children[0].attributes['aria-pressed'], 'true');
    assert.equal(root.children[0].attributes['aria-pressed'], 'true');
    f.env.window.__jellyfinLikesInstalled.dispose();
  });
  it('declares bottom-left selected-only persistence, hover/focus and coarse-pointer reveal without polling', () => {
    const source = readFileSync(
      path.resolve('public/integrations/jellyfin-user-likes.js'),
      'utf8'
    );
    assert.match(
      source,
      /left:var\(--jf-likes-inset, 0px\); bottom:var\(--jf-likes-bottom/
    );
    assert.match(
      source,
      /\.jf-preference:not\(\.selected\).*width:0; height:0; opacity:0/
    );
    assert.match(source, /\.card:hover .*\.card:focus-within/);
    assert.match(source, /@media \(hover:none\), \(pointer:coarse\)/);
    assert.match(source, /\.like.selected[^{}]*\{ color:#03a9f4/);
    assert.match(source, /\.dislike.selected[^{}]*\{ color:#f44336/);
    assert.doesNotMatch(
      source,
      /setInterval\(|accessToken\(|localStorage|sessionStorage|fetch\(/
    );
  });
  it('keeps all backgrounds transparent with native gray icons and blue/red hover, focus and selected states', () => {
    const source = readFileSync(
      path.resolve('public/integrations/jellyfin-user-likes.js'),
      'utf8'
    );
    const style = source.match(/style\.textContent = `([\s\S]*?)`;/)?.[1];
    assert.ok(style);
    assert.match(
      style,
      /\.jf-card-likes button \{[^}]*background:transparent !important;[^}]*text-shadow:/
    );
    assert.match(
      style,
      /font-size:calc\(var\(--jf-likes-icon, 1\.5em\) \* \.8\)/
    );
    const backgrounds = [...style.matchAll(/background:([^;}]*)/g)].map(
      (match) => match[1].trim()
    );
    assert.deepEqual(backgrounds, [
      'transparent !important',
      'transparent !important',
    ]);
    for (const scope of ['#${ROOT_ID}', '.jf-card-likes']) {
      for (const [kind, color] of [
        ['like', '#03a9f4'],
        ['dislike', '#f44336'],
      ]) {
        assert.ok(
          style.includes(
            `${scope} .${kind}.selected, ${scope} .${kind}:hover:not(:disabled), ${scope} .${kind}:focus { color:${color}; }`
          )
        );
      }
    }
    assert.match(
      style,
      /\.jf-like-button \{[^}]*color:rgba\(255,255,255,\.76\)/
    );
    assert.match(
      style,
      /\.jf-card-likes button \{[^}]*color:rgba\(255,255,255,\.76\)/
    );
    assert.match(style, /button:focus \{ outline:2px solid white/);
    assert.match(
      style,
      /width:var\(--jf-likes-width, 2\.5em\); height:var\(--jf-likes-height, 2\.5em\)/
    );
    assert.doesNotMatch(style, /background:rgba\(0,0,0,\.8\)/);
  });
});
