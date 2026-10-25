import TheMovieDb from '@server/api/themoviedb';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

describe('Fresh V2 shared TMDB transport', () => {
  afterEach(() => mock.restoreAll());
  it('adds broader release-year searches without changing existing primary-year callers', async () => {
    const client = new TheMovieDb();
    const transport = client as unknown as {
      get: (
        path: string,
        options?: { params?: Record<string, unknown> }
      ) => Promise<unknown>;
    };
    const requests: { path: string; params?: Record<string, unknown> }[] = [];
    mock.method(
      transport,
      'get',
      async (path: string, options?: { params?: Record<string, unknown> }) => {
        requests.push({ path, params: options?.params });
        return { page: 1, total_pages: 0, total_results: 0, results: [] };
      }
    );
    await client.searchMoviesStrict({ query: 'Obsession', releaseYear: 2025 });
    await client.searchMoviesStrict({ query: 'Obsession', year: 2025 });
    assert.equal(requests[0].path, '/search/movie');
    assert.equal(requests[0].params?.year, 2025);
    assert.equal(requests[0].params?.primary_release_year, undefined);
    assert.equal(requests[1].params?.primary_release_year, 2025);
    assert.equal(requests[1].params?.year, undefined);
  });
  it('validates alias identity and preserves provider failures', async () => {
    const client = new TheMovieDb();
    const transport = client as unknown as { get: () => Promise<unknown> };
    const response = mock.method(transport, 'get', async () => ({
      id: 42,
      titles: [{ title: 'Verified Alias' }],
    }));
    assert.deepEqual(await client.getDiscoveryAliases('movie', 42), [
      'Verified Alias',
    ]);
    response.mock.mockImplementation(async () => ({
      id: 99,
      titles: [{ title: 'Wrong Identity' }],
    }));
    await assert.rejects(client.getDiscoveryAliases('movie', 42));
    response.mock.mockImplementation(async () => {
      throw new Error('fixture provider failure');
    });
    await assert.rejects(client.searchMoviesStrict({ query: 'Example' }));
  });
});
