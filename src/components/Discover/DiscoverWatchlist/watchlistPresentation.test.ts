import { MediaStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
// Client unit tests execute under the server test tsconfig, which has no @app alias.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import { buildTitleCardStateIndicators } from '../../TitleCard/stateIndicators';
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
  const statusBadgeMini = readFileSync(
    path.join(__dirname, '../../Common/StatusBadgeMini/index.tsx'),
    'utf8'
  );
  const actionStateGrid = readFileSync(
    path.join(__dirname, '../../TitleCard/ActionStateGrid.tsx'),
    'utf8'
  );
  const cornerBadge = readFileSync(
    path.join(__dirname, '../../TitleCard/CornerBadge.tsx'),
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

  it('uses one native boolean checkbox for bulk metrics updates', () => {
    assert.match(bulkEdit, /includeInUserMetrics/);
    assert.match(bulkEdit, /id="bulkIncludeInUserMetrics"/);
    assert.match(bulkEdit, /type="checkbox"/);
    assert.match(bulkEdit, /includeInUserMetrics,\s*\}\);/);
    assert.match(
      bulkEdit,
      /selectedUsers\.every\(\(user\) => user\.includeInUserMetrics\)/
    );
    assert.equal((bulkEdit.match(/type="checkbox"/g) ?? []).length, 1);
    assert.doesNotMatch(
      bulkEdit,
      /applyMetricsSetting|applyBulkIncludeInUserMetrics|metricsUnchanged|<select/
    );
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
    assert.match(titleCard, /buildTitleCardStateIndicators/);
    assert.match(titleCard, /data-testid="title-card-classification-state"/);
    assert.match(titleCard, /data-testid="title-card-owner-region"/);
    assert.match(titleCard, /tone="owner"/);
    assert.doesNotMatch(titleCard, /CheckCircleIcon/);
    assert.match(listView, /title\.requestedBy\?\.displayName/);
    assert.doesNotMatch(listView, /api\/v1\/.*jellyfin/i);
  });

  it('builds a dense availability-then-Watched state indicator list', () => {
    const states = (
      currentStatus: MediaStatus | undefined,
      watchState: 'watched' | 'not_watched' | 'unknown' | undefined
    ) =>
      buildTitleCardStateIndicators({ currentStatus, watchState }).map(
        ({ status }) => status
      );

    assert.deepEqual(states(MediaStatus.AVAILABLE, undefined), [
      MediaStatus.AVAILABLE,
    ]);
    assert.deepEqual(states(MediaStatus.PARTIALLY_AVAILABLE, undefined), [
      MediaStatus.PARTIALLY_AVAILABLE,
    ]);
    assert.deepEqual(states(MediaStatus.DELETED, undefined), [
      MediaStatus.DELETED,
    ]);
    assert.deepEqual(states(undefined, 'watched'), ['watched']);
    assert.deepEqual(states(MediaStatus.AVAILABLE, 'watched'), [
      MediaStatus.AVAILABLE,
      'watched',
    ]);
    assert.deepEqual(states(MediaStatus.PARTIALLY_AVAILABLE, 'watched'), [
      MediaStatus.PARTIALLY_AVAILABLE,
      'watched',
    ]);
    assert.deepEqual(states(MediaStatus.DELETED, 'watched'), [
      MediaStatus.DELETED,
      'watched',
    ]);
    assert.deepEqual(states(MediaStatus.AVAILABLE, 'not_watched'), [
      MediaStatus.AVAILABLE,
    ]);
    assert.deepEqual(states(MediaStatus.AVAILABLE, 'unknown'), [
      MediaStatus.AVAILABLE,
    ]);
    assert.deepEqual(states(MediaStatus.UNKNOWN, undefined), []);
  });

  it('uses the shared mini-state primitive for availability and Watched icons', () => {
    assert.match(
      statusBadgeMini,
      /case MediaStatus\.AVAILABLE:[\s\S]*?indicatorIcon = <CheckCircleIcon \/>/
    );
    assert.match(
      statusBadgeMini,
      /case MediaStatus\.PARTIALLY_AVAILABLE:[\s\S]*?indicatorIcon = <MinusSmallIcon \/>/
    );
    assert.match(
      statusBadgeMini,
      /case MediaStatus\.DELETED:[\s\S]*?indicatorIcon = <TrashIcon \/>/
    );
    assert.match(
      statusBadgeMini,
      /case 'watched':[\s\S]*?indicatorIcon = <PlayIcon \/>/
    );
    assert.match(
      statusBadgeMini,
      /case 'watched':[\s\S]*?bg-cyan-500\/80[\s\S]*?indicatorIcon = <PlayIcon \/>/
    );
    assert.match(statusBadgeMini, /data-state-indicator=\{indicatorName\}/);
    assert.match(statusBadgeMini, /role=\{label \? 'img' : undefined\}/);
    assert.match(statusBadgeMini, /<Tooltip content=\{label\}>/);
    assert.doesNotMatch(statusBadgeMini, /<button|<a\s/i);
  });

  it('keeps classification, ordered states, and owner in independent regions', () => {
    assert.match(titleCard, /data-testid="title-card-classification-state"/);
    assert.match(titleCard, /globalMessages\.movie/);
    assert.match(titleCard, /globalMessages\.tvshow/);
    assert.match(titleCard, /rightSideStates = stateIndicators\.map/);
    assert.match(titleCard, /status=\{indicator\.status\}/);
    assert.match(titleCard, /indicator\.id === 'watched'/);
    assert.match(titleCard, /intl\.formatMessage\(messages\.watched\)/);
    assert.match(
      titleCard,
      /<ActionStateGrid\s+actions=\{rightSideActions\}\s+states=\{rightSideStates\}/
    );
    assert.match(actionStateGrid, /data-action-slot=\{action\.id\}/);
    assert.match(actionStateGrid, /data-state-slot=\{state\.id\}/);
    assert.match(actionStateGrid, /grid-cols-\[1\.75rem_1\.75rem\]/);
    assert.match(actionStateGrid, /auto-rows-\[1\.75rem\]/);
    assert.match(titleCard, /watchlistOwnerName/);
    assert.match(titleCard, /data-testid="title-card-corner-frame"/);
    assert.match(
      titleCard,
      /grid-cols-\[minmax\(0,1fr\)_auto\] grid-rows-\[auto_1fr_auto\]/
    );
    assert.match(titleCard, /data-testid="title-card-action-state-region"/);
    assert.match(titleCard, /data-testid="title-card-owner-region"/);
    assert.match(titleCard, /data-testid="title-card-request-region"/);
    assert.match(cornerBadge, /h-7 max-w-full items-center rounded-md/);
    assert.match(cornerBadge, /leading-5/);
    assert.doesNotMatch(cornerBadge, /rounded-md border/);
    assert.match(
      titleCard,
      /data-testid="title-card-corner-frame"[\s\S]*?data-testid="title-card-classification-state"[\s\S]*?data-testid="title-card-action-state-region"[\s\S]*?data-testid="title-card-owner-region"[\s\S]*?data-testid="title-card-request-region"/
    );
    assert.doesNotMatch(
      titleCard,
      /<Badge badgeType="success">[\s\S]*?messages\.watched/
    );
  });

  it('uses one invariant Watchlist action slot for outline and filled stars', () => {
    const descriptorStart = titleCard.indexOf('const watchlistAction =');
    const descriptorEnd = titleCard.indexOf(
      'const canAddToBlocklist',
      descriptorStart
    );
    const watchlistSlotStart = titleCard.indexOf(
      "id: 'watchlist'",
      descriptorEnd
    );
    const watchlistSlotEnd = titleCard.indexOf(
      "id: 'blocklist'",
      watchlistSlotStart
    );
    const descriptor = titleCard.slice(descriptorStart, descriptorEnd);
    const watchlistSlot = titleCard.slice(watchlistSlotStart, watchlistSlotEnd);

    assert.ok(descriptorStart >= 0);
    assert.ok(descriptorEnd > descriptorStart);
    assert.ok(watchlistSlotStart > descriptorEnd);
    assert.ok(watchlistSlotEnd > watchlistSlotStart);
    assert.match(descriptor, /<StarIcon className=/);
    assert.match(descriptor, /<StarIconSolid className=/);
    assert.equal(
      (descriptor.match(/className=\{watchlistIconClassName\}/g) ?? []).length,
      2
    );
    assert.match(
      titleCard,
      /const watchlistIconClassName =\s*'!h-\[1\.4375rem\] !w-\[1\.4375rem\] text-amber-300'/
    );
    assert.match(descriptor, /onClick: onClickWatchlistBtn/);
    assert.match(descriptor, /onClick: onClickDeleteWatchlistBtn/);
    assert.equal((watchlistSlot.match(/<Button/g) ?? []).length, 1);
    assert.match(watchlistSlot, /content=\{watchlistAction\.label\}/);
    assert.match(watchlistSlot, /aria-label=\{watchlistAction\.label\}/);
    assert.match(watchlistSlot, /onClick=\{watchlistAction\.onClick\}/);
    assert.match(watchlistSlot, /\{watchlistAction\.icon\}/);
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
    assert.match(titleCard, /!rounded-full !border-0 !bg-transparent !p-0/);
    assert.match(titleCard, /hover:!bg-transparent/);
    assert.match(titleCard, /focus-visible:!ring-2/);
    assert.match(titleCard, /hover:!border-0/);
    assert.match(titleCard, /globalMessages\.addToBlocklist/);
    assert.match(titleCard, /globalMessages\.removefromBlocklist/);
    assert.match(titleCard, /<NoSymbolIcon/);
    assert.match(titleCard, /<EyeIcon/);
    assert.match(
      titleCard,
      /currentStatus !== MediaStatus\.PROCESSING[\s\S]*?currentStatus !== MediaStatus\.AVAILABLE[\s\S]*?currentStatus !== MediaStatus\.PARTIALLY_AVAILABLE[\s\S]*?currentStatus !== MediaStatus\.PENDING/
    );
    assert.ok(
      titleCard.indexOf("id: 'watchlist'") <
        titleCard.indexOf("id: 'blocklist'")
    );
    assert.match(titleCard, /aria-label=\{watchlistAction\.label\}/);
    assert.match(titleCard, /aria-label=\{blocklistAction\.label\}/);
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
    assert.match(titleCard, /data-testid="title-card-request-region"/);
    assert.match(titleCard, /buttonType="primary"/);
    assert.match(titleCard, /!h-8 !w-8 !rounded-md !border-transparent/);
    assert.match(titleCard, /!bg-orange-500\/90/);
    assert.match(titleCard, /!text-white/);
    assert.match(titleCard, /hover:!bg-orange-400/);
    assert.match(titleCard, /active:!bg-orange-600/);
    assert.match(titleCard, /focus:!ring-orange-300/);
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
