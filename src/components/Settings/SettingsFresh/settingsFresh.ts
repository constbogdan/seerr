import type { FreshSettings } from '@server/lib/settings';

export type FreshSettingsResponse = Omit<FreshSettings, 'apiToken'> & {
  apiTokenConfigured: boolean;
};
export type FreshSettingsDraft = Omit<FreshSettings, 'baseUrl'> & {
  hostname: string;
  port: number;
  ssl: boolean;
  basePath: string;
  excludeGenreIds: number[];
  excludeOriginalLanguages: string[];
  minimumTmdbScore: number;
  minimumTmdbVotes: number;
};

export const toFreshSettingsDraft = (
  settings: FreshSettingsResponse
): FreshSettingsDraft => {
  const url = settings.baseUrl ? new URL(settings.baseUrl) : undefined;
  return {
    enabled: settings.enabled,
    hostname: url?.hostname ?? '',
    port: url
      ? Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      : 7474,
    ssl: url?.protocol === 'https:',
    basePath:
      url && url.pathname !== '/' ? url.pathname.replace(/\/$/, '') : '',
    apiToken: '',
    filterId: settings.filterId,
    cachedFilterName: settings.cachedFilterName,
    freshVisibilityDays: settings.freshVisibilityDays,
    excludeGenreIds: [...(settings.excludeGenreIds ?? [])],
    excludeOriginalLanguages: [...(settings.excludeOriginalLanguages ?? [])],
    minimumTmdbScore: settings.minimumTmdbScore ?? 0,
    minimumTmdbVotes: settings.minimumTmdbVotes ?? 0,
  };
};

export const toFreshSettingsUpdate = (
  values: FreshSettingsDraft
): FreshSettings => {
  const { hostname, port, ssl, basePath, ...settings } = values;
  const host = hostname.trim();
  if (/[\s/@?#]/.test(host)) throw new Error('Invalid hostname');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid port');
  const bracketed =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = host
    ? new URL(`${ssl ? 'https' : 'http'}://${bracketed}:${port}`)
    : undefined;
  if (url) url.pathname = basePath || '/';
  return { ...settings, baseUrl: url ? url.toString().replace(/\/$/, '') : '' };
};
