import FreshWork from '@server/entity/FreshWork';
import { matchFreshIdentity } from '@server/lib/fresh/matching';
import {
  fixtureMovie,
  fixtureProvider,
  fixtureSearch,
  fixtureTv,
} from '@server/test/freshFixtures';
import coverage from '@server/test/freshMatchingCoverage.json';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Public title/identity/date evidence captured during the read-only comparison.
// Irrelevant search noise is omitted; truncated searches remain incomplete.
const truncated = <T>(results: T[]) => ({
  page: 1,
  total_pages: 4,
  total_results: 61,
  results,
});
const seriesWork = (title: string, year = 2026) =>
  new FreshWork({ mediaType: 'tv', title, year, season: 1 });

describe('Fresh V2 captured matching coverage', () => {
  for (const sample of coverage.series) {
    it(`recovers Series ${sample.expectedId}: ${sample.query}`, async () => {
      const provider = fixtureProvider();
      const calls: (number | undefined)[] = [];
      provider.searchTvShowsStrict = async ({ query, year, page = 1 }) => {
        assert.equal(query, sample.query);
        calls.push(year);
        const values = (year ? sample.narrow : sample.broad).map((row) => ({
          ...fixtureTv(row.id, row.title),
          original_name: row.originalTitle,
          first_air_date: row.date,
        }));
        return !year && sample.truncated
          ? truncated(values)
          : {
              page,
              total_pages: Math.ceil(values.length / 20),
              total_results: values.length,
              results: values.slice((page - 1) * 20, page * 20),
            };
      };
      provider.searchMoviesStrict = async () => {
        throw new Error('Series must not search Movies');
      };
      const result = await matchFreshIdentity(
        seriesWork(sample.query, sample.year),
        [2025, 2026],
        provider
      );
      assert.equal(result.kind, 'resolved');
      if (result.kind === 'resolved')
        assert.equal(result.id, sample.expectedId);
      assert.deepEqual(calls, [
        undefined,
        ...Array.from(
          { length: Math.ceil(sample.narrow.length / 20) },
          () => sample.year
        ),
      ]);
    });
  }

  for (const sample of coverage.movies) {
    it(`reviews Movie ${sample.previousId}: ${sample.query}`, async () => {
      const provider = fixtureProvider();
      provider.searchMoviesStrict = async ({ query, year, releaseYear }) => {
        assert.equal(query, sample.query);
        assert.equal(year ?? releaseYear, sample.year);
        const values = (year ? sample.narrow : sample.broad).map((row) => ({
          ...fixtureMovie(row.id, row.title, row.releaseDate),
          original_title: row.originalTitle,
        }));
        return !year && sample.truncated
          ? truncated(values)
          : fixtureSearch(values);
      };
      const result = await matchFreshIdentity(
        new FreshWork({
          title: sample.query,
          year: sample.year,
          mediaType: 'movie',
        }),
        [2025, 2026],
        provider
      );
      assert.equal(result.kind, sample.expectedKind);
      if (result.kind === 'resolved')
        assert.equal(result.id, sample.expectedId);
    });
  }
});

describe('Fresh matching fallback safety', () => {
  it('does not use a calendar-year Season to select an unrelated reboot or premiere', async () => {
    for (const year of [2025, 2026]) {
      const provider = fixtureProvider();
      const calls: (number | undefined)[] = [];
      provider.searchTvShowsStrict = async ({ year: requestedYear }) => {
        calls.push(requestedYear);
        return requestedYear
          ? fixtureSearch([
              {
                ...fixtureTv(256317, 'Countdown'),
                first_air_date: year + '-01-01',
              },
            ])
          : truncated([fixtureTv(1480, 'Countdown')]);
      };
      assert.deepEqual(
        await matchFreshIdentity(
          new FreshWork({
            mediaType: 'tv',
            title: 'Countdown',
            year,
            season: year,
          }),
          [2025, 2026],
          provider
        ),
        { kind: 'incomplete' }
      );
      assert.deepEqual(calls, [undefined]);
    }
  });

  it('deduplicates consistent repeated search hits without inventing ambiguity or ignoring missing rows', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async () =>
      fixtureSearch([
        fixtureMovie(1, 'Same', '2026-01-01'),
        fixtureMovie(1, 'Same', '2026-01-01'),
      ]);
    const input = new FreshWork({
      mediaType: 'movie',
      title: 'Same',
      year: 2026,
    });
    const result = await matchFreshIdentity(input, [], provider);
    assert.equal(result.kind, 'resolved');
    if (result.kind === 'resolved') assert.equal(result.id, 1);
    provider.searchMoviesStrict = async () => ({
      ...fixtureSearch([fixtureMovie(1, 'Same', '2026-01-01')]),
      total_results: 2,
    });
    await assert.rejects(
      matchFreshIdentity(input, [], provider),
      /invalid_search/
    );
    for (const other of [
      fixtureMovie(1, 'Other', '2026-01-01'),
      fixtureMovie(1, 'Same', '2025-01-01'),
    ]) {
      provider.searchMoviesStrict = async () =>
        fixtureSearch([fixtureMovie(1, 'Same', '2026-01-01'), other]);
      await assert.rejects(
        matchFreshIdentity(input, [], provider),
        /invalid_search/
      );
    }
  });

  it('does not treat a new Season year as the premiere year of a uniquely identified Series', async () => {
    const provider = fixtureProvider();
    const calls: (number | undefined)[] = [];
    provider.searchTvShowsStrict = async ({ year }) => {
      calls.push(year);
      return fixtureSearch([fixtureTv(1667, 'Saturday Night Live')]);
    };
    const result = await matchFreshIdentity(
      new FreshWork({ ...seriesWork('Saturday Night Live'), season: 2026 }),
      [],
      provider
    );
    assert.equal(result.kind, 'resolved');
    assert.deepEqual(calls, [undefined]);
  });

  it('keeps ambiguity when the narrowed response is conflicting, unrelated, wrong-year or incomplete', async () => {
    for (const response of [
      fixtureSearch([
        { ...fixtureTv(1, 'Same'), first_air_date: '2026-01-01' },
        { ...fixtureTv(2, 'Same'), first_air_date: '2026-02-01' },
      ]),
      fixtureSearch([
        { ...fixtureTv(1, 'Unrelated'), first_air_date: '2026-01-01' },
      ]),
      fixtureSearch([fixtureTv(1, 'Same')]),
      truncated([{ ...fixtureTv(1, 'Same'), first_air_date: '2026-01-01' }]),
      fixtureSearch([
        { ...fixtureTv(99, 'Same'), first_air_date: '2026-01-01' },
      ]),
    ]) {
      const provider = fixtureProvider();
      provider.searchTvShowsStrict = async ({ year }) =>
        year
          ? response
          : fixtureSearch([fixtureTv(1, 'Same'), fixtureTv(2, 'Same')]);
      assert.deepEqual(
        await matchFreshIdentity(seriesWork('Same'), [], provider),
        { kind: 'ambiguous' }
      );
    }
  });

  it('preserves an incomplete outcome when narrowing cannot establish identity', async () => {
    const provider = fixtureProvider();
    provider.searchTvShowsStrict = async ({ year }) =>
      year ? fixtureSearch([]) : truncated([fixtureTv(1, 'Same')]);
    assert.deepEqual(
      await matchFreshIdentity(seriesWork('Same'), [], provider),
      { kind: 'incomplete' }
    );
  });

  it('propagates narrowed provider failures and checks the deadline before fallback', async () => {
    const provider = fixtureProvider();
    let allowed = true;
    let calls = 0;
    provider.searchTvShowsStrict = async ({ year }) => {
      calls++;
      if (year) throw new Error('fixture unavailable');
      return fixtureSearch([fixtureTv(1, 'Same'), fixtureTv(2, 'Same')]);
    };
    await assert.rejects(
      matchFreshIdentity(seriesWork('Same'), [], provider),
      /fixture unavailable/
    );
    calls = 0;
    provider.searchTvShowsStrict = async () => {
      calls++;
      allowed = false;
      return fixtureSearch([fixtureTv(1, 'Same'), fixtureTv(2, 'Same')]);
    };
    await assert.rejects(
      matchFreshIdentity(seriesWork('Same'), [], provider, () => allowed),
      /metadata_budget/
    );
    assert.equal(calls, 1);
  });

  it('restores only a trailing positive numeric Volume suffix after no-match', async () => {
    for (const suffix of ['Volume 4', 'volume 4', 'VOLUME 64']) {
      const provider = fixtureProvider();
      const queries: string[] = [];
      provider.searchTvShowsStrict = async ({ query }) => {
        queries.push(query);
        return fixtureSearch(
          query === 'Chopped' ? [fixtureTv(17404, query)] : []
        );
      };
      const result = await matchFreshIdentity(
        seriesWork('Chopped ' + suffix),
        [],
        provider
      );
      assert.equal(result.kind, 'resolved');
      if (result.kind === 'resolved') assert.equal(result.id, 17404);
      assert.deepEqual(queries, ['Chopped ' + suffix, 'Chopped']);
    }
  });

  it('does not strip arbitrary suffixes, Movie titles or an already matched Series title', async () => {
    for (const title of [
      'Chopped Vol 4',
      'Chopped Volume IV',
      'Chopped Volume 0',
      'Chopped Volume 4 Finale',
      'Volume 4',
    ]) {
      const provider = fixtureProvider();
      const queries: string[] = [];
      provider.searchTvShowsStrict = async ({ query }) => {
        queries.push(query);
        return fixtureSearch([]);
      };
      assert.deepEqual(
        await matchFreshIdentity(seriesWork(title), [], provider),
        { kind: 'no_match' }
      );
      assert.deepEqual(queries, [title]);
    }
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async ({ query }) => {
      assert.equal(query, 'Movie Volume 4');
      return fixtureSearch([]);
    };
    assert.deepEqual(
      await matchFreshIdentity(
        new FreshWork({
          mediaType: 'movie',
          title: 'Movie Volume 4',
          year: 2026,
        }),
        [],
        provider
      ),
      { kind: 'no_match' }
    );
    const result = await matchFreshIdentity(
      seriesWork('Chopped Volume 4'),
      [],
      provider
    );
    assert.equal(result.kind, 'resolved');
  });

  it('keeps same-year and unknown-year Movie conflicts fail-closed', async () => {
    for (const date of ['2026-02-01', '', 'invalid']) {
      const provider = fixtureProvider();
      provider.searchMoviesStrict = async ({ year }) =>
        year
          ? fixtureSearch([fixtureMovie(1, 'Same', '2026-01-01')])
          : fixtureSearch([
              fixtureMovie(1, 'Same', '2026-01-01'),
              fixtureMovie(2, 'Same', date),
            ]);
      assert.deepEqual(
        await matchFreshIdentity(
          new FreshWork({ title: 'Same', year: 2026, mediaType: 'movie' }),
          [2025, 2026],
          provider
        ),
        { kind: 'ambiguous' }
      );
    }
  });
});
