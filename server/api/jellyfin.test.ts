import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import availabilitySync from '@server/lib/availabilitySync';
import JellyfinAPI, {
  type JellyfinItemsReponse,
  type JellyfinLibraryItemExtended,
} from './jellyfin';

const item = (id: string, location: 'FileSystem' | 'Virtual') =>
  ({
    Id: id,
    Name: id,
    Type: 'Movie',
    LocationType: location,
    HasSubtitles: false,
    MediaType: 'Video',
    ProviderIds: { Tmdb: '1' },
  }) as JellyfinLibraryItemExtended;

describe('JellyfinAPI targeted item reads', () => {
  it('bounds every targeted HTTP read and aborts an in-flight read without provider traffic', async () => {
    const server = createServer(() => {
      /* Deliberately never respond. */
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const api = new JellyfinAPI(
        `http://127.0.0.1:${address.port}`,
        undefined,
        undefined,
        { timeoutMs: 50 }
      );
      for (const read of [
        () => api.getItemData('fixture'),
        () => api.getSeasons('fixture'),
        () => api.getEpisodes('fixture', 'season'),
        () =>
          api.searchItems({
            parentId: 'library',
            searchTerm: 'Synthetic',
            includeItemTypes: ['Movie'],
          }),
      ]) {
        const started = Date.now();
        await assert.rejects(read);
        assert.ok(Date.now() - started < 2000);
      }
      const controller = new AbortController();
      const cancellable = new JellyfinAPI(
        `http://127.0.0.1:${address.port}`,
        undefined,
        undefined,
        { timeoutMs: 5000, signal: controller.signal }
      );
      const reading = cancellable.getItemData('fixture');
      controller.abort();
      await assert.rejects(reading);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
  it('enumerates all pages with stable totals and filters virtual items only after completeness checks', async () => {
    const starts: number[] = [];
    let pageCount = 0;
    const api = new JellyfinAPI('http://jellyfin.test');
    Object.defineProperty(api, 'get', {
      value: async (
        _path: string,
        options: { params: { startIndex: number } }
      ) => {
        starts.push(options.params.startIndex);
        return options.params.startIndex === 0
          ? ({
              Items: [
                item('movie', 'FileSystem'),
                item('future-placeholder', 'Virtual'),
              ],
              TotalRecordCount: 3,
              StartIndex: 0,
            } satisfies JellyfinItemsReponse)
          : ({
              Items: [item('series', 'FileSystem')],
              TotalRecordCount: 3,
              StartIndex: 2,
            } satisfies JellyfinItemsReponse);
      },
    });

    const items = await api.getAllItems(
      {
        parentId: 'library',
        recursive: true,
        includeItemTypes: ['Movie', 'Series', 'Episode'],
      },
      2,
      () => pageCount++
    );

    assert.deepEqual(starts, [0, 2]);
    assert.equal(pageCount, 2);
    assert.deepEqual(
      items.map(({ Id }) => Id),
      ['movie', 'series']
    );
  });

  it('rejects changing totals so partial enumeration cannot look complete', async () => {
    const api = new JellyfinAPI('http://jellyfin.test');
    Object.defineProperty(api, 'get', {
      value: async (
        _path: string,
        options: { params: { startIndex: number } }
      ) => ({
        Items:
          options.params.startIndex === 0
            ? [item('one', 'FileSystem'), item('two', 'FileSystem')]
            : [item('three', 'FileSystem')],
        TotalRecordCount: options.params.startIndex === 0 ? 3 : 4,
        StartIndex: options.params.startIndex,
      }),
    });

    await assert.rejects(
      () =>
        api.getAllItems(
          {
            parentId: 'library',
            recursive: true,
            includeItemTypes: ['Movie'],
          },
          2
        ),
      /pagination changed/
    );
  });

  it('performs an exact bounded ID lookup with canonical fields', async () => {
    const calls: { path: string; options: { params: object } }[] = [];
    const api = new JellyfinAPI('http://jellyfin.test');
    Object.defineProperty(api, 'get', {
      value: async (path: string, options: { params: object }) => {
        calls.push({ path, options });
        return {
          Items: [item('exact', 'FileSystem')],
          TotalRecordCount: 1,
          StartIndex: 0,
        } satisfies JellyfinItemsReponse;
      },
    });

    assert.equal((await api.getItemData('exact'))?.Id, 'exact');
    assert.deepEqual(calls, [
      {
        path: '/Items',
        options: {
          params: {
            ids: 'exact',
            limit: 1,
            fields: 'ProviderIds,MediaSources,Width,Height,IsHD,DateCreated',
          },
        },
      },
    ]);
  });

  it('bounds recursive title search and excludes virtual results', async () => {
    let params: object | undefined;
    const api = new JellyfinAPI('http://jellyfin.test');
    Object.defineProperty(api, 'get', {
      value: async (_path: string, options: { params: object }) => {
        params = options.params;
        return {
          Items: [
            item('playable', 'FileSystem'),
            item('placeholder', 'Virtual'),
          ],
          TotalRecordCount: 2,
          StartIndex: 0,
        } satisfies JellyfinItemsReponse;
      },
    });

    const results = await api.searchItems({
      parentId: 'library',
      searchTerm: 'Canonical Title',
      includeItemTypes: ['Movie'],
    });

    assert.deepEqual(
      results.map((result) => result.Id),
      ['playable']
    );
    assert.deepEqual(params, {
      searchTerm: 'Canonical Title',
      parentId: 'library',
      recursive: true,
      includeItemTypes: 'Movie',
      limit: 25,
      fields: 'ProviderIds,MediaSources,Width,Height,IsHD,DateCreated',
    });
  });

  it('performs a bounded exact per-user lookup with UserData enabled', async () => {
    let params: object | undefined;
    let timeout: number | undefined;
    const api = new JellyfinAPI('http://jellyfin.test');
    Object.defineProperty(api, 'get', {
      value: async (
        _path: string,
        options: { params: object; timeout?: number }
      ) => {
        params = options.params;
        timeout = options.timeout;
        return {
          Items: [item('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'FileSystem')],
          TotalRecordCount: 1,
          StartIndex: 0,
        } satisfies JellyfinItemsReponse;
      },
    });

    await api.getUserItems({
      ids: [
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ],
      userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      fields: ['ProviderIds', 'RecursiveItemCount'],
    });

    assert.deepEqual(params, {
      ids: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      enableUserData: true,
      limit: 1,
      fields: 'ProviderIds,RecursiveItemCount',
    });
    assert.equal(timeout, 15_000);
  });

  it('rejects missing, malformed, and oversized exact item lookups', async () => {
    const api = new JellyfinAPI('http://jellyfin.test');
    await assert.rejects(() =>
      api.getUserItems({
        ids: [],
        userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      })
    );
    await assert.rejects(() =>
      api.getUserItems({
        ids: ['not-an-id'],
        userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      })
    );
    await assert.rejects(() =>
      api.getUserItems({
        ids: Array.from({ length: 101 }, (_, index) =>
          index.toString(16).padStart(32, '0')
        ),
        userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      })
    );
  });

  it('does not convert a completeness-sensitive user lookup failure into an empty result', async () => {
    const api = new JellyfinAPI('http://jellyfin.test');
    Object.defineProperty(api, 'get', {
      value: async () => {
        throw { message: 'provider failure', response: { status: 500 } };
      },
    });
    availabilitySync.running = true;
    try {
      await assert.rejects(() =>
        api.getUserItems({
          ids: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
          userId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        })
      );
    } finally {
      availabilitySync.running = false;
    }
  });
});
