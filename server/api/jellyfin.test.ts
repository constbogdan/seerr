import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

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
});
