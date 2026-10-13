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
    assert.deepEqual(visibleIds(Permission.ADMIN), expectedFullInventory);
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

  it('uses the route-equivalent OR permission rules for Issues and Blocklist', () => {
    assert.ok(visibleIds(Permission.CREATE_ISSUES).includes('issues'));
    assert.ok(visibleIds(Permission.VIEW_ISSUES).includes('issues'));
    assert.ok(visibleIds(Permission.MANAGE_ISSUES).includes('issues'));
    assert.ok(visibleIds(Permission.VIEW_BLOCKLIST).includes('blocklist'));
    assert.ok(visibleIds(Permission.MANAGE_BLOCKLIST).includes('blocklist'));
    assert.ok(visibleIds(Permission.MANAGE_USERS).includes('users'));
  });

  it('removes only Fresh when the Fresh feature is disabled', () => {
    assert.deepEqual(
      visibleIds(Permission.ADMIN, false),
      expectedFullInventory.filter((id) => id !== 'fresh')
    );
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
});
