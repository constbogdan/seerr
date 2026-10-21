import type { PermissionCheckOptions } from '@server/lib/permissions';
import { Permission } from '@server/lib/permissions';

export type NavigationDestinationId =
  | 'discover'
  | 'fresh'
  | 'movies'
  | 'watchlist'
  | 'series'
  | 'leaving-soon'
  | 'requests'
  | 'library'
  | 'collections'
  | 'blocklist'
  | 'issues'
  | 'users'
  | 'settings';

export type NavigationMessageKey =
  | 'dashboard'
  | 'fresh'
  | 'browsemovies'
  | 'watchlist'
  | 'browsetv'
  | 'leavingSoon'
  | 'requests'
  | 'library'
  | 'collections'
  | 'blocklist'
  | 'issues'
  | 'users'
  | 'settings';

export type BottomNavigationRole = 'admin' | 'regular';

export interface NavigationDestinationRule {
  id: NavigationDestinationId;
  href: string;
  messagesKey: NavigationMessageKey;
  activeRegExp: RegExp;
  requiredPermission?: Permission | Permission[];
  permissionType?: PermissionCheckOptions['type'];
  requiresFresh?: boolean;
  bottomNavigationOrder?: Partial<Record<BottomNavigationRole, number>>;
}

export const navigationDestinationRules: NavigationDestinationRule[] = [
  {
    id: 'discover',
    href: '/',
    messagesKey: 'dashboard',
    activeRegExp: /^\/(?:discover(?:\/trending)?\/?)?$/,
    bottomNavigationOrder: { admin: 3, regular: 1 },
  },
  {
    id: 'fresh',
    href: '/fresh',
    messagesKey: 'fresh',
    activeRegExp: /^\/fresh(?:\/|$)/,
    requiresFresh: true,
  },
  {
    id: 'movies',
    href: '/discover/movies',
    messagesKey: 'browsemovies',
    activeRegExp: /^\/discover\/movies(?:\/|$)/,
    bottomNavigationOrder: { regular: 2 },
  },
  {
    id: 'watchlist',
    href: '/discover/watchlist',
    messagesKey: 'watchlist',
    activeRegExp: /^\/discover\/watchlist(?:\/|$)/,
    bottomNavigationOrder: { admin: 2 },
  },
  {
    id: 'series',
    href: '/discover/tv',
    messagesKey: 'browsetv',
    activeRegExp: /^\/discover\/tv(?:\/|$)/,
    bottomNavigationOrder: { regular: 3 },
  },
  {
    id: 'leaving-soon',
    href: '/leaving-soon',
    messagesKey: 'leavingSoon',
    activeRegExp: /^\/leaving-soon(?:\/|$)/,
    bottomNavigationOrder: { admin: 5 },
  },
  {
    id: 'requests',
    href: '/requests',
    messagesKey: 'requests',
    activeRegExp: /^\/requests(?:\/|$)/,
    bottomNavigationOrder: { admin: 4, regular: 4 },
  },
  {
    id: 'library',
    href: '/library',
    messagesKey: 'library',
    activeRegExp: /^\/library(?:\/|$)/,
    requiredPermission: Permission.ADMIN,
    bottomNavigationOrder: { admin: 1 },
  },
  {
    id: 'collections',
    href: '/collections',
    messagesKey: 'collections',
    activeRegExp: /^\/collections(?:\/|$)|^\/collection(?:\/|$)/,
    requiredPermission: Permission.ADMIN,
  },
  {
    id: 'blocklist',
    href: '/blocklist',
    messagesKey: 'blocklist',
    activeRegExp: /^\/blocklist(?:\/|$)/,
    requiredPermission: [
      Permission.MANAGE_BLOCKLIST,
      Permission.VIEW_BLOCKLIST,
    ],
    permissionType: 'or',
  },
  {
    id: 'issues',
    href: '/issues',
    messagesKey: 'issues',
    activeRegExp: /^\/issues(?:\/|$)/,
    requiredPermission: [
      Permission.MANAGE_ISSUES,
      Permission.CREATE_ISSUES,
      Permission.VIEW_ISSUES,
    ],
    permissionType: 'or',
  },
  {
    id: 'users',
    href: '/users',
    messagesKey: 'users',
    activeRegExp: /^\/users(?:\/|$)/,
    requiredPermission: Permission.MANAGE_USERS,
  },
  {
    id: 'settings',
    href: '/settings',
    messagesKey: 'settings',
    activeRegExp: /^\/settings(?:\/|$)/,
    requiredPermission: Permission.ADMIN,
  },
];

interface NavigationVisibilityContext {
  freshEnabled: boolean;
  hasPermission: (
    permission: Permission | Permission[],
    options?: PermissionCheckOptions
  ) => boolean;
}

export const getVisibleNavigationDestinationRules = ({
  freshEnabled,
  hasPermission,
}: NavigationVisibilityContext): NavigationDestinationRule[] =>
  navigationDestinationRules.filter(
    (destination) =>
      (!destination.requiresFresh || freshEnabled) &&
      (!destination.requiredPermission ||
        hasPermission(destination.requiredPermission, {
          type: destination.permissionType ?? 'and',
        }))
  );

export const isNavigationDestinationActive = (
  destination: NavigationDestinationRule,
  pathname: string
): boolean => destination.activeRegExp.test(pathname);

export const getBottomNavigationDestinationRules = (
  destinations: NavigationDestinationRule[],
  role: BottomNavigationRole
): NavigationDestinationRule[] =>
  destinations
    .filter(
      (destination) => destination.bottomNavigationOrder?.[role] !== undefined
    )
    .sort(
      (left, right) =>
        (left.bottomNavigationOrder?.[role] ?? 0) -
        (right.bottomNavigationOrder?.[role] ?? 0)
    );
