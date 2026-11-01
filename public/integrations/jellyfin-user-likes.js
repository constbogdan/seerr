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
    async function apply(id, value, expectedId) {
      if (typeof value !== 'boolean') throw new Error('Invalid rating.');
      if (busy) return null;
      busy = true;
      try {
        const item = await resolve(id);
        if (expectedId && guid(item.Id) !== guid(expectedId))
          throw new Error('Resolved item identity changed.');
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

  // One context owns reads, mutation locks and partial-failure retry evidence.
  // Reads are activation-driven, never polled. A hung request retains its slot.
  function createPreferences(
    api,
    isCurrent,
    reads = { active: 0, wake: new Set() }
  ) {
    const entries = new Map();
    const waiting = new Set();
    let scheduled = false;
    let disposed = false;
    let revision = 0;
    const valid = () => !disposed && isCurrent();
    const snapshot = (entry) => ({
      known: entry.known,
      rating: entry.rating,
      busy: entry.busy,
      failed: entry.failed,
    });
    const emit = (entry) => {
      for (const listener of entry.listeners) listener(snapshot(entry));
    };
    function entryFor(id) {
      id = guid(id);
      if (!valid() || !id) return null;
      let entry = entries.get(id);
      if (!entry) {
        if (entries.size >= 512) {
          const oldest = [...entries.values()].find(
            (row) => !row.listeners.size && !row.busy && !row.reading
          );
          if (!oldest) return null;
          waiting.delete(oldest.id);
          entries.delete(oldest.id);
        }
        entry = {
          id,
          known: false,
          rating: null,
          busy: false,
          failed: false,
          version: revision,
          observed: 0,
          reading: false,
          listeners: new Set(),
          actionCurrent: null,
        };
        entry.actions = createActions(
          api,
          () => valid() && (!entry.actionCurrent || entry.actionCurrent())
        );
        entries.set(id, entry);
      }
      return entry;
    }
    function observe(id, data, version) {
      const entry = entryFor(id);
      if (
        !entry ||
        entry.busy ||
        (version !== undefined && entry.version > version) ||
        !data ||
        typeof data.Played !== 'boolean' ||
        (data.Likes != null && typeof data.Likes !== 'boolean')
      )
        return;
      entry.version = ++revision;
      entry.known = true;
      entry.rating = data.Likes ?? null;
      entry.observed = Date.now();
      entry.failed = false;
      emit(entry);
    }
    function scheduleRead() {
      if (scheduled || !valid()) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        pump();
      });
    }
    function pump() {
      if (!valid()) return;
      while (reads.active < 2 && waiting.size) {
        const batch = [];
        for (const id of waiting) {
          const entry = entries.get(id);
          if (!entry || !entry.listeners.size) {
            waiting.delete(id);
            continue;
          }
          if (entry.busy || entry.reading) continue;
          waiting.delete(id);
          entry.reading = true;
          batch.push([entry, entry.version]);
          if (batch.length === 50) break;
        }
        if (!batch.length) break;
        reads.active++;
        void (async () => {
          try {
            const result = await api.getItems(api.getCurrentUserId(), {
              Ids: batch.map(([row]) => row.id).join(','),
              IncludeItemTypes: 'Movie,Series',
              EnableUserData: true,
              EnableImages: false,
              Limit: batch.length,
            });
            if (!valid()) return;
            const items = Array.isArray(result?.Items) ? result.Items : [];
            for (const [entry, version] of batch) {
              const matches = items.filter(
                (item) => guid(item?.Id) === entry.id
              );
              if (
                matches.length === 1 &&
                ['Movie', 'Series'].includes(matches[0].Type)
              )
                observe(entry.id, matches[0].UserData, version);
              if (entry.version === version && !entry.busy) {
                entry.failed = true;
                emit(entry);
              }
            }
          } catch {
            if (valid())
              for (const [entry, version] of batch) {
                if (entry.version === version && !entry.busy) {
                  entry.failed = true;
                  emit(entry);
                }
              }
          } finally {
            for (const [entry] of batch) entry.reading = false;
            reads.active--;
            for (const wake of reads.wake) wake();
          }
        })();
      }
    }
    reads.wake.add(scheduleRead);
    return {
      fence() {
        return revision;
      },
      observe,
      notify(id, data) {
        const entry = entries.get(guid(id));
        if (!valid() || !entry) return;
        if (entry.busy) {
          // A notification has no ordering token. Resolve write/event overlap with
          // one bounded read after the write, never replay an ambiguous event.
          entry.refresh = true;
          return;
        }
        observe(id, data);
      },
      subscribe(id, listener) {
        const entry = entryFor(id);
        if (!entry) return () => {};
        entry.listeners.add(listener);
        listener(snapshot(entry));
        return () => {
          entry.listeners.delete(listener);
          if (!entry.listeners.size) waiting.delete(entry.id);
        };
      },
      load(id) {
        const entry = entryFor(id);
        if (
          !entry ||
          entry.busy ||
          entry.reading ||
          (entry.known && Date.now() - entry.observed < 60000)
        )
          return;
        waiting.add(entry.id);
        scheduleRead();
      },
      cancelLoad(id) {
        waiting.delete(guid(id));
      },
      async apply(id, value, current = () => true, sourceId = id) {
        const entry = entryFor(id);
        if (!entry || !entry.known || entry.busy || !current()) return null;
        entry.busy = true;
        entry.version = ++revision; // Fence all pre-action reads, including detail reads.
        waiting.delete(entry.id);
        entry.actionCurrent = current;
        emit(entry);
        try {
          const result = await entry.actions.apply(sourceId, value, entry.id);
          if (valid() && result) {
            entry.known = true;
            entry.rating = result.rating;
            entry.observed = Date.now();
            entry.failed = false;
          }
          return result;
        } catch (error) {
          entry.failed = true;
          throw error;
        } finally {
          entry.busy = false;
          entry.actionCurrent = null;
          entry.version = ++revision;
          if (valid()) emit(entry);
          if (valid() && entry.refresh) {
            entry.refresh = false;
            entry.observed = 0;
            waiting.add(entry.id);
            scheduleRead();
          }
        }
      },
      dispose() {
        disposed = true;
        reads.wake.delete(scheduleRead);
        waiting.clear();
        entries.clear();
      },
    };
  }

  // The executable tests load these exact helpers, not a second implementation.
  if (typeof window === 'undefined') {
    module.exports = { createActions, createPreferences, guid };
    return;
  }
  if (window.__jellyfinLikesInstalled) return;
  const ROOT_ID = 'custom-jellyfin-likes';
  let active = null;
  let queued = false;
  let disposed = false;
  let session = null;
  const reads = { active: 0, wake: new Set() };
  const cards = new Map();
  const CARD_SELECTOR = '.card[data-id][data-type][data-serverid]';
  const cardCandidates = new Set();
  let scanCards = true;
  let cardsEnabled = true;
  const style = document.createElement('style');
  style.textContent = `
    #${ROOT_ID} { display:inline-flex; align-items:center; gap:2px; }
    #${ROOT_ID} .jf-like-button { display:inline-flex; align-items:center; justify-content:center; width:3em; height:3em; padding:0; border:0; border-radius:50%; background:transparent !important; color:rgba(255,255,255,.76); cursor:pointer; }
    #${ROOT_ID} .material-icons { font-size:24px; }
    #${ROOT_ID} .like.selected, #${ROOT_ID} .like:hover:not(:disabled), #${ROOT_ID} .like:focus { color:#03a9f4; }
    #${ROOT_ID} .dislike.selected, #${ROOT_ID} .dislike:hover:not(:disabled), #${ROOT_ID} .dislike:focus { color:#f44336; }
    #${ROOT_ID} .jf-like-button:disabled { opacity:.5; cursor:wait; }
    .jf-card-likes { position:absolute; left:var(--jf-likes-inset, 0px); bottom:var(--jf-likes-bottom, 0px); z-index:3; display:flex; align-items:center; gap:0; max-width:100%; pointer-events:none; }
    .jf-card-likes.stacked { flex-direction:column; }
    .jf-card-likes button { box-sizing:border-box; flex-shrink:0; width:var(--jf-likes-width, 2.5em); height:var(--jf-likes-height, 2.5em); padding:0; border:0; border-radius:50%; font:inherit; color:rgba(255,255,255,.76); background:transparent !important; text-shadow:0 1px 2px rgba(0,0,0,.8), 0 0 1px rgba(255,255,255,.35); display:inline-flex; align-items:center; justify-content:center; cursor:pointer; pointer-events:auto; }
    .jf-card-likes .material-icons { font-size:calc(var(--jf-likes-icon, 1.5em) * .8); }
    .jf-card-likes .like.selected, .jf-card-likes .like:hover:not(:disabled), .jf-card-likes .like:focus { color:#03a9f4; }
    .jf-card-likes .dislike.selected, .jf-card-likes .dislike:hover:not(:disabled), .jf-card-likes .dislike:focus { color:#f44336; }
    .jf-card-likes .jf-preference:not(.selected) { position:absolute; width:0; height:0; opacity:0; pointer-events:none; overflow:hidden; }
    .card:hover .jf-card-likes .jf-preference, .card:focus-within .jf-card-likes .jf-preference, .jf-card-likes.expanded .jf-preference { position:static; width:var(--jf-likes-width, 2.5em); height:var(--jf-likes-height, 2.5em); opacity:1; pointer-events:auto; }
    #${ROOT_ID} .jf-like-button:focus, .jf-card-likes button:focus { outline:2px solid white; outline-offset:-2px; }
    .jf-card-likes button:disabled { cursor:wait; }
    .jf-card-likes.unknown .jf-preference { opacity:.45; }
    .jf-card-likes .jf-reveal { display:none; }
    .jf-card-likes.unknown .jf-reveal { display:inline-flex; }
    @media (hover:none), (pointer:coarse) { .jf-card-likes .jf-reveal { display:inline-flex; } }
    .jf-card-likes.expanded .jf-reveal { display:none; }
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
    active?.unsubscribe?.();
    active?.root.remove();
    active = null;
  }
  function currentSession() {
    const api = window.ApiClient;
    const userId = api?.getCurrentUserId?.();
    const serverId = api?.serverId?.();
    if (!api || !guid(userId) || !serverId) {
      session?.dispose();
      session = null;
      return null;
    }
    if (
      session?.api === api &&
      session.userId === userId &&
      session.serverId === serverId
    )
      return session;
    clear();
    for (const state of cards.values()) removeCard(state);
    session?.dispose();
    scanCards = true;
    const next = { api, userId, serverId };
    const current = () =>
      !disposed &&
      window.ApiClient === api &&
      api.getCurrentUserId?.() === userId &&
      api.serverId?.() === serverId;
    next.current = current;
    next.store = createPreferences(api, current, reads);
    const events = window.Events;
    const source = window.ServerNotifications;
    const changed = (_event, client, data) => {
      if (!current() || client !== api) return;
      if (guid(data?.ItemId)) next.store.notify(data.ItemId, data);
    };
    optionalCleanup(() => {
      if (events?.on && events?.off && source)
        events.on(source, 'UserDataChanged', changed);
    });
    next.dispose = () => {
      next.store.dispose();
      optionalCleanup(() => {
        if (events?.on && events?.off && source)
          events.off(source, 'UserDataChanged', changed);
      });
    };
    session = next;
    return next;
  }
  function removeCard(state) {
    optionalCleanup(() => intersection?.unobserve(state.card));
    optionalCleanup(() => {
      resize?.unobserve(state.scalable);
      if (state.footer) resize?.unobserve(state.footer);
      if (state.nativeActions) resize?.unobserve(state.nativeActions);
      if (state.nativeButton) resize?.unobserve(state.nativeButton);
    });
    state.unsubscribe?.();
    state.root.remove();
    cards.delete(state.card);
  }
  function optionalCleanup(callback) {
    // Optional observers/notification hooks must not break V1 details or teardown.
    try {
      callback();
    } catch {
      /* No provider/action errors are swallowed here. */
    }
  }
  function disableCards() {
    cardsEnabled = false;
    optionalCleanup(() => intersection?.disconnect());
    optionalCleanup(() => resize?.disconnect());
    for (const state of cards.values()) removeCard(state);
    cardCandidates.clear();
  }
  function cardWork(callback) {
    if (!cardsEnabled || disposed) return;
    try {
      callback();
    } catch {
      disableCards();
    }
  }
  function cardIdentity(card) {
    if (
      card.tagName !== 'DIV' ||
      !['Movie', 'Series'].includes(card.dataset.type) ||
      !guid(card.dataset.id) ||
      card.closest('.hide, .itemsContainer-tv') ||
      card.dataset.serverid !== session?.serverId
    )
      return null;
    const scalable = card.querySelector('.cardScalable');
    if (!scalable) return null;
    const legacy = scalable.querySelector(
      ':scope > a.cardImageContainer.cardContent'
    );
    if (!legacy) {
      // The standard library renderer separates image content from its overlay
      // anchor. Require both, and verify the anchor's exact item/server binding.
      const image = scalable.querySelector(
        ':scope > div.cardContent > .cardImageContainer'
      );
      const link = scalable.querySelector(
        ':scope > .cardOverlayContainer > a.cardImageContainer'
      );
      const href = link?.getAttribute('href') || '';
      const query = new URLSearchParams(href.split('?')[1] || '');
      if (
        !image ||
        !href.startsWith('#/details?') ||
        guid(query.get('id')) !== guid(card.dataset.id) ||
        query.get('serverId') !== session.serverId
      )
        return null;
    }
    return { id: guid(card.dataset.id), scalable };
  }
  function notifyResult(result) {
    if (!result) return;
    toast(
      result.partial
        ? 'Rating saved, but watched-state update failed. Click again to retry.'
        : 'Preference saved.'
    );
  }
  function mountCard(card, identity, owner) {
    const root = document.createElement('span');
    root.className = 'jf-card-likes unknown';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Like and Dislike');
    const state = { card, root, ...identity, owner, visible: false };
    state.footer = identity.scalable.querySelector('.innerCardFooter');
    state.nativeActions = identity.scalable.querySelector(
      '.cardOverlayButton-br'
    );
    state.nativeButton = state.nativeActions?.querySelector('button') || null;
    const buttons = [];
    for (const [kind, icon, value, label] of [
      ['like', 'thumb_up', true, 'Like'],
      ['dislike', 'thumb_down', false, 'Dislike'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `jf-preference ${kind}`;
      button.title = label;
      button.setAttribute('aria-label', label);
      const glyph = document.createElement('span');
      glyph.className = 'material-icons';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = icon;
      button.appendChild(glyph);
      root.appendChild(button);
      buttons.push([button, value]);
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (
          button.disabled ||
          !owner.current() ||
          cards.get(card) !== state ||
          cardIdentity(card)?.id !== state.id
        )
          return;
        try {
          notifyResult(await owner.store.apply(state.id, value));
        } catch {
          if (owner.current())
            toast(
              'Could not update preference. A verified single-user Jellyfin session is required.'
            );
        }
      });
    }
    const reveal = document.createElement('button');
    reveal.type = 'button';
    reveal.className = 'jf-reveal';
    reveal.textContent = '…';
    reveal.setAttribute('aria-label', 'Show Like and Dislike controls');
    reveal.setAttribute('aria-expanded', 'false');
    reveal.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const expanded = root.classList.toggle('expanded');
      reveal.setAttribute('aria-expanded', String(expanded));
      if (expanded) buttons[0][0].focus?.();
      owner.store.load(state.id); // Explicit retry after a failed read, not polling.
    });
    root.appendChild(reveal);
    for (const name of ['pointerdown', 'dblclick', 'contextmenu'])
      root.addEventListener(name, (event) => event.stopPropagation());
    root.addEventListener('keydown', (event) => {
      if (['Enter', ' ', 'Escape'].includes(event.key)) event.stopPropagation();
      if (event.key === 'Escape') {
        root.classList.remove('expanded');
        reveal.setAttribute('aria-expanded', 'false');
      }
    });
    identity.scalable.appendChild(root);
    cards.set(card, state);
    state.render = (data) =>
      cardWork(() => {
        root.classList.toggle('unknown', !data.known);
        root.setAttribute(
          'aria-label',
          data.known
            ? 'Like and Dislike'
            : data.failed
              ? 'Preference unavailable'
              : 'Loading preference'
        );
        root.setAttribute(
          'aria-busy',
          String((!data.known && !data.failed) || data.busy)
        );
        reveal.title = data.known
          ? 'Show Like and Dislike controls'
          : data.failed
            ? 'Preference unavailable. Activate to retry.'
            : 'Loading preference';
        reveal.setAttribute('aria-label', reveal.title);
        for (const [button, value] of buttons) {
          button.disabled = !data.known || data.busy;
          button.classList.toggle(
            'selected',
            data.known && data.rating === value
          );
          button.setAttribute(
            'aria-pressed',
            String(data.known && data.rating === value)
          );
        }
      });
    state.render({ known: false, rating: null, busy: false, failed: false });
    if (!cardsEnabled) return;
    if (intersection) intersection.observe(card);
    for (const node of [
      state.scalable,
      state.footer,
      state.nativeActions,
      state.nativeButton,
    ]) {
      if (node && resize) {
        resizeOwners.set(node, state);
        resize.observe(node);
      }
    }
    // Without IntersectionObserver, fail closed rather than querying offscreen cards.
  }
  let intersection = null;
  let resize = null;
  const resizeOwners = new WeakMap();
  cardWork(() => {
    if (
      typeof IntersectionObserver !== 'function' ||
      typeof ResizeObserver !== 'function'
    ) {
      disableCards();
      return;
    }
    intersection = new IntersectionObserver((entries) =>
      cardWork(() => {
        for (const entry of entries) {
          const state = cards.get(entry.target);
          if (!state) continue;
          state.visible = entry.isIntersecting;
          if (state.visible) {
            // Keep the shipped script parseable by JMP's Chromium 83.
            if (!state.unsubscribe)
              state.unsubscribe = state.owner.store.subscribe(
                state.id,
                state.render
              );
            if (!cardsEnabled) {
              state.unsubscribe();
              state.unsubscribe = null;
              return;
            }
            rootFooter(state);
            state.owner.store.load(state.id);
          } else {
            state.unsubscribe?.();
            state.unsubscribe = null;
            if (
              ![...cards.values()].some(
                (other) =>
                  other !== state && other.id === state.id && other.visible
              )
            )
              state.owner.store.cancelLoad(state.id);
          }
        }
      })
    );
    resize = new ResizeObserver((entries) =>
      cardWork(() => {
        for (const { target } of entries) {
          const state = resizeOwners.get(target);
          if (state?.visible && cards.get(state.card) === state)
            rootFooter(state);
        }
      })
    );
  });
  function rootFooter(state) {
    const root = state.root;
    const actions = state.nativeActions;
    const button = state.nativeButton;
    const nativeStyle = actions ? getComputedStyle(actions) : null;
    const inset = Math.max(0, parseFloat(nativeStyle?.right) || 0);
    let bottom = Math.max(
      state.footer?.offsetHeight || 0,
      parseFloat(nativeStyle?.bottom) || 0
    );
    // offset/client dimensions stay in layout CSS pixels when a theme scales
    // cards with transforms; transformed rectangles must not become CSS offsets.
    const width = button?.offsetWidth || 0;
    const height = button?.offsetHeight || 0;
    const room = actions?.offsetWidth
      ? Math.max(0, actions.offsetLeft - inset)
      : state.scalable.clientWidth - inset;
    root.classList.toggle(
      'stacked',
      width > 0 && room < width * root.children.length
    );
    if (width && room < width && actions?.offsetHeight)
      bottom = Math.max(
        bottom,
        actions.offsetHeight + (parseFloat(nativeStyle?.bottom) || 0)
      );
    root.style.setProperty('--jf-likes-inset', `${inset}px`);
    root.style.setProperty('--jf-likes-bottom', `${bottom}px`);
    if (width) root.style.setProperty('--jf-likes-width', `${width}px`);
    if (height) root.style.setProperty('--jf-likes-height', `${height}px`);
    const icon = button?.querySelector('.material-icons, svg');
    if (icon)
      root.style.setProperty(
        '--jf-likes-icon',
        getComputedStyle(icon).fontSize
      );
  }
  function reconcileCards(owner) {
    for (const state of cards.values()) {
      const identity = cardIdentity(state.card);
      if (
        !owner ||
        state.owner !== owner ||
        !state.card.isConnected ||
        !identity ||
        identity.id !== state.id ||
        identity.scalable !== state.scalable ||
        state.footer !== state.scalable.querySelector('.innerCardFooter') ||
        state.nativeActions !==
          state.scalable.querySelector('.cardOverlayButton-br') ||
        state.nativeButton !==
          (state.nativeActions?.querySelector('button') || null) ||
        state.root.parentElement !== identity.scalable
      )
        removeCard(state);
    }
    if (scanCards) {
      cardCandidates.add(document.body);
      scanCards = false;
    }
    const candidates = [...cardCandidates];
    cardCandidates.clear();
    if (!owner || !intersection) return;
    for (const node of candidates) {
      if (!node.isConnected) continue;
      const matches = node.matches(CARD_SELECTOR)
        ? [node]
        : node.querySelectorAll?.(CARD_SELECTOR) || [];
      for (const card of matches) {
        const identity = cardIdentity(card);
        if (identity && !cards.has(card)) mountCard(card, identity, owner);
      }
    }
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
    const owner = currentSession();
    reconcileDetails(owner);
    cardWork(() => reconcileCards(owner));
  }
  function reconcileDetails(owner) {
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
          const result = await owner.store.apply(
            state.targetId,
            value,
            current,
            ctx.itemId
          );
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
    const version = owner.store.fence();
    void actions
      .resolve(ctx.itemId)
      .then((item) => {
        if (!current()) return;
        state.targetId = guid(item.Id);
        // Parent reads share the same context and still require exact Series identity.
        owner.store.observe(state.targetId, item.UserData, version);
        state.unsubscribe = owner.store.subscribe(state.targetId, (data) => {
          if (!current()) return;
          state.rating = data.rating;
          state.loaded = data.known;
          state.busy = data.busy;
          update(state);
        });
        // A conservatively fenced parent read may still be Unknown. Resolve it
        // through the same bounded queue, not another uncoordinated detail read.
        owner.store.load(state.targetId);
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
    if (!cardsEnabled) {
      schedule();
      return;
    }
    let changed = false;
    try {
      for (const mutation of mutations) {
        const target = mutation.target;
        if (target?.closest?.(`#${ROOT_ID}, .jf-card-likes`)) continue;
        if (mutation.type === 'attributes') {
          const card = target.closest('.card');
          if (card) {
            cardCandidates.add(card);
            changed = true;
          }
          // Only visibility-changing ancestor classes need a subtree revisit.
          else if (
            mutation.attributeName === 'class' &&
            /(^|\s)hide(\s|$)/.test(mutation.oldValue || '') !==
              target.classList.contains('hide')
          ) {
            cardCandidates.add(target);
            changed = true;
          } else if (target.matches('.itemDetailPage')) changed = true;
          continue;
        }
        const removed = mutation.removedNodes || [];
        const added = [...(mutation.addedNodes || [])].filter(
          (node) =>
            node instanceof Element &&
            node.id !== ROOT_ID &&
            !node.matches('.jf-card-likes')
        );
        if (!added.length && !removed.length) continue;
        const card = target?.closest?.('.card');
        if (card) cardCandidates.add(card);
        for (const node of added) cardCandidates.add(node);
        changed = true;
      }
    } catch {
      disableCards();
      changed = true;
    }
    if (changed) schedule();
  });
  try {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [
        'data-id',
        'data-type',
        'data-serverid',
        'href',
        'class',
      ],
    });
  } catch {
    disableCards();
    observer.observe(document.body, { childList: true, subtree: true });
  }
  const leaving = (event) => {
    if (event.target === active?.page) clear();
  };
  const visibility = () => {
    if (!document.hidden) {
      schedule();
      for (const state of cards.values())
        if (state.visible) state.owner.store.load(state.id);
    }
  };
  function dispose() {
    disposed = true;
    clear();
    disableCards();
    session?.dispose();
    cardCandidates.clear();
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
