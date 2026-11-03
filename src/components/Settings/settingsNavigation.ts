import type { SettingsRoute } from '@app/components/Common/SettingsTabs';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { MediaServerType } from '@server/constants/server';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings', {
  menuGeneralSettings: 'General',
  menuUsers: 'Users',
  menuPlexSettings: 'Plex',
  menuJellyfinSettings: '{mediaServerName}',
  menuServices: 'Services',
  menuStorage: 'Storage',
  menuWatchlistRoulette: 'Watchlist Roulette',
  menuNextSeason: 'Next Season',
  menuNetwork: 'Network',
  menuNotifications: 'Notifications',
  menuLogs: 'Logs',
  menuJobs: 'Jobs & Cache',
  menuAbout: 'About',
  menuMetadataProviders: 'Metadata Providers',
  menuDiscoverySources: 'Discovery Sources',
  menuHistoryImport: 'History Import',
  menuRemoval: 'Removal',
  selectSettingsPage: 'Select a Settings page',
});

export interface SettingsNavigationRoute extends SettingsRoute {
  id: string;
}

export const useSettingsNavigation = (): SettingsNavigationRoute[] => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const mediaServerType = currentSettings.mediaServerType;
  const mediaServerName =
    mediaServerType === MediaServerType.JELLYFIN
      ? 'Jellyfin'
      : mediaServerType === MediaServerType.EMBY
        ? 'Emby'
        : undefined;

  return [
    {
      id: 'general',
      text: intl.formatMessage(messages.menuGeneralSettings),
      route: '/settings/main',
      regex: /^\/settings(\/main)?$/,
    },
    {
      id: 'users',
      text: intl.formatMessage(messages.menuUsers),
      route: '/settings/users',
      regex: /^\/settings\/users/,
    },
    mediaServerType === MediaServerType.PLEX
      ? {
          id: 'media-server',
          text: intl.formatMessage(messages.menuPlexSettings),
          route: '/settings/plex',
          regex: /^\/settings\/plex/,
        }
      : {
          id: 'media-server',
          text: intl.formatMessage(messages.menuJellyfinSettings, {
            mediaServerName,
          }),
          route: '/settings/jellyfin',
          regex: /^\/settings\/jellyfin/,
        },
    {
      id: 'services',
      text: intl.formatMessage(messages.menuServices),
      route: '/settings/services',
      regex: /^\/settings\/services/,
    },
    {
      id: 'storage',
      text: intl.formatMessage(messages.menuStorage),
      route: '/settings/storage',
      regex: /^\/settings\/storage/,
    },
    {
      id: 'watchlist-roulette',
      text: intl.formatMessage(messages.menuWatchlistRoulette),
      route: '/settings/watchlist-roulette',
      regex: /^\/settings\/watchlist-roulette/,
    },
    {
      id: 'next-season',
      text: intl.formatMessage(messages.menuNextSeason),
      route: '/settings/next-season',
      regex: /^\/settings\/next-season/,
    },
    {
      id: 'network',
      text: intl.formatMessage(messages.menuNetwork),
      route: '/settings/network',
      regex: /^\/settings\/network/,
    },
    {
      id: 'metadata',
      text: intl.formatMessage(messages.menuMetadataProviders),
      route: '/settings/metadata',
      regex: /^\/settings\/metadata/,
    },
    {
      id: 'discovery-sources',
      text: intl.formatMessage(messages.menuDiscoverySources),
      route: '/settings/discovery-sources/fresh',
      regex: /^\/settings\/discovery-sources/,
    },
    {
      id: 'removal',
      text: intl.formatMessage(messages.menuRemoval),
      route: '/settings/removal',
      regex: /^\/settings\/removal/,
    },
    {
      id: 'notifications',
      text: intl.formatMessage(messages.menuNotifications),
      route: '/settings/notifications/email',
      regex: /^\/settings\/notifications/,
    },
    {
      id: 'logs',
      text: intl.formatMessage(messages.menuLogs),
      route: '/settings/logs',
      regex: /^\/settings\/logs/,
    },
    {
      id: 'jobs',
      text: intl.formatMessage(messages.menuJobs),
      route: '/settings/jobs',
      regex: /^\/settings\/jobs/,
    },
    {
      id: 'history-import',
      text: intl.formatMessage(messages.menuHistoryImport),
      route: '/settings/history-import',
      regex: /^\/settings\/history-import/,
    },
    {
      id: 'about',
      text: intl.formatMessage(messages.menuAbout),
      route: '/settings/about',
      regex: /^\/settings\/about/,
    },
  ];
};

export const settingsNavigationMessages = messages;
