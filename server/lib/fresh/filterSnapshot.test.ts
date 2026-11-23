import {
  FRESH_FILTER_MAX_ITEMS,
  FreshFilterSnapshots,
  selectFreshSnapshotRows,
} from '@server/lib/fresh/filterSnapshot';
import {
  freshPresentationKey,
  type FreshProviderPresentation,
  type resolveFreshPresentationOutcomes,
} from '@server/lib/fresh/presentation';
import { fixtureSettings } from '@server/test/freshFixtures';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Fresh bounded filter snapshots', () => {
  const outcome = (presentations: Map<string, FreshProviderPresentation>) => ({
    presentations,
    permanentlyUnavailable: new Set<string>(),
  });
  it('orders missing, non-finite, malformed and unrated metrics last using the same snapshot', async () => {
    for (const sort of ['vote_average', 'vote_count'] as const) {
      const values = [
        8,
        9,
        0,
        -1,
        undefined,
        NaN,
        Infinity,
        '10',
        sort === 'vote_average' ? 11 : 1.5,
      ];
      const rows = values.map((_, i) => ({
        mediaType: 'movie' as const,
        tmdbId: i + 1,
        discoveredAt: '2026-10-25T10:00:00Z',
      }));
      const snapshot = await new FreshFilterSnapshots().evaluate(
        rows,
        fixtureSettings,
        'en',
        async () =>
          outcome(
            new Map(
              rows.map((row) => [
                freshPresentationKey(row),
                {
                  id: row.tmdbId,
                  [sort]: values[row.tmdbId - 1],
                } as unknown as FreshProviderPresentation,
              ])
            )
          )
      );
      assert.deepEqual(
        selectFreshSnapshotRows(rows, snapshot, sort).map((row) => row.tmdbId),
        [2, 1, 3, 4, 5, 6, 7, 8, 9]
      );
      assert.deepEqual(
        rows.map((row) => row.tmdbId),
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
        'sorting must not mutate the source population'
      );
    }
  });
  const population = Array.from({ length: 45 }, (_, i) => ({
    mediaType: 'movie' as const,
    tmdbId: i + 1,
    discoveredAt: '2026-10-25',
  }));
  const settings = { ...fixtureSettings, minimumTmdbScore: 7 };
  const metadata: typeof resolveFreshPresentationOutcomes = async (rows) =>
    outcome(
      new Map(
        rows.map((row) => [
          freshPresentationKey(row),
          { id: row.tmdbId, vote_average: 7 } as FreshProviderPresentation,
        ])
      )
    );
  it('batches the complete population, coalesces requests and reuses page-independent metadata', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const present: typeof metadata = async (rows) => {
      calls++;
      assert.ok(rows.length <= 20);
      await gate;
      return metadata(rows, 'en');
    };
    const cache = new FreshFilterSnapshots();
    const first = cache.evaluate(population, settings, 'en', present);
    const joined = cache.evaluate(population, settings, 'en', present);
    await assert.rejects(
      cache.evaluate(
        population,
        { ...settings, minimumTmdbScore: 8 },
        'en',
        present
      ),
      /busy/
    );
    release();
    assert.equal(await joined, await first);
    assert.equal((await first).accepted.size, 45);
    assert.equal(calls, 3);
    assert.equal(
      await cache.evaluate(population, settings, 'en', present),
      await first
    );
    assert.equal(
      await cache.evaluate([...population].reverse(), settings, 'en', present),
      await first
    );
    assert.equal(calls, 3);
  });
  it('expires snapshots and keys by filters, locale, typed identity and discovery date', async () => {
    let now = 0;
    let calls = 0;
    const present: typeof metadata = async (rows) => {
      calls++;
      return metadata(rows, 'en');
    };
    const cache = new FreshFilterSnapshots(() => now);
    const rows = population.slice(0, 1);
    await cache.evaluate(rows, settings, 'en', present);
    await cache.evaluate(
      rows,
      { ...settings, minimumTmdbScore: 8 },
      'en',
      present
    );
    await cache.evaluate(rows, settings, 'fr', present);
    await cache.evaluate(
      [{ ...rows[0], mediaType: 'tv' }],
      settings,
      'en',
      present
    );
    await cache.evaluate(
      [{ ...rows[0], discoveredAt: '2026-10-24' }],
      settings,
      'en',
      present
    );
    assert.equal(calls, 5);
    now += 60_000;
    await cache.evaluate(rows, settings, 'en', present);
    assert.equal(calls, 6);
  });
  it('fails closed on incomplete or invalid metadata and never caches a partial result', async () => {
    const cache = new FreshFilterSnapshots();
    await assert.rejects(
      cache.evaluate(population, settings, 'en', async () =>
        outcome(new Map())
      ),
      /unavailable/
    );
    await assert.rejects(
      cache.evaluate(population, settings, 'en', async (rows) =>
        outcome(
          new Map([
            [
              freshPresentationKey(rows[0]),
              { id: 999 } as FreshProviderPresentation,
            ],
          ])
        )
      ),
      /unavailable/
    );
    assert.equal(
      (await cache.evaluate(population, settings, 'en', metadata)).accepted
        .size,
      45
    );
  });
  it('accepts only explicit permanent absences while preserving typed selection and zero totals', async () => {
    const rows = [
      {
        mediaType: 'movie' as const,
        tmdbId: 1828781,
        discoveredAt: '2026-10-25',
      },
      { mediaType: 'tv' as const, tmdbId: 1828781, discoveredAt: '2026-10-24' },
      { mediaType: 'movie' as const, tmdbId: 2, discoveredAt: '2026-10-23' },
    ];
    const cache = new FreshFilterSnapshots();
    const result = await cache.evaluate(rows, settings, 'en', async () => ({
      presentations: new Map([
        [
          'tv:1828781',
          { id: 1828781, vote_average: 8 } as FreshProviderPresentation,
        ],
      ]),
      permanentlyUnavailable: new Set(['movie:1828781', 'movie:2']),
    }));
    assert.deepEqual(
      selectFreshSnapshotRows(rows, result, 'freshest').map((row) => [
        row.mediaType,
        row.tmdbId,
      ]),
      [['tv', 1828781]]
    );
    const empty = await new FreshFilterSnapshots().evaluate(
      rows,
      settings,
      'en',
      async () => ({
        presentations: new Map(),
        permanentlyUnavailable: new Set(rows.map(freshPresentationKey)),
      })
    );
    assert.equal(selectFreshSnapshotRows(rows, empty, 'freshest').length, 0);
    await assert.rejects(
      new FreshFilterSnapshots().evaluate(rows, settings, 'en', async () => ({
        presentations: new Map([
          ['movie:1828781', { id: 1828781 } as FreshProviderPresentation],
        ]),
        permanentlyUnavailable: new Set(['movie:1828781']),
      })),
      /metadata_conflict/
    );
  });
  it('rejects oversized populations without calls and stops at the time budget without partial totals', async () => {
    let calls = 0;
    let now = 0;
    const cache = new FreshFilterSnapshots(() => now);
    const present: typeof metadata = async (rows) => {
      calls++;
      now += 120_000;
      return metadata(rows, 'en');
    };
    await assert.rejects(
      cache.evaluate(
        Array(FRESH_FILTER_MAX_ITEMS + 1).fill(population[0]),
        settings,
        'en',
        present
      ),
      /population_limit/
    );
    assert.equal(calls, 0);
    await assert.rejects(
      cache.evaluate(population, settings, 'en', present),
      /metadata_budget/
    );
    assert.equal(calls, 1);
  });
});
