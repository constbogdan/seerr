import { hasPermission, Permission } from '@server/lib/permissions';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  getBottomNavigationDestinationRules,
  getVisibleNavigationDestinationRules,
  isNavigationDestinationActive,
  navigationDestinationRules,
} from './navigationConfig';

const expectedFullInventory = [
  'discover',
  'fresh',
  'movies',
  'watchlist',
  'series',
  'leaving-soon',
  'requests',
  'library',
  'collections',
  'blocklist',
  'issues',
  'users',
  'settings',
];

const visibleIds = (permissions: number, freshEnabled = true) =>
  getVisibleNavigationDestinationRules({
    freshEnabled,
    hasPermission: (required, options) =>
      hasPermission(required, permissions, options),
  }).map((destination) => destination.id);

const bottomIds = (permissions: number, role: 'admin' | 'regular') =>
  getBottomNavigationDestinationRules(
    getVisibleNavigationDestinationRules({
      freshEnabled: true,
      hasPermission: (required, options) =>
        hasPermission(required, permissions, options),
    }),
    role
  ).map((destination) => destination.id);

describe('shared application navigation', () => {
  it('defines the complete full-navigation inventory and intended order once', () => {
    assert.deepEqual(
      navigationDestinationRules.map((destination) => destination.id),
      expectedFullInventory
    );
  });

  it('defines role-specific bottom navigation without duplicating destinations', () => {
    assert.deepEqual(bottomIds(Permission.ADMIN, 'admin'), [
      'library',
      'watchlist',
      'discover',
      'requests',
      'leaving-soon',
    ]);
    assert.deepEqual(bottomIds(Permission.NONE, 'regular'), [
      'discover',
      'movies',
      'series',
      'requests',
    ]);
    assert.deepEqual(bottomIds(Permission.NONE, 'admin'), [
      'watchlist',
      'discover',
      'requests',
      'leaving-soon',
    ]);
    assert.ok(!bottomIds(Permission.NONE, 'admin').includes('library'));
  });

  it('gives administrators the same complete feature-enabled inventory', () => {
    assert.deepEqual(
      visibleIds(Permission.ADMIN),
      expectedFullInventory.filter((id) => id !== 'blocklist')
    );
  });

  it('does not expose administrator or delegated destinations without permission', () => {
    assert.deepEqual(visibleIds(Permission.NONE), [
      'discover',
      'fresh',
      'movies',
      'watchlist',
      'series',
      'leaving-soon',
      'requests',
    ]);
    assert.deepEqual(
      visibleIds(Permission.REQUEST),
      visibleIds(Permission.NONE)
    );
  });

  it('preserves Issues permissions while hiding Blocklist navigation for every role', () => {
    assert.ok(visibleIds(Permission.CREATE_ISSUES).includes('issues'));
    assert.ok(visibleIds(Permission.VIEW_ISSUES).includes('issues'));
    assert.ok(visibleIds(Permission.MANAGE_ISSUES).includes('issues'));
    for (const permission of [
      Permission.ADMIN,
      Permission.VIEW_BLOCKLIST,
      Permission.MANAGE_BLOCKLIST,
    ]) {
      assert.ok(!visibleIds(permission).includes('blocklist'));
      assert.ok(!bottomIds(permission, 'admin').includes('blocklist'));
      assert.ok(!bottomIds(permission, 'regular').includes('blocklist'));
    }
    assert.ok(visibleIds(Permission.MANAGE_USERS).includes('users'));
  });

  it('removes only Fresh when the Fresh feature is disabled', () => {
    assert.deepEqual(
      visibleIds(Permission.ADMIN, false),
      expectedFullInventory.filter((id) => id !== 'fresh' && id !== 'blocklist')
    );
  });

  it('retains the direct Blocklist page, API and existing permission checks', () => {
    const destination = navigationDestinationRules.find(
      ({ id }) => id === 'blocklist'
    );
    assert.ok(destination);
    assert.equal(destination.href, '/blocklist');
    assert.equal(destination.permissionType, 'or');
    assert.deepEqual(destination.requiredPermission, [
      Permission.MANAGE_BLOCKLIST,
      Permission.VIEW_BLOCKLIST,
    ]);
    const page = readFileSync(
      path.join(__dirname, '../../pages/blocklist/index.tsx'),
      'utf8'
    );
    assert.match(
      page,
      /useRouteGuard\(\[Permission\.MANAGE_BLOCKLIST, Permission\.VIEW_BLOCKLIST\]/
    );
    assert.match(page, /return <Blocklist \/>/);
    for (const detail of ['MovieDetails', 'TvDetails']) {
      const source = readFileSync(
        path.join(__dirname, `../${detail}/index.tsx`),
        'utf8'
      );
      assert.match(source, /<BlocklistModal/);
      assert.match(source, /onClick=\{\(\) => setShowBlocklistModal\(true\)\}/);
      assert.match(source, /axios\.post\('\/api\/v1\/blocklist'/);
    }
    const manage = readFileSync(
      path.join(__dirname, '../ManageSlideOver/index.tsx'),
      'utf8'
    );
    assert.match(manage, /globalMessages\.blocklist/);
  });

  it('matches nested routes without activating sibling destinations', () => {
    const destination = (id: string) => {
      const result = navigationDestinationRules.find((rule) => rule.id === id);
      assert.ok(result);
      return result;
    };

    assert.equal(
      isNavigationDestinationActive(
        destination('movies'),
        '/discover/movies/genre/28'
      ),
      true
    );
    assert.equal(
      isNavigationDestinationActive(
        destination('series'),
        '/discover/tv/network/49'
      ),
      true
    );
    assert.equal(
      isNavigationDestinationActive(
        destination('discover'),
        '/discover/trending'
      ),
      true
    );
    assert.equal(
      isNavigationDestinationActive(
        destination('discover'),
        '/discover/movies'
      ),
      false
    );
    assert.equal(
      isNavigationDestinationActive(
        destination('settings'),
        '/settings/removal'
      ),
      true
    );
    assert.equal(
      isNavigationDestinationActive(
        destination('collections'),
        '/collection/42'
      ),
      true
    );
  });

  it('drives desktop, tablet and phone full navigation from the shared filter', () => {
    const sidebar = readFileSync(
      path.join(__dirname, 'Sidebar/index.tsx'),
      'utf8'
    );
    const mobileMenu = readFileSync(
      path.join(__dirname, 'MobileMenu/index.tsx'),
      'utf8'
    );

    assert.match(sidebar, /getVisibleNavigationDestinations/);
    assert.match(sidebar, /visibleDestinations\.map/);
    assert.match(mobileMenu, /getVisibleNavigationDestinations/);
    assert.match(mobileMenu, /getBottomNavigationDestinations/);
    assert.match(mobileMenu, /filteredLinks\.map/);
    assert.match(mobileMenu, /currentSettings\.freshEnabled/);
    assert.doesNotMatch(sidebar, /const SidebarLinks/);
    assert.doesNotMatch(mobileMenu, /const menuLinks/);
  });

  it('keeps the icon-only bottom navigation and drawer controls named', () => {
    const mobileMenu = readFileSync(
      path.join(__dirname, 'MobileMenu/index.tsx'),
      'utf8'
    );
    const layout = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
    const sidebar = readFileSync(
      path.join(__dirname, 'Sidebar/index.tsx'),
      'utf8'
    );

    assert.match(mobileMenu, /aria-label=\{label\}/);
    assert.match(mobileMenu, /aria-expanded=\{isOpen\}/);
    assert.match(mobileMenu, /aria-controls="mobile-navigation-drawer"/);
    assert.match(mobileMenu, /menuMessages\.closeMore/);
    assert.match(mobileMenu, /menuMessages\.navigation/);
    assert.match(mobileMenu, /permissionsResolved/);
    assert.match(mobileMenu, /hasPermission\(Permission\.ADMIN\)/);
    assert.match(mobileMenu, /h-11 w-11/);
    assert.match(layout, /aria-expanded=\{isSidebarOpen\}/);
    assert.match(layout, /aria-controls="tablet-navigation-drawer"/);
    assert.match(sidebar, /id="tablet-navigation-drawer"/);
    assert.match(sidebar, /closeButtonRef\.current\?\.focus/);
    assert.doesNotMatch(sidebar, /role="button"/);
  });

  it('uses an accessible expandable Settings group on desktop and tablet', () => {
    const sidebar = readFileSync(
      path.join(__dirname, 'Sidebar/index.tsx'),
      'utf8'
    );

    assert.match(sidebar, /<button[\s\S]*?aria-expanded=\{expanded\}/);
    assert.match(sidebar, /aria-controls=\{submenuId\}/);
    assert.match(sidebar, /sidebarLink\.id === 'settings'/);
    assert.match(sidebar, /variant="desktop"/);
    assert.match(sidebar, /variant="tablet"/);
    assert.match(sidebar, /aria-current=\{active \? 'page' : undefined\}/);
    assert.match(sidebar, /activeItemRef\.current\?\.scrollIntoView/);
    assert.match(sidebar, /block: 'nearest'/);
    assert.match(sidebar, /closeDrawer=\{setClosed\}/);
    assert.match(sidebar, /className="mt-1 space-y-1 pl-9"/);
  });

  it('keeps phone Settings navigation flat while the page supplies a compact selector', () => {
    const mobileMenu = readFileSync(
      path.join(__dirname, 'MobileMenu/index.tsx'),
      'utf8'
    );
    const settingsLayout = readFileSync(
      path.join(__dirname, '../Settings/SettingsLayout.tsx'),
      'utf8'
    );
    const settingsSelector = readFileSync(
      path.join(__dirname, '../Settings/SettingsNavigationSelector.tsx'),
      'utf8'
    );

    assert.match(mobileMenu, /filteredLinks\.map/);
    assert.doesNotMatch(mobileMenu, /settings-submenu/);
    assert.match(settingsLayout, /SettingsNavigationSelector/);
    assert.match(settingsSelector, /className="lg:hidden"/);
  });
});
