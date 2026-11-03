// @ts-check
// Separate authenticated Injector entry. Set only this trusted HTTPS ORIGIN:
// no path/credentials. Empty means the report action remains disabled.
(() => {
  'use strict';
  const SEERR_ORIGIN = '';
  const REPORT_PATH = '/api/v1/integrations/jellyfin/subtitle-issues';
  const LABEL = 'Report subtitle issue';
  const FAILED =
    'Could not report the subtitle issue. Check the connection and try again.';
  const BUTTON_ID = 'seerr-subtitle-report';
  /** @typedef {{Id:string, Type:string, IndexNumber?:number}} Item */
  /** @typedef {{getCurrentUserId:()=>string, accessToken:()=>string, getItem:(user:string,id:string)=>Promise<Item>, serverId?:()=>string}} Client */
  /** @typedef {{api:Client,page:Element,bar:Element,itemId:string,userId:string}} Context */
  /** @typedef {Context & {button:HTMLButtonElement|null, observer:MutationObserver|null, request:AbortController|null, supported:boolean}} State */
  const host =
    /** @type {Window & typeof globalThis & {ApiClient?:Client,__seerrSubtitleReporter?:{dispose:()=>void}}} */ (
      window
    );
  if (host.__seerrSubtitleReporter) return;
  /** @param {string} value */
  function configuredEndpoint(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' &&
        url.origin === value &&
        !url.username &&
        !url.password
        ? url.origin + REPORT_PATH
        : null;
    } catch {
      return null;
    }
  }
  const endpoint = configuredEndpoint(SEERR_ORIGIN);
  /** @type {State|null} */
  let active = null;
  let queued = false;
  let disposed = false;
  /** @param {string|null|undefined} value */
  function guid(value) {
    const id = value?.replace(/-/g, '').toLowerCase();
    return id && /^[0-9a-f]{32}$/.test(id) ? id : null;
  }
  /** @returns {Context|null} */
  function context() {
    const api = host.ApiClient;
    const page = document.querySelector('.itemDetailPage:not(.hide)');
    const bar = page?.querySelector('.detailButtons, .mainDetailButtons');
    const query = new URLSearchParams(location.hash.split('?')[1] || '');
    const itemId = guid(query.get('id'));
    const userId = api?.getCurrentUserId?.();
    const server = query.get('serverId');
    if (
      location.protocol !== 'https:' ||
      !api ||
      !page ||
      !bar ||
      !itemId ||
      !userId ||
      (server && server !== api.serverId?.())
    )
      return null;
    return { api, page, bar, itemId, userId };
  }
  /** @param {Context} a @param {Context|null} b */
  function same(a, b) {
    return (
      !!b &&
      a.api === b.api &&
      a.page === b.page &&
      a.bar === b.bar &&
      a.itemId === b.itemId &&
      a.userId === b.userId
    );
  }
  function clear() {
    active?.observer?.disconnect();
    active?.request?.abort();
    active?.button?.removeEventListener('click', report);
    active?.button?.remove();
    active = null;
  }
  // Jellyfin 10.10.7's toast function is module-private. Reuse its existing
  // toast classes, not webpack internals, a new framework or dialogs.
  /** @param {string} message */
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
    notice.setAttribute('aria-live', 'polite');
    notice.textContent = message;
    container.appendChild(notice);
    setTimeout(() => notice.remove(), 4000);
  }
  /** @param {State} state */
  function place(state) {
    if (!state.supported || !same(state, context())) return;
    const rating = state.bar.querySelector(
      '.btnUserRating[data-id], [is="emby-ratingbutton"][data-id]'
    );
    if (rating && guid(rating.getAttribute('data-id')) !== state.itemId) {
      state.button?.remove();
      return;
    }
    if (!state.button) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = BUTTON_ID;
      button.setAttribute('is', 'emby-button');
      button.className = 'button-flat detailButton';
      button.setAttribute('aria-label', LABEL);
      const content = document.createElement('span');
      content.className = 'detailButton-content';
      const icon = document.createElement('span');
      icon.className = 'material-icons detailButton-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = 'subtitles';
      content.appendChild(icon);
      button.appendChild(content);
      button.addEventListener('click', report);
      state.button = button;
    }
    state.button.disabled = !endpoint || !!state.request;
    state.button.title = endpoint
      ? LABEL
      : 'Subtitle reporting is not configured';
    state.button.setAttribute('aria-busy', String(!!state.request));
    const likes = state.bar.querySelector('#custom-jellyfin-likes');
    const anchor =
      likes && guid(likes.getAttribute('data-item-id')) === state.itemId
        ? likes
        : state.bar.querySelector(
            '.btnUserRating, .btnUserItemRating, .btnFavorite, [data-action="favorite"]'
          );
    if (anchor) {
      if (state.button.previousElementSibling !== anchor)
        anchor.after(state.button);
    } else {
      const menu = state.bar.querySelector('.btnMoreCommands, .btnMore');
      if (menu) {
        if (state.button.nextElementSibling !== menu) menu.before(state.button);
      } else if (state.button.parentElement !== state.bar)
        state.bar.appendChild(state.button);
    }
  }
  function reconcile() {
    const ctx = context();
    if (!ctx) {
      clear();
      return;
    }
    if (active && same(active, ctx)) {
      place(active);
      return;
    }
    clear();
    const state = /** @type {State} */ ({
      ...ctx,
      button: null,
      observer: null,
      request: null,
      supported: false,
    });
    active = state;
    // Observe only the current details view; no interval or whole-page scan loop.
    state.observer = new MutationObserver(schedule);
    state.observer.observe(ctx.page, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-id', 'data-serverid', 'data-item-id'],
    });
    void ctx.api
      .getItem(ctx.userId, ctx.itemId)
      .then((item) => {
        if (active !== state || !same(state, context())) return;
        state.supported =
          guid(item.Id) === ctx.itemId &&
          (['Movie', 'Series', 'Episode'].includes(item.Type) ||
            (item.Type === 'Season' &&
              typeof item.IndexNumber === 'number' &&
              Number.isSafeInteger(item.IndexNumber) &&
              item.IndexNumber > 0 &&
              item.IndexNumber <= 2147483647));
        place(state);
      })
      .catch(() => {
        /* Fail closed without exposing provider data or credentials. */
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
  /** @param {Event} event */
  async function report(event) {
    event.preventDefault();
    event.stopPropagation();
    const state = active;
    if (
      !endpoint ||
      !state ||
      !state.supported ||
      state.request ||
      state.button !== event.currentTarget
    )
      return;
    if (!same(state, context())) {
      schedule();
      return;
    }
    const token = state.api.accessToken(); // Current token, read only on activation.
    if (!token) {
      toast('Sign in to Jellyfin before reporting a subtitle issue.');
      return;
    }
    const request = new AbortController();
    state.request = request;
    place(state);
    const deadline = setTimeout(() => request.abort(), 20_000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: request.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ itemId: state.itemId }),
      });
      if (active !== state || !same(state, context())) return;
      if (!response.ok) {
        toast(
          response.status === 401
            ? 'Your Jellyfin session expired. Sign in again.'
            : response.status === 403
              ? 'Your account is not allowed to report this subtitle issue.'
              : response.status === 422
                ? 'This item cannot be reported as a single subtitle issue.'
                : response.status === 429
                  ? 'Too many subtitle reports. Please try again later.'
                  : FAILED
        );
        return;
      }
      const result = await response.json();
      if (active !== state || !same(state, context())) return;
      toast(
        response.status === 201 && result.status === 'created'
          ? 'Subtitle issue reported.'
          : response.status === 200 && result.status === 'already-reported'
            ? 'This subtitle issue has already been reported.'
            : FAILED
      );
    } catch {
      if (active === state && same(state, context())) toast(FAILED);
    } finally {
      clearTimeout(deadline);
      state.request = null;
      if (active === state) place(state);
    }
  }
  /** @param {Event} event */
  function leaving(event) {
    if (event.target === active?.page) clear();
  }
  function dispose() {
    disposed = true;
    clear();
    document.removeEventListener('viewshow', schedule, true);
    document.removeEventListener('viewbeforehide', leaving, true);
    document.removeEventListener('viewdestroy', leaving, true);
    window.removeEventListener('hashchange', schedule);
    window.removeEventListener('popstate', schedule);
    window.removeEventListener('pageshow', schedule);
    window.removeEventListener('pagehide', clear);
    delete host.__seerrSubtitleReporter;
  }
  host.__seerrSubtitleReporter = { dispose };
  document.addEventListener('viewshow', schedule, true);
  document.addEventListener('viewbeforehide', leaving, true);
  document.addEventListener('viewdestroy', leaving, true);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('pageshow', schedule);
  window.addEventListener('pagehide', clear);
  schedule();
})();
