import {
  getBottomNavigationDestinationRules,
  getVisibleNavigationDestinationRules,
  isNavigationDestinationActive,
  navigationDestinationRules,
  type NavigationDestinationId,
  type NavigationDestinationRule,
} from '@app/components/Layout/navigationConfig';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowRightStartOnRectangleIcon,
  BookmarkIcon,
  ClockIcon,
  CogIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  FilmIcon,
  FireIcon,
  FolderOpenIcon,
  SparklesIcon,
  TvIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
import {
  ArrowRightStartOnRectangleIcon as FilledArrowRightStartOnRectangleIcon,
  BookmarkIcon as FilledBookmarkIcon,
  ClockIcon as FilledClockIcon,
  CogIcon as FilledCogIcon,
  ExclamationTriangleIcon as FilledExclamationTriangleIcon,
  EyeSlashIcon as FilledEyeSlashIcon,
  FilmIcon as FilledFilmIcon,
  FireIcon as FilledFireIcon,
  FolderOpenIcon as FilledFolderOpenIcon,
  SparklesIcon as FilledSparklesIcon,
  TvIcon as FilledTvIcon,
  UsersIcon as FilledUsersIcon,
} from '@heroicons/react/24/solid';

export const menuMessages = defineMessages('components.Layout.Sidebar', {
  dashboard: 'Discover',
  browsemovies: 'Movies',
  browsetv: 'Series',
  requests: 'Requests',
  blocklist: 'Blocklist',
  issues: 'Issues',
  users: 'Users',
  settings: 'Settings',
  fresh: 'Fresh',
  watchlist: 'Watchlist',
  library: 'Library',
  leavingSoon: 'Leaving Soon',
  more: 'More',
  closeMore: 'Close navigation menu',
  navigation: 'Primary navigation',
});

type NavigationIcon = typeof SparklesIcon;

export interface NavigationDestination extends NavigationDestinationRule {
  icon: NavigationIcon;
  selectedIcon: NavigationIcon;
  sidebarIcon?: NavigationIcon;
}

const navigationIcons: Record<
  NavigationDestinationId,
  Pick<NavigationDestination, 'icon' | 'selectedIcon' | 'sidebarIcon'>
> = {
  discover: {
    icon: SparklesIcon,
    selectedIcon: FilledSparklesIcon,
  },
  fresh: {
    icon: FireIcon,
    selectedIcon: FilledFireIcon,
  },
  movies: {
    icon: FilmIcon,
    selectedIcon: FilledFilmIcon,
  },
  watchlist: {
    icon: BookmarkIcon,
    selectedIcon: FilledBookmarkIcon,
  },
  series: {
    icon: TvIcon,
    selectedIcon: FilledTvIcon,
  },
  'leaving-soon': {
    icon: ArrowRightStartOnRectangleIcon,
    selectedIcon: FilledArrowRightStartOnRectangleIcon,
  },
  requests: {
    icon: ClockIcon,
    selectedIcon: FilledClockIcon,
  },
  library: {
    icon: FolderOpenIcon,
    selectedIcon: FilledFolderOpenIcon,
    sidebarIcon: FilledFolderOpenIcon,
  },
  blocklist: {
    icon: EyeSlashIcon,
    selectedIcon: FilledEyeSlashIcon,
  },
  issues: {
    icon: ExclamationTriangleIcon,
    selectedIcon: FilledExclamationTriangleIcon,
  },
  users: {
    icon: UsersIcon,
    selectedIcon: FilledUsersIcon,
  },
  settings: {
    icon: CogIcon,
    selectedIcon: FilledCogIcon,
  },
};

export const navigationDestinations: NavigationDestination[] =
  navigationDestinationRules.map((destination) => ({
    ...destination,
    ...navigationIcons[destination.id],
  }));

type NavigationVisibilityContext = Parameters<
  typeof getVisibleNavigationDestinationRules
>[0];

export const getVisibleNavigationDestinations = ({
  freshEnabled,
  hasPermission,
}: NavigationVisibilityContext): NavigationDestination[] =>
  getVisibleNavigationDestinationRules({ freshEnabled, hasPermission }).map(
    (destination) => ({
      ...destination,
      ...navigationIcons[destination.id],
    })
  );

export const getBottomNavigationDestinations = (
  destinations: NavigationDestination[],
  isAdmin: boolean
): NavigationDestination[] =>
  getBottomNavigationDestinationRules(
    destinations,
    isAdmin ? 'admin' : 'regular'
  ) as NavigationDestination[];

export { isNavigationDestinationActive };
