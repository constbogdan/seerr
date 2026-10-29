// Review candidate only. Replace the existing Native User Likes entry only
// after approval. Uses the current Jellyfin ApiClient; no Seerr credentials.
(() => {
  'use strict';

  const guid = (value) =>
    typeof value === 'string' && /^[a-f\d]{32}$/i.test(value.replace(/-/g, ''))
      ? value.replace(/-/g, '').toLowerCase()
      : null;

  function createActions(api, isCurrent) {
    const userId = api.getCurrentUserId();
    const serverId = api.serverId();
    let busy = false;
    let pending = null;
    const check = () => {
      if (
        !guid(userId) ||
        !isCurrent() ||
        api.getCurrentUserId() !== userId ||
        api.serverId() !== serverId
      )
        throw new Error('Jellyfin context changed.');
    };
    async function singleUser() {
      check();
      const deviceId = api.deviceId?.();
      if (!deviceId || typeof api.getSessions !== 'function')
        throw new Error('Cannot verify a single-user session.');
      const sessions = await api.getSessions({ DeviceId: deviceId });
      check();
      const matches = Array.isArray(sessions)
        ? sessions.filter(
            (session) =>
              session.DeviceId === deviceId &&
              guid(session.UserId) === guid(userId)
          )
        : [];
      if (
        matches.length !== 1 ||
        !Array.isArray(matches[0].AdditionalUsers) ||
        matches[0].AdditionalUsers.length
      )
        throw new Error('A single-user Jellyfin session is required.');
    }
    async function read(id) {
      check();
      if (!guid(id)) throw new Error('Invalid item identity.');
      const item = await api.getItem(userId, id);
      check();
      if (guid(item?.Id) !== guid(id))
        throw new Error('Mismatched item identity.');
      return item;
    }
    async function resolve(id) {
      let item = await read(id);
      if (['Episode', 'Season'].includes(item.Type)) {
        if (!guid(item.SeriesId)) throw new Error('Missing Series identity.');
        const parentId = item.SeriesId;
        item = await read(parentId);
        if (item.Type !== 'Series') throw new Error('Invalid Series identity.');
      } else if (!['Movie', 'Series'].includes(item.Type)) {
        throw new Error('Unsupported item.');
      }
      if (
        !item.UserData ||
        typeof item.UserData.Played !== 'boolean' ||
        (item.UserData.Likes != null &&
          typeof item.UserData.Likes !== 'boolean')
      )
        throw new Error('Incomplete user data.');
      return item;
    }
    async function apply(id, value) {
      if (typeof value !== 'boolean') throw new Error('Invalid rating.');
      if (busy) return null;
      busy = true;
      try {
        const item = await resolve(id);
        await singleUser();
        const retry =
          pending &&
          pending.id === guid(item.Id) &&
          pending.value === value &&
          (item.UserData.Likes ?? null) === pending.next;
        const next = retry
          ? pending.next
          : item.UserData.Likes === value
            ? null
            : value;
        if (!retry) {
          if (next === null) await api.clearUserItemRating(userId, item.Id);
          else await api.updateUserItemRating(userId, item.Id, next);
          check();
          pending = null;
        }
        // Like (including Dislike -> Like) never changes watched state.
        if (value === false) {
          pending = { id: guid(item.Id), value, next };
          try {
            await singleUser();
            if (next === false) await api.markPlayed(userId, item.Id);
            else await api.markUnplayed(userId, item.Id);
            check();
            pending = null;
          } catch {
            return { rating: next, partial: true };
          }
        }
        return { rating: next, partial: false };
      } finally {
        busy = false;
      }
    }
    return { resolve, apply };
  }

  // The executable tests load these exact helpers, not a second implementation.
  if (typeof window === 'undefined') {
    module.exports = { createActions, guid };
    return;
  }
  if (window.__jellyfinLikesInstalled) return;
  const ROOT_ID = 'custom-jellyfin-likes';
  let active = null;
  let queued = false;
  let disposed = false;
  const style = document.createElement('style');
  style.textContent = `
    #${ROOT_ID} { display:inline-flex; align-items:center; gap:2px; }
    #${ROOT_ID} .jf-like-button { display:inline-flex; align-items:center; justify-content:center; width:3em; height:3em; padding:0; border:0; border-radius:50%; background:transparent; color:inherit; cursor:pointer; }
    #${ROOT_ID} .material-icons { font-size:24px; }
    #${ROOT_ID} .jf-like-button:hover:not(:disabled) { background:rgba(255,255,255,.12); }
    #${ROOT_ID} .like.selected { color:#03a9f4; }
    #${ROOT_ID} .dislike.selected { color:#f44336; }
    #${ROOT_ID} .jf-like-button:disabled { opacity:.5; cursor:wait; }
  `;
  document.head.appendChild(style);
  function context() {
    const api = window.ApiClient;
    const page = document.querySelector('.itemDetailPage:not(.hide)');
    const bar = page?.querySelector('.detailButtons, .mainDetailButtons');
    const query = new URLSearchParams(location.hash.split('?')[1] || '');
    const itemId = guid(query.get('id'));
    const userId = api?.getCurrentUserId?.();
    if (
      !api ||
      !page ||
      !bar ||
      !itemId ||
      !guid(userId) ||
      (query.get('serverId') && query.get('serverId') !== api.serverId?.())
    )
      return null;
    return { api, page, bar, itemId, userId, serverId: api.serverId() };
  }
  function same(a, b) {
    return (
      !!b &&
      a.api === b.api &&
      a.page === b.page &&
      a.bar === b.bar &&
      a.itemId === b.itemId &&
      a.userId === b.userId &&
      a.serverId === b.serverId
    );
  }
  function clear() {
    active?.root.remove();
    active = null;
  }
  function toast(message) {
    let container = document.querySelector('.toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toastContainer';
      document.body.appendChild(container);
    }
    const notice = document.createElement('div');
    notice.className = 'toast toastVisible';
    notice.setAttribute('role', 'status');
    notice.textContent = message;
    container.appendChild(notice);
    setTimeout(() => notice.remove(), 4000);
  }
  function update(state) {
    for (const [button, value] of state.buttons) {
      button.disabled = !state.loaded || state.busy;
      button.classList.toggle(
        'selected',
        state.loaded && state.rating === value
      );
      button.setAttribute(
        'aria-pressed',
        String(state.loaded && state.rating === value)
      );
    }
  }
  function reconcile() {
    const ctx = context();
    if (!ctx) {
      clear();
      return;
    }
    if (
      active &&
      same(active, ctx) &&
      (active.unsupported || active.root.parentElement === ctx.bar)
    )
      return;
    clear();
    const root = document.createElement('span');
    root.id = ROOT_ID;
    root.dataset.itemId = ctx.itemId;
    const state = {
      ...ctx,
      root,
      buttons: [],
      rating: null,
      loaded: false,
      busy: false,
    };
    active = state;
    const current = () =>
      active === state && same(state, context()) && root.isConnected;
    const actions = createActions(ctx.api, current);
    for (const [kind, icon, value, label] of [
      ['like', 'thumb_up', true, 'Like'],
      ['dislike', 'thumb_down', false, 'Dislike'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `jf-like-button ${kind}`;
      button.title = label;
      button.setAttribute('aria-label', label);
      const glyph = document.createElement('span');
      glyph.className = 'material-icons';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = icon;
      button.appendChild(glyph);
      state.buttons.push([button, value]);
      root.appendChild(button);
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!state.loaded || state.busy || !current()) return;
        state.busy = true;
        update(state);
        try {
          const result = await actions.apply(ctx.itemId, value);
          if (!current() || !result) return;
          state.rating = result.rating;
          toast(
            result.partial
              ? 'Rating saved, but watched-state update failed. Click again to retry.'
              : 'Preference saved.'
          );
        } catch {
          if (current())
            toast(
              'Could not update preference. A verified single-user Jellyfin session is required.'
            );
        } finally {
          state.busy = false;
          if (current()) update(state);
        }
      });
    }
    const favorite = ctx.bar.querySelector(
      '.btnUserItemRating, .btnFavorite, [data-action="favorite"]'
    );
    const menu = ctx.bar.querySelector('.btnMoreCommands, .btnMore');
    if (favorite) favorite.after(root);
    else if (menu) menu.before(root);
    else ctx.bar.appendChild(root);
    update(state);
    void actions
      .resolve(ctx.itemId)
      .then((item) => {
        if (!current()) return;
        state.rating = item.UserData.Likes ?? null;
        state.loaded = true;
        // Episode/Season controls explicitly act on the entire Series.
        if (guid(item.Id) !== ctx.itemId)
          for (const [button] of state.buttons) {
            button.title += ' Series';
            button.setAttribute('aria-label', button.title);
          }
        update(state);
      })
      .catch(() => {
        if (current()) {
          state.unsupported = true;
          root.remove();
        }
      });
  }
  function schedule() {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disposed) reconcile();
    });
  }
  const observer = new MutationObserver((mutations) => {
    if (
      mutations.some((mutation) =>
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) =>
            node instanceof Element &&
            node.id !== ROOT_ID &&
            !node.closest(`#${ROOT_ID}`) &&
            (node.matches(
              '.itemDetailPage, .detailButtons, .mainDetailButtons'
            ) ||
              node.querySelector(
                '.itemDetailPage, .detailButtons, .mainDetailButtons'
              ))
        )
      )
    )
      schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  const leaving = (event) => {
    if (event.target === active?.page) clear();
  };
  const visibility = () => {
    if (!document.hidden) schedule();
  };
  function dispose() {
    disposed = true;
    clear();
    observer.disconnect();
    style.remove();
    for (const name of ['hashchange', 'popstate', 'pageshow'])
      window.removeEventListener(name, schedule);
    document.removeEventListener('viewshow', schedule, true);
    document.removeEventListener('viewbeforehide', leaving, true);
    document.removeEventListener('visibilitychange', visibility);
    delete window.__jellyfinLikesInstalled;
  }
  window.__jellyfinLikesInstalled = { dispose };
  for (const name of ['hashchange', 'popstate', 'pageshow'])
    window.addEventListener(name, schedule);
  document.addEventListener('viewshow', schedule, true);
  document.addEventListener('viewbeforehide', leaving, true);
  document.addEventListener('visibilitychange', visibility);
  schedule();
})();
