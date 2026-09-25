import ExternalAPI from '@server/api/externalapi';

export type FreshMediaType = 'movie' | 'tv';
export interface AutobrrFilter {
  id: number;
}

export interface AutobrrFilterOption extends AutobrrFilter {
  name: string;
  enabled?: boolean;
}

// Deliberately no URLs, raw names, action diagnostics, or transport objects.
export interface FreshRelease {
  mediaType: FreshMediaType;
  title: string;
  year: number;
  observedAt: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const safeTitle = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 300 &&
  !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
  !/:\/\/|passkey\s*=|apikey\s*=|api_key\s*=/i.test(value);

export interface FreshReleasePage {
  releases: FreshRelease[];
  nextCursor: number;
  filterObserved: boolean;
  counts: {
    inspected: number;
    selectedFilter: number;
    eligibleMovies: number;
    eligibleTv: number;
  };
}

export function parseFilters(data: unknown): AutobrrFilterOption[] {
  if (!Array.isArray(data) || data.length > 10000) {
    throw new Error('Invalid autobrr filter response');
  }

  const ids = new Set<number>();
  return data.map((value) => {
    if (
      !record(value) ||
      !Number.isSafeInteger(value.id) ||
      Number(value.id) <= 0 ||
      ids.has(Number(value.id)) ||
      !safeTitle(value.name) ||
      value.name.length > 200 ||
      (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    ) {
      throw new Error('Invalid autobrr filter response');
    }
    const id = Number(value.id);
    ids.add(id);
    return {
      id,
      name: value.name.trim(),
      ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    };
  });
}

export function parseReleasePage(
  data: unknown,
  filter: AutobrrFilter,
  cursor = 0
): FreshReleasePage {
  if (
    !record(data) ||
    !Array.isArray(data.data) ||
    !Number.isSafeInteger(data.next_cursor) ||
    Number(data.next_cursor) < 0
  ) {
    throw new Error('Invalid autobrr release page');
  }
  let previous = cursor || Number.MAX_SAFE_INTEGER;
  const releases: FreshRelease[] = [];
  let filterObserved = false;
  const counts = {
    inspected: 0,
    selectedFilter: 0,
    eligibleMovies: 0,
    eligibleTv: 0,
  };
  for (const row of data.data) {
    // IDs are needed only to verify traversal; never retain the upstream row.
    if (
      !record(row) ||
      !Number.isSafeInteger(row.id) ||
      Number(row.id) <= 0 ||
      Number(row.id) >= previous
    ) {
      throw new Error('Invalid autobrr release ordering');
    }
    counts.inspected++;
    previous = Number(row.id);
    const selected =
      Array.isArray(row.action_status) &&
      row.action_status.some(
        (action: unknown) => record(action) && action.filter_id === filter.id
      );
    filterObserved ||= selected;
    if (selected) counts.selectedFilter++;
    const mediaType =
      row.type === 9
        ? 'movie'
        : row.type === 6 || row.type === 11
          ? 'tv'
          : undefined;
    const observedAt =
      typeof row.timestamp === 'string' &&
      /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.timestamp)
        ? Date.parse(row.timestamp)
        : NaN;
    if (
      !selected ||
      row.filter_status !== 'FILTER_APPROVED' ||
      !mediaType ||
      !safeTitle(row.title) ||
      !Number.isFinite(observedAt)
    )
      continue;
    const year =
      Number.isInteger(row.year) &&
      Number(row.year) >= 1800 &&
      Number(row.year) <= 9999
        ? Number(row.year)
        : 0;
    if (mediaType === 'movie' && !year) continue;
    releases.push({ mediaType, title: row.title.trim(), year, observedAt });
    if (mediaType === 'movie') counts.eligibleMovies++;
    else counts.eligibleTv++;
  }
  const nextCursor = Number(data.next_cursor);
  if (nextCursor !== (data.data.length ? previous : 0)) {
    throw new Error('Invalid autobrr release cursor');
  }
  return { releases, nextCursor, filterObserved, counts };
}

export default class Autobrr extends ExternalAPI {
  constructor(baseUrl: string, token: string) {
    let url: URL;
    try {
      url = new URL(baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !token.trim() ||
        /[\r\n]/.test(token)
      )
        throw new Error();
    } catch {
      throw new Error('Invalid Fresh connection configuration');
    }
    super(
      `${url.toString().replace(/\/$/, '')}/api/`,
      {},
      {
        headers: { 'X-API-Token': token },
        timeout: 15000,
      }
    );
  }

  async page(filter: AutobrrFilter, cursor = 0): Promise<FreshReleasePage> {
    try {
      // No shared cache. No filter-name prefix query: later action filter IDs
      // can differ from the top-level filter recorded when the row was stored.
      const response = await this.axios.get<unknown>('release', {
        params: { limit: 100, ...(cursor ? { cursor } : {}) },
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
      });
      return parseReleasePage(response.data, filter, cursor);
    } catch {
      // Axios errors carry credentials and response bodies. Never attach cause.
      throw new Error('Fresh release source unavailable or invalid');
    }
  }

  async filters(): Promise<AutobrrFilterOption[]> {
    try {
      const response = await this.axios.get<unknown>('filters', {
        maxRedirects: 0,
        maxContentLength: 2 * 1024 * 1024,
      });
      return parseFilters(response.data);
    } catch {
      throw new Error('Fresh filter source unavailable or invalid');
    }
  }
}
