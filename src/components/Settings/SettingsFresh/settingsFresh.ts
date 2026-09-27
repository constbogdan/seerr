export interface FreshSettingsResponse {
  enabled: boolean;
  baseUrl: string;
  filterId: number;
  cachedFilterName: string;
  mediaEligibilityDays: number;
  freshVisibilityDays: number;
  includeGenreIds: number[];
  excludeGenreIds: number[];
  includeOriginalLanguages: string[];
  excludeOriginalLanguages: string[];
  includeContentRatings: string[];
  excludeContentRatings: string[];
  minimumTmdbScore: number;
  minimumTmdbVotes: number;
  apiTokenConfigured: boolean;
}

export interface FreshSettingsFormValues {
  enabled: boolean;
  protocol: 'http' | 'https';
  hostname: string;
  port: number;
  basePath: string;
  apiToken: string;
  filterId: number;
  cachedFilterName: string;
  mediaEligibilityDays: number;
  freshVisibilityDays: number;
  includeGenreIds: number[];
  excludeGenreIds: number[];
  includeOriginalLanguages: string[];
  excludeOriginalLanguages: string[];
  includeContentRatings: string[];
  excludeContentRatings: string[];
  minimumTmdbScore: number;
  minimumTmdbVotes: number;
}

export interface FreshSettingsUpdate {
  enabled: boolean;
  baseUrl: string;
  apiToken?: string;
  filterId: number;
  cachedFilterName: string;
  mediaEligibilityDays: number;
  freshVisibilityDays: number;
  includeGenreIds: number[];
  excludeGenreIds: number[];
  includeOriginalLanguages: string[];
  excludeOriginalLanguages: string[];
  includeContentRatings: string[];
  excludeContentRatings: string[];
  minimumTmdbScore: number;
  minimumTmdbVotes: number;
}

export interface FreshFilterOption {
  id: number;
  name: string;
  enabled?: boolean;
}

export interface FreshFilterSelectOption {
  value: number;
  label: string;
}

const DEFAULT_AUTOBRR_PORT = 7474;
export const CONFIGURED_TOKEN_MASK = '•'.repeat(28);

export const splitAutobrrBaseUrl = (
  baseUrl: string
): Pick<
  FreshSettingsFormValues,
  'protocol' | 'hostname' | 'port' | 'basePath'
> => {
  if (!baseUrl.trim()) {
    return {
      protocol: 'http',
      hostname: '',
      port: DEFAULT_AUTOBRR_PORT,
      basePath: '',
    };
  }

  const url = new URL(baseUrl);
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return {
    protocol,
    hostname: url.hostname,
    port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80,
    basePath: url.pathname === '/' ? '' : url.pathname.replace(/\/$/, ''),
  };
};

export const composeAutobrrBaseUrl = (
  values: Pick<
    FreshSettingsFormValues,
    'protocol' | 'hostname' | 'port' | 'basePath'
  >
): string => {
  const hostname = values.hostname.trim();
  if (!hostname) return '';
  const bracketedHostname =
    hostname.includes(':') && !hostname.startsWith('[')
      ? `[${hostname}]`
      : hostname;
  const url = new URL(
    `${values.protocol}://${bracketedHostname}:${Number(values.port)}`
  );
  url.pathname = values.basePath || '/';
  return url.toString().replace(/\/$/, '');
};

export const toFreshSettingsFormValues = (
  settings: FreshSettingsResponse
): FreshSettingsFormValues => ({
  enabled: settings.enabled,
  ...splitAutobrrBaseUrl(settings.baseUrl),
  apiToken: settings.apiTokenConfigured ? CONFIGURED_TOKEN_MASK : '',
  filterId: settings.filterId,
  cachedFilterName: settings.cachedFilterName,
  mediaEligibilityDays: settings.mediaEligibilityDays,
  freshVisibilityDays: settings.freshVisibilityDays,
  includeGenreIds: [...settings.includeGenreIds],
  excludeGenreIds: [...settings.excludeGenreIds],
  includeOriginalLanguages: [...settings.includeOriginalLanguages],
  excludeOriginalLanguages: [...settings.excludeOriginalLanguages],
  includeContentRatings: [...settings.includeContentRatings],
  excludeContentRatings: [...settings.excludeContentRatings],
  minimumTmdbScore: settings.minimumTmdbScore,
  minimumTmdbVotes: settings.minimumTmdbVotes,
});

export const toFreshSettingsUpdate = (
  values: FreshSettingsFormValues
): FreshSettingsUpdate => {
  const update: FreshSettingsUpdate = {
    enabled: values.enabled,
    baseUrl: composeAutobrrBaseUrl(values),
    filterId: Number(values.filterId),
    cachedFilterName: values.cachedFilterName,
    mediaEligibilityDays: Number(values.mediaEligibilityDays),
    freshVisibilityDays: Number(values.freshVisibilityDays),
    includeGenreIds: values.includeGenreIds.map(Number),
    excludeGenreIds: values.excludeGenreIds.map(Number),
    includeOriginalLanguages: [...values.includeOriginalLanguages],
    excludeOriginalLanguages: [...values.excludeOriginalLanguages],
    includeContentRatings: [...values.includeContentRatings],
    excludeContentRatings: [...values.excludeContentRatings],
    minimumTmdbScore: Number(values.minimumTmdbScore),
    minimumTmdbVotes: Number(values.minimumTmdbVotes),
  };
  const apiToken = values.apiToken.trim();
  if (apiToken && apiToken !== CONFIGURED_TOKEN_MASK)
    update.apiToken = apiToken;
  return update;
};

export const toFreshConnectionUpdate = (
  values: FreshSettingsFormValues
): Pick<FreshSettingsUpdate, 'baseUrl' | 'apiToken'> => {
  const update = toFreshSettingsUpdate(values);
  return {
    baseUrl: update.baseUrl,
    ...(update.apiToken ? { apiToken: update.apiToken } : {}),
  };
};

export const toFreshFilterSelectOptions = (
  filters: FreshFilterOption[]
): FreshFilterSelectOption[] =>
  filters.map((filter) => ({ value: filter.id, label: filter.name }));

export const selectedFreshFilter = (
  options: FreshFilterSelectOption[],
  filterId: number,
  unavailableLabel = `Unavailable filter (ID ${filterId})`
): FreshFilterSelectOption | null =>
  options.find((option) => option.value === Number(filterId)) ??
  (filterId ? { value: filterId, label: unavailableLabel } : null);

export const loadFreshFilters = async (
  request: () => Promise<FreshFilterOption[]>
): Promise<{ ok: true; filters: FreshFilterOption[] } | { ok: false }> => {
  try {
    return { ok: true, filters: await request() };
  } catch {
    return { ok: false };
  }
};
