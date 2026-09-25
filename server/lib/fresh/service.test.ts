import type { AutobrrFilterOption } from '@server/api/autobrr';
import type { FreshMediaResult } from '@server/lib/fresh';
import {
  FRESH_CACHE_TTL_MS,
  FreshService,
  normalizeFreshSettings,
  publicFreshSettings,
  type FreshServiceDependencies,
} from '@server/lib/fresh/service';
import type { FreshSettings } from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const settings: FreshSettings = {
  enabled: true,
  baseUrl: 'https://autobrr.test/api/',
  apiToken: 'fixture-token',
  filterId: 7,
  candidateWindowDays: 90,
  maximumItems: 20,
  movieCriteria: { genre: '18' },
  tvCriteria: { network: '42' },
};

const result = {
  mediaType: 'movie',
  tmdbId: 1,
  firstSeenAt: '2026-09-01T00:00:00.000Z',
  result: { id: 1 },
} as FreshMediaResult;

function fixture() {
  let now = Date.parse('2026-09-25T10:00:00.000Z');
  let lastRefresh: string | undefined;
  let pending: Promise<void> | undefined;
  let resolvePending: (() => void) | undefined;
  const forceValues: boolean[] = [];
  let stateCreations = 0;
  let filterCalls = 0;
  const filters: AutobrrFilterOption[] = [
    { id: 7, name: 'Fresh Movies & TV', enabled: true },
  ];
  const deps: FreshServiceDependencies = {
    now: () => now,
    createState: () => {
      stateCreations++;
      return {
        refresh: (force = false) => {
          forceValues.push(force);
          if (!pending) {
            pending = new Promise<void>((resolve) => {
              resolvePending = () => {
                lastRefresh = new Date(now).toISOString();
                pending = undefined;
                resolve();
              };
            });
          }
          return pending;
        },
        orderedResults: () => [result],
        get status() {
          return {
            status: lastRefresh ? ('ready' as const) : ('idle' as const),
            refreshing: !!pending,
            lastRefresh,
            lastAttempt: undefined,
            itemCount: lastRefresh ? 1 : 0,
            error: undefined,
          };
        },
      };
    },
    createAutobrr: () => ({
      filters: async () => {
        filterCalls++;
        return filters;
      },
    }),
  };
  return {
    deps,
    forceValues,
    filters,
    advance: (milliseconds: number) => (now += milliseconds),
    complete: () => resolvePending?.(),
    stateCreations: () => stateCreations,
    filterCalls: () => filterCalls,
  };
}

describe('Fresh application service', () => {
  it('normalizes settings and never exposes the API token', () => {
    const normalized = normalizeFreshSettings(settings);
    assert.equal(normalized.baseUrl, 'https://autobrr.test');
    assert.deepEqual(publicFreshSettings(normalized), {
      enabled: true,
      baseUrl: 'https://autobrr.test',
      filterId: 7,
      candidateWindowDays: 90,
      maximumItems: 20,
      movieCriteria: { genre: '18' },
      tvCriteria: { network: '42' },
      apiTokenConfigured: true,
    });
    assert.doesNotMatch(
      JSON.stringify(publicFreshSettings(normalized)),
      /fixture/
    );
    assert.throws(() =>
      normalizeFreshSettings({ ...settings, apiToken: 'bad\nheader' })
    );
    assert.throws(() =>
      normalizeFreshSettings({
        ...settings,
        movieCriteria: { primaryReleaseDateGte: '2026-01-01' } as never,
      })
    );
  });

  it('does no source work when disabled', async () => {
    const f = fixture();
    const service = new FreshService(f.deps);
    service.configure({
      ...settings,
      enabled: false,
      baseUrl: '',
      apiToken: '',
      filterId: 0,
    });
    assert.deepEqual(await service.results(), []);
    assert.deepEqual(await service.refresh(), []);
    assert.equal(f.stateCreations(), 0);
    assert.equal(f.filterCalls(), 0);
    assert.equal(service.status().status, 'disabled');
  });

  it('refreshes lazily, serves TTL hits, and refreshes stale data in the background', async () => {
    const f = fixture();
    const service = new FreshService(f.deps);
    service.configure(settings);
    assert.equal(f.forceValues.length, 0);

    const initial = service.results();
    assert.deepEqual(f.forceValues, [false]);
    f.complete();
    assert.equal((await initial)[0].tmdbId, 1);

    await service.results();
    assert.deepEqual(f.forceValues, [false]);
    f.advance(FRESH_CACHE_TTL_MS);
    assert.equal((await service.results())[0].tmdbId, 1);
    assert.deepEqual(f.forceValues, [false, false]);
    assert.equal(service.status().status, 'stale');
    assert.equal(service.status().refreshing, true);
    f.complete();
  });

  it('shares concurrent initial work and manual refresh forces and awaits it', async () => {
    const f = fixture();
    const service = new FreshService(f.deps);
    service.configure(settings);
    const first = service.results();
    const second = service.results();
    assert.equal(f.forceValues.length, 2);
    f.complete();
    await Promise.all([first, second]);

    const manual = service.refresh();
    assert.equal(f.forceValues.at(-1), true);
    let complete = false;
    void manual.then(() => (complete = true));
    await Promise.resolve();
    assert.equal(complete, false);
    f.complete();
    await manual;
    assert.equal(complete, true);
  });

  it('returns sanitized browser-safe filter options', async () => {
    const f = fixture();
    const service = new FreshService(f.deps);
    service.configure(settings);
    assert.deepEqual(await service.filters(), f.filters);
    assert.equal(f.filterCalls(), 1);
  });
});
