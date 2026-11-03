import FreshWork from '@server/entity/FreshWork';
import { matchFreshIdentity } from '@server/lib/fresh/matching';
import {
  fixtureMovie,
  fixtureProvider,
  fixtureSearch,
  fixtureTv,
} from '@server/test/freshFixtures';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const work = (values: Partial<FreshWork> = {}) =>
  new FreshWork({
    title: 'Silent Friend',
    mediaType: 'movie',
    year: 2025,
    ...values,
  });
describe('Fresh V2 automatic identity selection', () => {
  it('uses broader year evidence and exact title ahead of ranking and primary release date', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async (options) => {
      assert.equal(options.releaseYear, 2025);
      assert.equal(options.year, undefined);
      return fixtureSearch([
        {
          ...fixtureMovie(1688981, 'Silent Friends', '2025-01-01'),
          vote_count: 99999,
        },
        fixtureMovie(1168719, 'Silent Friend', '2026-01-01'),
      ]);
    };
    assert.equal(
      (
        (await matchFreshIdentity(work(), [2025, 2026], provider)) as {
          id: number;
        }
      ).id,
      1168719
    );
  });
  it('accepts Obsession from a complete broader-year search despite a different primary year', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async () =>
      fixtureSearch([fixtureMovie(1339713, 'Obsession', '2026-05-13')]);
    assert.equal(
      (
        (await matchFreshIdentity(
          work({ title: 'Obsession' }),
          [],
          provider
        )) as { id: number }
      ).id,
      1339713
    );
  });
  it('never selects the highest-voted identity among conflicting exact titles', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async () =>
      fixtureSearch([
        fixtureMovie(1, 'Silent Friend'),
        { ...fixtureMovie(2, 'Silent Friend'), vote_count: 100000 },
      ]);
    assert.deepEqual(await matchFreshIdentity(work(), [], provider), {
      kind: 'ambiguous',
    });
  });
  it('accepts localized/original title agreement', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async () =>
      fixtureSearch([
        {
          ...fixtureMovie(3, 'Localized Title'),
          original_title: 'Silent Friend',
        },
      ]);
    assert.equal(
      ((await matchFreshIdentity(work(), [], provider)) as { id: number }).id,
      3
    );
  });
  it('accepts a complete singleton with a verified alias, not an unrelated singleton', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async () =>
      fixtureSearch([fixtureMovie(3, 'Alternate Title')]);
    assert.deepEqual(await matchFreshIdentity(work(), [], provider), {
      kind: 'no_match',
    });
    provider.getDiscoveryAliases = async () => ['Silent Friend'];
    assert.equal(
      ((await matchFreshIdentity(work(), [], provider)) as { id: number }).id,
      3
    );
  });
  it('uses dynamic configured alternate years only after no acceptable primary result', async () => {
    const provider = fixtureProvider();
    const years: (number | undefined)[] = [];
    provider.searchMoviesStrict = async ({ releaseYear }) => {
      years.push(releaseYear);
      return fixtureSearch(
        releaseYear === 2033
          ? [fixtureMovie(4, 'Silent Friend', '2032-01-01')]
          : []
      );
    };
    assert.equal(
      (
        (await matchFreshIdentity(
          work({ year: 2032 }),
          [2032, 2033],
          provider
        )) as { id: number }
      ).id,
      4
    );
    assert.deepEqual(years, [2032, 2033]);
  });
  it('does not use alternate years to bypass an ambiguous primary search', async () => {
    const provider = fixtureProvider();
    let calls = 0;
    provider.searchMoviesStrict = async () => {
      calls++;
      return fixtureSearch([
        fixtureMovie(1, 'Silent Friend'),
        fixtureMovie(2, 'Silent Friend'),
      ]);
    };
    assert.deepEqual(await matchFreshIdentity(work(), [2025, 2026], provider), {
      kind: 'ambiguous',
    });
    assert.equal(calls, 1);
  });
  it('supports a missing parsed Movie year without admitting foreign namespaces', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async ({ releaseYear }) => {
      assert.equal(releaseYear, undefined);
      return fixtureSearch([fixtureMovie(1, 'Silent Friend')]);
    };
    assert.equal(
      (
        (await matchFreshIdentity(work({ year: 0 }), [], provider)) as {
          id: number;
        }
      ).id,
      1
    );
    provider.searchMoviesStrict = async () =>
      fixtureSearch([
        { ...fixtureMovie(1, 'Silent Friend'), media_type: 'tv' } as never,
      ]);
    await assert.rejects(matchFreshIdentity(work(), [], provider));
  });
  it('distinguishes truncated search from genuine no-match', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async () => ({
      page: 1,
      total_pages: 4,
      total_results: 80,
      results: [fixtureMovie(1, 'Silent Friend')],
    });
    assert.deepEqual(await matchFreshIdentity(work(), [], provider), {
      kind: 'incomplete',
    });
    provider.searchMoviesStrict = async () => fixtureSearch([]);
    assert.deepEqual(await matchFreshIdentity(work(), [], provider), {
      kind: 'no_match',
    });
  });
  it('rejects malformed totals and propagates provider errors rather than recording no-match', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async () => ({
      page: 1,
      total_pages: 1,
      total_results: 2,
      results: [fixtureMovie(1, 'Silent Friend')],
    });
    await assert.rejects(matchFreshIdentity(work(), [], provider));
    provider.searchMoviesStrict = async () => {
      throw new Error('fixture outage');
    };
    await assert.rejects(matchFreshIdentity(work(), [], provider));
  });
  it('searches Series without first-air year or any Season lookup', async () => {
    const provider = fixtureProvider();
    provider.searchTvShowsStrict = async (options) => {
      assert.equal(options.year, undefined);
      return fixtureSearch([fixtureTv(201, 'Anime Name')]);
    };
    assert.equal(
      (
        (await matchFreshIdentity(
          work({ mediaType: 'tv', title: 'Anime Name', season: 2026 }),
          [],
          provider
        )) as { id: number }
      ).id,
      201
    );
  });
  it('uses explicitly typed TMDB identity without a search and verifies returned detail ID', async () => {
    const provider = fixtureProvider();
    provider.searchMoviesStrict = async () => {
      throw new Error('must not search');
    };
    assert.equal(
      (
        (await matchFreshIdentity(
          work({ externalTmdbId: 4 }),
          [],
          provider
        )) as { id: number }
      ).id,
      4
    );
    provider.getMovie = async () =>
      ({ id: 99, title: 'Wrong Identity' }) as never;
    await assert.rejects(
      matchFreshIdentity(work({ externalTmdbId: 4 }), [], provider)
    );
  });
  it('reuses TVDB lookup within the Series namespace', async () => {
    const provider = fixtureProvider();
    provider.getByExternalId = async (options) => {
      assert.deepEqual(options, { externalId: 123, type: 'tvdb' });
      return {
        movie_results: [fixtureMovie(99, 'Wrong Type')],
        tv_results: [fixtureTv(201, 'Anime Name')],
        person_results: [],
        tv_episode_results: [],
        tv_season_results: [],
      };
    };
    assert.equal(
      (
        (await matchFreshIdentity(
          work({ mediaType: 'tv', externalTvdbId: 123 }),
          [],
          provider
        )) as { id: number }
      ).id,
      201
    );
  });
});
