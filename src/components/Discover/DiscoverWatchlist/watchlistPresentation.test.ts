import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  WATCHLIST_PREFERENCE_KEY,
  defaultWatchlistPreferences,
  getWatchlistPreferenceKey,
  readWatchlistPreferences,
  resolveWatchlistPreferences,
} from './preferences';

describe('Watchlist presentation preferences', () => {
  it('uses a versioned key and safe defaults for stale or invalid storage', () => {
    assert.equal(WATCHLIST_PREFERENCE_KEY, 'watchlist-presentation-v1');
    assert.equal(
      getWatchlistPreferenceKey(7),
      'watchlist-presentation-v1:user-7'
    );
    assert.notEqual(getWatchlistPreferenceKey(7), getWatchlistPreferenceKey(8));
    assert.deepEqual(
      readWatchlistPreferences(null),
      defaultWatchlistPreferences
    );
    assert.deepEqual(
      readWatchlistPreferences('{broken'),
      defaultWatchlistPreferences
    );
    assert.deepEqual(
      readWatchlistPreferences(
        JSON.stringify({ category: 'anime', sort: 'release_date' })
      ),
      defaultWatchlistPreferences
    );
  });

  it('lets each valid explicit URL value override the stored preference', () => {
    assert.deepEqual(
      resolveWatchlistPreferences({
        queryCategory: 'animation',
        querySort: 'title_desc',
        queryWatched: 'watched',
        stored: {
          category: 'movies',
          sort: 'added_asc',
          watched: 'not_watched',
        },
      }),
      { category: 'animation', sort: 'title_desc', watched: 'watched' }
    );
    assert.deepEqual(
      resolveWatchlistPreferences({
        queryCategory: 'invalid',
        querySort: 'invalid',
        queryWatched: 'invalid',
        stored: {
          category: 'series',
          sort: 'added_asc',
          watched: 'all',
        },
      }),
      { category: 'series', sort: 'added_asc', watched: 'all' }
    );
  });
});

describe('Watchlist page and navigation integration', () => {
  const page = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
  const sidebar = readFileSync(
    path.join(__dirname, '../../Layout/Sidebar/index.tsx'),
    'utf8'
  );
  const mobile = readFileSync(
    path.join(__dirname, '../../Layout/MobileMenu/index.tsx'),
    'utf8'
  );
  const listView = readFileSync(
    path.join(__dirname, '../../Common/ListView/index.tsx'),
    'utf8'
  );

  it('keeps profile routes and applies local-only controls on the dedicated page', () => {
    assert.match(page, /router\.pathname === '\/discover\/watchlist'/);
    assert.match(page, /router\.pathname\.startsWith\('\/profile'\)/);
    assert.match(page, /router\.query\.userId/);
    assert.match(page, /firstResultData\?\.supportsPresentation/);
    assert.match(page, /firstResultData\.hasUnclassifiedItems/);
    assert.match(page, /getWatchlistPreferenceKey\(currentUser\.id\)/);
    assert.match(page, /MediaTypeFilter/);
    assert.match(page, /value: 'animation'/);
    assert.match(page, /value="added_desc"/);
    assert.match(page, /value="added_asc"/);
    assert.match(page, /value="title_asc"/);
    assert.match(page, /value="title_desc"/);
    assert.match(page, /value="not_watched"/);
    assert.match(page, /value="watched"/);
    assert.match(page, /firstResultData\.supportsWatchState/);
    assert.match(page, /Permission\.WATCHLIST_VIEW/);
    assert.match(page, /<UserSelector/);
    assert.match(page, /value="all"/);
  });

  it('never hides Watchlist membership because of availability or request state', () => {
    assert.match(
      page,
      /hideAvailable: false, hideBlocklisted: false, hideRequested: false/
    );
    assert.match(page, /plexItems=\{titles\}/);
  });

  it('renders completion and owner evidence without per-card provider reads', () => {
    assert.match(listView, /title\.watchState === 'watched'/);
    assert.match(listView, /title\.watchState === 'unknown'/);
    assert.match(listView, /title\.requestedBy\.displayName/);
    assert.doesNotMatch(listView, /api\/v1\/.*jellyfin/i);
  });

  it('adds desktop and mobile Watchlist navigation while retaining Requests', () => {
    assert.match(sidebar, /href: '\/discover\/watchlist'/);
    assert.match(sidebar, /dataTestId: 'sidebar-menu-watchlist'/);
    assert.match(mobile, /href: '\/discover\/watchlist'/);
    assert.match(mobile, /dataTestId: 'mobile-menu-watchlist'/);
    assert.match(
      mobile,
      /\['\/', '\/discover\/movies', '\/discover\/tv', '\/requests'\]/
    );
  });
});
