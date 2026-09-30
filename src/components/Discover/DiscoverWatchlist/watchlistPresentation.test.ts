import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  WATCHLIST_PREFERENCE_KEY,
  defaultWatchlistPreferences,
  getWatchlistPreferenceKey,
  readWatchlistPreferences,
  resolveEligibleWatchlistOwner,
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
        queryOwner: 'all',
        querySort: 'title_desc',
        queryWatched: 'watched',
        stored: {
          owner: 'me',
          category: 'movies',
          sort: 'added_asc',
          watched: 'not_watched',
        },
      }),
      {
        owner: 'all',
        category: 'animation',
        sort: 'title_desc',
        watched: 'watched',
      }
    );
    assert.deepEqual(
      resolveWatchlistPreferences({
        queryCategory: 'invalid',
        queryOwner: 'invalid',
        querySort: 'invalid',
        queryWatched: 'invalid',
        stored: {
          owner: '42',
          category: 'series',
          sort: 'added_asc',
          watched: 'all',
        },
      }),
      {
        owner: '42',
        category: 'series',
        sort: 'added_asc',
        watched: 'all',
      }
    );
  });

  it('falls back safely when a persisted owner is deleted or excluded', () => {
    assert.equal(resolveEligibleWatchlistOwner('42', ['all', 'me', '7']), 'me');
    assert.equal(resolveEligibleWatchlistOwner('42', ['all', '7']), 'all');
    assert.equal(resolveEligibleWatchlistOwner('7', ['all', 'me', '7']), '7');
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
  const titleCard = readFileSync(
    path.join(__dirname, '../../TitleCard/index.tsx'),
    'utf8'
  );
  const movieDetails = readFileSync(
    path.join(__dirname, '../../MovieDetails/index.tsx'),
    'utf8'
  );
  const tvDetails = readFileSync(
    path.join(__dirname, '../../TvDetails/index.tsx'),
    'utf8'
  );
  const permissions = readFileSync(
    path.join(
      __dirname,
      '../../UserProfile/UserSettings/UserPermissions/index.tsx'
    ),
    'utf8'
  );
  const bulkEdit = readFileSync(
    path.join(__dirname, '../../UserList/BulkEditModal.tsx'),
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
    assert.match(page, /includeInUserMetrics=true/);
    assert.match(page, /value: 'all'/);
    assert.match(page, /value: 'me'/);
    assert.doesNotMatch(page, /<UserSelector/);
    assert.doesNotMatch(page, /AsyncSelect/);
    assert.doesNotMatch(page, /ownerMode|specificUser/);
    assert.match(page, /sort=displayname&sortDirection=asc/);
    assert.match(page, /localStorage\.setItem/);
    assert.match(page, /w-48 max-w-full/);
    assert.match(page, /relative z-50/);
    assert.match(page, /filter\(\(\{ id \}\) => id !== currentUser\?\.id\)/);
    assert.ok(
      page.indexOf('value="all"') < page.indexOf('value="not_watched"')
    );
    assert.ok(
      page.indexOf('value="not_watched"') < page.indexOf('value="watched"')
    );
  });

  it('places the metrics inclusion control on the native permissions form', () => {
    assert.match(permissions, /includeInUserMetrics/);
    assert.match(permissions, /Include in user metrics/);
    assert.doesNotMatch(permissions, /Include this account in user metrics\./);
    assert.match(permissions, /font-medium text-white/);
    assert.match(permissions, /type="checkbox"/);
  });

  it('supports unchanged, included, and excluded metrics state in Bulk Edit', () => {
    assert.match(bulkEdit, /includeInUserMetrics/);
    assert.match(bulkEdit, /value="unchanged"/);
    assert.match(bulkEdit, /value="include"/);
    assert.match(bulkEdit, /value="exclude"/);
    assert.match(bulkEdit, /metricsUpdate !== 'unchanged'/);
  });

  it('never hides Watchlist membership because of availability or request state', () => {
    assert.match(
      page,
      /hideAvailable: false, hideBlocklisted: false, hideRequested: false/
    );
    assert.match(page, /plexItems=\{titles\}/);
  });

  it('renders completion and owner evidence without per-card provider reads', () => {
    assert.match(listView, /watchState=\{title\.watchState\}/);
    assert.match(titleCard, /watchState === 'watched'/);
    assert.doesNotMatch(titleCard, /watchState === 'not_watched'/);
    assert.doesNotMatch(titleCard, /watchState === 'unknown'/);
    assert.match(titleCard, /absolute left-2 top-10/);
    assert.match(titleCard, /absolute bottom-12 left-2/);
    assert.match(listView, /title\.requestedBy\?\.displayName/);
    assert.doesNotMatch(listView, /api\/v1\/.*jellyfin/i);
  });

  it('uses accessible outline and filled stars for Watchlist membership', () => {
    for (const source of [titleCard, movieDetails, tvDetails]) {
      assert.match(source, /aria-label=\{intl\.formatMessage\(/);
      assert.match(source, /StarIcon/);
      assert.doesNotMatch(source, /MinusCircleIcon/);
    }
    assert.match(titleCard, /StarIcon as StarIconSolid/);
    assert.match(titleCard, /messages\.addToWatchList/);
    assert.match(titleCard, /messages\.removeFromWatchList/);
    assert.match(movieDetails, /StarIcon as StarIconSolid/);
    assert.match(tvDetails, /StarIcon as StarIconOutline/);
  });

  it('keeps Watchlist and Blocklist actions compact and accessible', () => {
    assert.match(titleCard, /!border-transparent !bg-transparent !p-1\.5/);
    assert.match(titleCard, /globalMessages\.addToBlocklist/);
    assert.match(titleCard, /globalMessages\.removefromBlocklist/);
    assert.match(titleCard, /<EyeSlashIcon/);
    assert.match(titleCard, /<EyeIcon/);
    assert.ok(
      (titleCard.match(/aria-label=\{intl\.formatMessage\(/g) ?? []).length >= 4
    );
  });

  it('uses the existing Request modal flow from an accessible compact action', () => {
    assert.match(
      titleCard,
      /Tooltip[\s\S]*?content=\{intl\.formatMessage\(globalMessages\.request\)\}/
    );
    assert.match(
      titleCard,
      /aria-label=\{intl\.formatMessage\(globalMessages\.request\)\}/
    );
    assert.match(titleCard, /setShowRequestModal\(true\)/);
    assert.match(titleCard, /!h-8 !w-8 !p-1\.5/);
    assert.doesNotMatch(titleCard, /className="h-7 w-full"/);
  });

  it('keeps card navigation on canonical typed TMDB routes', () => {
    assert.match(titleCard, /mediaType === 'movie'/);
    assert.match(titleCard, /`\/movie\/\$\{id\}`/);
    assert.match(titleCard, /`\/tv\/\$\{id\}`/);
    assert.match(listView, /id=\{title\.tmdbId\}/);
    assert.match(listView, /type=\{title\.mediaType\}/);
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
