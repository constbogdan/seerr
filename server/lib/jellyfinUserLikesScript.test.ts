import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

const { createActions } = createRequire(__filename)(
  path.resolve('public/integrations/jellyfin-user-likes.js')
);
const USER = '11111111111111111111111111111111';
const ITEM = '22222222222222222222222222222222';
const SERIES = '33333333333333333333333333333333';
const UNKNOWN = '44444444444444444444444444444444';
const fixture = (type = 'Movie', rating: boolean | null = null) => {
  const calls: unknown[][] = [];
  let current = true;
  let user = USER;
  let additional: unknown[] = [];
  let failed = false;
  const child = {
    Id: ITEM,
    Type: type,
    SeriesId: SERIES,
    UserData: { Played: false, Likes: rating },
  };
  const parent = {
    Id: SERIES,
    Type: 'Series',
    UserData: { Played: false, Likes: rating },
  };
  const api = {
    getCurrentUserId: () => user,
    serverId: () => 'server',
    deviceId: () => 'device',
    getSessions: async () => [
      { UserId: USER, DeviceId: 'device', AdditionalUsers: additional },
    ],
    getItem: async (_user: string, id: string) =>
      id === SERIES ? parent : child,
    updateUserItemRating: async (...args: unknown[]) => {
      calls.push(['rate', ...args]);
      (['Season', 'Episode'].includes(type) ? parent : child).UserData.Likes =
        args[2] as boolean;
    },
    clearUserItemRating: async (...args: unknown[]) => {
      calls.push(['clear', ...args]);
      (['Season', 'Episode'].includes(type) ? parent : child).UserData.Likes =
        null;
    },
    markPlayed: async (...args: unknown[]) => {
      calls.push(['played', ...args]);
      if (failed) throw new Error('isolated failure');
    },
    markUnplayed: async (...args: unknown[]) => {
      calls.push(['unplayed', ...args]);
      if (failed) throw new Error('isolated failure');
    },
  };
  return {
    api,
    child,
    parent,
    calls,
    actions: createActions(api, () => current),
    leave: () => {
      current = false;
    },
    switchUser: () => {
      user = UNKNOWN;
    },
    addUser: () => {
      additional = [{}];
    },
    fail: (value: boolean) => {
      failed = value;
    },
  };
};

describe('maintained Jellyfin Like/Dislike candidate', () => {
  for (const type of ['Movie', 'Series', 'Episode', 'Season']) {
    it(`${type} Like targets the top-level identity without changing watched state`, async () => {
      const f = fixture(type);
      assert.deepEqual(await f.actions.apply(ITEM, true), {
        rating: true,
        partial: false,
      });
      assert.deepEqual(f.calls, [
        [
          'rate',
          USER,
          ['Episode', 'Season'].includes(type) ? SERIES : ITEM,
          true,
        ],
      ]);
    });
    it(`${type} Dislike rates first and invokes one native watched operation`, async () => {
      const f = fixture(type);
      await f.actions.apply(ITEM, false);
      const id = ['Episode', 'Season'].includes(type) ? SERIES : ITEM;
      assert.deepEqual(f.calls, [
        ['rate', USER, id, false],
        ['played', USER, id],
      ]);
    });
  }
  it('Like -> Neutral clears only the rating', async () => {
    const f = fixture('Movie', true);
    assert.deepEqual(await f.actions.apply(ITEM, true), {
      rating: null,
      partial: false,
    });
    assert.deepEqual(f.calls, [['clear', USER, ITEM]]);
  });
  it('Dislike -> Neutral clears the rating then marks the Series unwatched', async () => {
    const f = fixture('Episode', false);
    assert.deepEqual(await f.actions.apply(ITEM, false), {
      rating: null,
      partial: false,
    });
    assert.deepEqual(f.calls, [
      ['clear', USER, SERIES],
      ['unplayed', USER, SERIES],
    ]);
  });
  it('Dislike -> Like deliberately does not mark unwatched', async () => {
    const f = fixture('Movie', false);
    await f.actions.apply(ITEM, true);
    assert.deepEqual(f.calls, [['rate', USER, ITEM, true]]);
  });
  it('rejects missing and mismatched parents and unsupported item types before writes', async () => {
    const f = fixture('Season');
    f.child.SeriesId = '';
    await assert.rejects(f.actions.apply(ITEM, false));
    f.child.SeriesId = SERIES;
    f.parent.Id = UNKNOWN;
    await assert.rejects(f.actions.apply(ITEM, false));
    f.parent.Id = SERIES;
    f.parent.Type = 'Movie';
    await assert.rejects(f.actions.apply(ITEM, false));
    await assert.rejects(fixture('Audio').actions.apply(ITEM, true));
    assert.equal(f.calls.length, 0);
  });
  it('rejects additional, unverifiable and switched-user sessions', async () => {
    const f = fixture();
    f.addUser();
    await assert.rejects(f.actions.apply(ITEM, false));
    f.switchUser();
    await assert.rejects(f.actions.apply(ITEM, false));
    const absent = fixture();
    Object.assign(absent.api, { getSessions: undefined });
    await assert.rejects(absent.actions.apply(ITEM, false));
    assert.equal(f.calls.length, 0);
    assert.equal(absent.calls.length, 0);
  });
  it('rejects stale SPA actions and prevents overlapping duplicate submissions', async () => {
    const f = fixture();
    const first = f.actions.apply(ITEM, false);
    assert.equal(await f.actions.apply(ITEM, false), null);
    await first;
    assert.equal(f.calls.length, 2);
    f.leave();
    await assert.rejects(f.actions.apply(ITEM, true));
  });
  it('reports partial failure and retries the failed watched step without toggling rating', async () => {
    const f = fixture();
    f.fail(true);
    assert.deepEqual(await f.actions.apply(ITEM, false), {
      rating: false,
      partial: true,
    });
    f.fail(false);
    assert.deepEqual(await f.actions.apply(ITEM, false), {
      rating: false,
      partial: false,
    });
    assert.deepEqual(
      f.calls.map((c) => c[0]),
      ['rate', 'played', 'played']
    );
  });
  it('does not continue a two-step write after navigation or account change', async () => {
    const f = fixture();
    f.api.updateUserItemRating = async () => {
      f.leave();
    };
    await assert.rejects(f.actions.apply(ITEM, false));
    assert.equal(f.calls.length, 0);
  });
  it('does not reuse partial retry evidence after another client changes the rating', async () => {
    const f = fixture();
    f.fail(true);
    await f.actions.apply(ITEM, false);
    f.child.UserData.Likes = true;
    f.fail(false);
    await f.actions.apply(ITEM, false);
    assert.deepEqual(
      f.calls.map((c) => c[0]),
      ['rate', 'played', 'rate', 'played']
    );
  });
  it('preserves partial Neutral reversal for a retry of only mark-unplayed', async () => {
    const f = fixture('Season', false);
    f.fail(true);
    assert.deepEqual(await f.actions.apply(ITEM, false), {
      rating: null,
      partial: true,
    });
    f.fail(false);
    await f.actions.apply(ITEM, false);
    assert.deepEqual(
      f.calls.map((c) => c[0]),
      ['clear', 'unplayed', 'unplayed']
    );
  });
  it('does not mark watched when the first rating write fails', async () => {
    const f = fixture();
    f.api.updateUserItemRating = async () => {
      throw new Error('isolated failure');
    };
    await assert.rejects(f.actions.apply(ITEM, false));
    assert.equal(f.calls.length, 0);
  });
  it('contains no Seerr credentials, direct token access, polling or custom child traversal', () => {
    const source = readFileSync(
      path.resolve('public/integrations/jellyfin-user-likes.js'),
      'utf8'
    );
    assert.doesNotMatch(
      source,
      /accessToken\(|X-Api-Key|apiKey|setInterval\(|getEpisodes\(|\/Episodes|fetch\(/
    );
    assert.match(source, /observer\.disconnect\(\)/);
    assert.match(source, /removeEventListener/);
  });
  it('mounts once after Home navigation, follows Series navigation and fully disposes', async () => {
    const f = fixture();
    const env = runInNewContext(
      `(() => {
      class Element {
        constructor() { this.children=[]; this.dataset={}; this.listeners={}; this.attributes={}; this.classList={toggle() {}}; }
        get isConnected() { return this.connected || !!this.parentElement?.isConnected; }
        appendChild(node) { node.remove(); this.children.push(node); node.parentElement=this; return node; }
        remove() { if(this.parentElement) this.parentElement.children=this.parentElement.children.filter(n=>n!==this); this.parentElement=null; }
        after(node) { this.parentElement.appendChild(node); }
        before(node) { this.parentElement.appendChild(node); }
        setAttribute(key,value) { this.attributes[key]=value; }
        addEventListener(name,fn) { (this.listeners[name] ||= new Set()).add(fn); }
        removeEventListener(name,fn) { this.listeners[name]?.delete(fn); }
        matches() { return false; }
        closest() { return null; }
        querySelector() { return null; }
      }
      const body=new Element(); body.connected=true;
      const head=new Element(); head.connected=true;
      const page=new Element(); const bar=new Element(); const favorite=new Element();
      body.appendChild(page); page.appendChild(bar); bar.appendChild(favorite);
      page.querySelector=()=>bar;
      bar.querySelector=(selector)=>selector.includes('btnFavorite') ? favorite : null;
      const document=new Element(); document.body=body; document.head=head; document.available=false;
      document.createElement=()=>new Element();
      document.querySelector=(selector)=>selector.includes('itemDetailPage') && document.available ? page : null;
      const window=new Element();
      const observers=[];
      class MutationObserver { constructor(fn) {this.fn=fn;observers.push(this);} observe() {} disconnect(){this.disconnected=true;} }
      return { window, document, Element, MutationObserver, observers, bar, page, location:{hash:'#/home'}, URLSearchParams, queueMicrotask, setTimeout:()=>0 };
    })()`,
      { URLSearchParams, queueMicrotask }
    );
    env.window.ApiClient = f.api;
    const source = readFileSync(
      path.resolve('public/integrations/jellyfin-user-likes.js'),
      'utf8'
    );
    runInNewContext(source, env);
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    const fire = (host: typeof env.window, name: string) => {
      for (const listener of host.listeners[name] || [])
        listener({ target: env.page });
    };
    await settle();
    assert.equal(env.bar.children.length, 1);
    env.document.available = true;
    env.location.hash = `#/details?id=${ITEM}`;
    fire(env.window, 'hashchange');
    await settle();
    assert.equal(env.bar.children.length, 2);
    const root = env.bar.children[1];
    assert.equal(root.children.length, 2);
    assert.equal(root.children[0].disabled, false);
    fire(env.document, 'viewshow');
    fire(env.document, 'viewshow');
    runInNewContext(source, env); // The installed guard also blocks a duplicate entry.
    await settle();
    assert.equal(env.bar.children[1], root);
    env.location.hash = `#/details?id=${SERIES}`;
    fire(env.window, 'hashchange');
    await settle();
    assert.equal(root.isConnected, false);
    assert.equal(env.bar.children.length, 2);
    assert.equal(env.bar.children[1].dataset.itemId, SERIES);
    env.document.available = false;
    fire(env.document, 'viewbeforehide');
    await settle();
    assert.equal(env.bar.children.length, 1);
    env.window.__jellyfinLikesInstalled.dispose();
    assert.equal(env.window.__jellyfinLikesInstalled, undefined);
    assert.equal(env.observers[0].disconnected, true);
    assert.equal(env.document.head.children.length, 0);
    assert.ok(
      Object.values(env.window.listeners).every(
        (set: unknown) => (set as Set<unknown>).size === 0
      )
    );
  });
});
