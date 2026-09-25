import Autobrr, { type AutobrrFilterOption } from '@server/api/autobrr';
import {
  FreshMovieCriteriaSchema,
  FreshTvCriteriaSchema,
} from '@server/lib/discoverCriteria';
import {
  createFreshMediaState,
  type FreshDiagnosticsSnapshot,
  type FreshMediaResult,
  type FreshMediaState,
} from '@server/lib/fresh';
import {
  MAX_FRESH_WINDOW_DAYS,
  MIN_FRESH_WINDOW_DAYS,
} from '@server/lib/fresh/candidateQuery';
import type { FreshSettings } from '@server/lib/settings';

export const FRESH_CACHE_TTL_MS = 5 * 60 * 1000;
export const MIN_FRESH_ITEMS = 1;
export const MAX_FRESH_ITEMS = 100;

export interface PublicFreshSettings extends Omit<FreshSettings, 'apiToken'> {
  apiTokenConfigured: boolean;
}

type FreshState = Pick<
  FreshMediaState,
  'orderedResults' | 'refresh' | 'status'
> & { readonly diagnostics?: FreshDiagnosticsSnapshot };

export interface FreshServiceDependencies {
  now: () => number;
  createState: (settings: FreshSettings) => FreshState;
  createAutobrr: (
    baseUrl: string,
    apiToken: string
  ) => Pick<Autobrr, 'filters'>;
}

const positiveInteger = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

const normalizeBaseUrl = (value: string): string => {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    url.pathname =
      url.pathname.replace(/\/+$/, '').replace(/\/api$/i, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    throw new Error('Invalid Fresh connection configuration');
  }
};

const validateConnection = (baseUrl: string, apiToken: string) => {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (
    !normalizedBaseUrl ||
    !apiToken.trim() ||
    apiToken.length > 1024 ||
    /[\r\n]/.test(apiToken)
  ) {
    throw new Error('Fresh connection configuration is incomplete');
  }
  return { baseUrl: normalizedBaseUrl, apiToken: apiToken.trim() };
};

export const normalizeFreshSettings = (value: FreshSettings): FreshSettings => {
  if (
    typeof value.enabled !== 'boolean' ||
    typeof value.baseUrl !== 'string' ||
    typeof value.apiToken !== 'string' ||
    value.apiToken.length > 1024 ||
    /[\r\n]/.test(value.apiToken) ||
    !positiveInteger(
      value.filterId,
      value.enabled ? 1 : 0,
      Number.MAX_SAFE_INTEGER
    ) ||
    !positiveInteger(
      value.candidateWindowDays,
      MIN_FRESH_WINDOW_DAYS,
      MAX_FRESH_WINDOW_DAYS
    ) ||
    !positiveInteger(value.maximumItems, MIN_FRESH_ITEMS, MAX_FRESH_ITEMS)
  ) {
    throw new Error('Invalid Fresh settings');
  }

  const normalized: FreshSettings = {
    enabled: value.enabled,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    apiToken: value.apiToken.trim(),
    filterId: value.filterId,
    candidateWindowDays: value.candidateWindowDays,
    maximumItems: value.maximumItems,
    movieCriteria: FreshMovieCriteriaSchema.parse(value.movieCriteria),
    tvCriteria: FreshTvCriteriaSchema.parse(value.tvCriteria),
  };
  if (normalized.enabled) {
    validateConnection(normalized.baseUrl, normalized.apiToken);
  }
  return normalized;
};

export const publicFreshSettings = (
  settings: FreshSettings
): PublicFreshSettings => {
  const { apiToken, ...publicSettings } = settings;
  return {
    ...publicSettings,
    apiTokenConfigured: apiToken.trim().length > 0,
  };
};

export class FreshService {
  private settings?: FreshSettings;
  private state?: FreshState;

  constructor(
    private readonly dependencies: FreshServiceDependencies = {
      now: Date.now,
      createState: (settings) =>
        createFreshMediaState({
          ...settings,
          filter: { id: settings.filterId },
          refreshIntervalMs: FRESH_CACHE_TTL_MS,
        }),
      createAutobrr: (baseUrl, apiToken) => new Autobrr(baseUrl, apiToken),
    }
  ) {}

  configure(settings: FreshSettings): void {
    this.settings = normalizeFreshSettings(settings);
    this.state = this.settings.enabled
      ? this.dependencies.createState(this.settings)
      : undefined;
  }

  private configured(): FreshSettings {
    if (!this.settings) throw new Error('Fresh is not configured');
    return this.settings;
  }

  async results(): Promise<FreshMediaResult[]> {
    const settings = this.configured();
    if (!settings.enabled || !this.state) return [];

    const lastRefresh = this.state.status.lastRefresh;
    if (!lastRefresh) {
      await this.state.refresh();
    } else if (
      this.dependencies.now() - Date.parse(lastRefresh) >=
      FRESH_CACHE_TTL_MS
    ) {
      void this.state.refresh();
    }
    return this.state.orderedResults(settings.maximumItems);
  }

  async refresh(): Promise<FreshMediaResult[]> {
    const settings = this.configured();
    if (!settings.enabled || !this.state) return [];
    await this.state.refresh(true);
    return this.state.orderedResults(settings.maximumItems);
  }

  status() {
    const settings = this.configured();
    if (!settings.enabled || !this.state) {
      return {
        status: 'disabled' as const,
        refreshing: false,
        itemCount: 0,
      };
    }

    const status = this.state.status;
    const expired =
      !!status.lastRefresh &&
      this.dependencies.now() - Date.parse(status.lastRefresh) >=
        FRESH_CACHE_TTL_MS;
    return {
      ...status,
      status: expired && status.status === 'ready' ? 'stale' : status.status,
    };
  }

  diagnostics() {
    return {
      latestAttempt: this.state?.diagnostics ?? null,
      currentProjection: this.status(),
    };
  }

  async filters(settings = this.configured()): Promise<AutobrrFilterOption[]> {
    const connection = validateConnection(settings.baseUrl, settings.apiToken);
    return this.dependencies
      .createAutobrr(connection.baseUrl, connection.apiToken)
      .filters();
  }

  async test(settings = this.configured()): Promise<void> {
    await this.filters(settings);
  }
}

const freshService = new FreshService();
export default freshService;
