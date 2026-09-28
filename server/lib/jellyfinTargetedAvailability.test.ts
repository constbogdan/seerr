import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnidbItem } from '@server/api/animelist';
import type JellyfinAPI from '@server/api/jellyfin';
import type {
  JellyfinLibraryItem,
  JellyfinLibraryItemExtended,
} from '@server/api/jellyfin';
import { MediaType } from '@server/constants/media';
import type { JellyfinScannerContext } from '@server/lib/scanners/jellyfin';
import {
  JellyfinTargetedAvailability,
  type JellyfinTargetedMediaTarget,
} from './jellyfinTargetedAvailability';

const videoSource = (width: number) => [
  {
    Protocol: 'File',
    Id: 'source',
    Path: '/redacted',
    Type: 'Default',
    VideoType: 'VideoFile',
    MediaStreams: [
      {
        Codec: 'h264',
        Type: 'Video' as const,
        Width: width,
        DisplayTitle: 'Video',
      },
    ],
  },
];

const item = ({
  id,
  type = 'Movie',
  tmdbId = 101,
  includeTmdb = true,
  tvdbId,
  imdbId,
  anidbId,
  width = 1920,
  index,
  indexEnd,
}: {
  id: string;
  type?: JellyfinLibraryItem['Type'];
  tmdbId?: number;
  includeTmdb?: boolean;
  tvdbId?: number;
  imdbId?: string;
  anidbId?: number;
  width?: number;
  index?: number;
  indexEnd?: number;
}): JellyfinLibraryItemExtended => ({
  Id: id,
  Name: id,
  Type: type,
  LocationType: 'FileSystem',
  HasSubtitles: false,
  MediaType: 'Video',
  ProviderIds: {
    ...(includeTmdb && { Tmdb: String(tmdbId) }),
    ...(tvdbId && { Tvdb: String(tvdbId) }),
    ...(imdbId && { Imdb: imdbId }),
    ...(anidbId && { AniDB: String(anidbId) }),
  },
  MediaSources: videoSource(width),
  IndexNumber: index,
  IndexNumberEnd: indexEnd,
});

const movieTarget = (
  overrides: Partial<JellyfinTargetedMediaTarget> = {}
): JellyfinTargetedMediaTarget => ({
  mediaId: 1,
  mediaType: MediaType.MOVIE,
  is4k: false,
  tmdbId: 101,
  jellyfinMediaId: 'known-movie',
  episodes: [],
  ...overrides,
});

const buildService = ({
  exact,
  search = [],
  seasons = [],
  episodes = [],
  satisfied = true,
  separate4kEnabled = false,
  animeIdentity,
}: {
  exact?: JellyfinLibraryItemExtended;
  search?: JellyfinLibraryItemExtended[];
  seasons?: JellyfinLibraryItem[];
  episodes?: JellyfinLibraryItemExtended[];
  satisfied?: boolean;
  separate4kEnabled?: boolean;
  animeIdentity?: AnidbItem;
}) => {
  const calls = {
    mappings: 0,
    exact: 0,
    search: 0,
    seasons: 0,
    episodes: 0,
    processed: [] as string[],
  };
  const client = {
    getItemData: async () => {
      calls.exact += 1;
      return exact;
    },
    searchItems: async () => {
      calls.search += 1;
      return search;
    },
    getSeasons: async () => {
      calls.seasons += 1;
      return seasons;
    },
    getEpisodes: async () => {
      calls.episodes += 1;
      return episodes;
    },
  } as unknown as JellyfinAPI;
  const context: JellyfinScannerContext = {
    client,
    libraries: [
      { id: 'movies', name: 'Movies', type: 'movie', enabled: true },
      { id: 'shows', name: 'Shows', type: 'show', enabled: true },
    ],
  };
  const service = new JellyfinTargetedAvailability({
    prepareIdentityMappings: async () => {
      calls.mappings += 1;
    },
    getAnimeIdentity: () => animeIdentity,
    isSeparate4kEnabled: () => separate4kEnabled,
    createContext: async () => context,
    getMovieTitles: async () => ({ titles: ['Canonical Movie'] }),
    getTvTitles: async () => ({
      titles: ['Canonical Show'],
      tvdbId: 202,
    }),
    processItems: async (items) => {
      calls.processed.push(...items.map((candidate) => candidate.Id));
      return { status: 'completed', durationMs: 4 };
    },
    isSatisfied: async () => satisfied,
    now: () => 1_000,
  });
  return { service, calls };
};

describe('JellyfinTargetedAvailability', () => {
  it('uses a trusted stored ID first and canonically processes a playable movie', async () => {
    const { service, calls } = buildService({
      exact: item({ id: 'known-movie' }),
    });

    const result = await service.reconcile(movieTarget());

    assert.equal(result.state, 'ready');
    assert.equal(result.lookupMethod, 'exact-id');
    assert.equal(result.jellyfinRequestCount, 1);
    assert.deepEqual(calls, {
      mappings: 0,
      exact: 1,
      search: 0,
      seasons: 0,
      episodes: 0,
      processed: ['known-movie'],
    });
  });

  it('rejects stale identity and accepts only exact-provider fallback results', async () => {
    const { service, calls } = buildService({
      exact: item({ id: 'stale', tmdbId: 999 }),
      search: [
        item({ id: 'wrong', tmdbId: 999 }),
        item({ id: 'canonical', tmdbId: 101 }),
      ],
    });

    const result = await service.reconcile(movieTarget());

    assert.equal(result.state, 'ready');
    assert.equal(result.lookupMethod, 'bounded-search');
    assert.equal(result.jellyfinRequestCount, 3);
    assert.ok(calls.search > 0);
    assert.deepEqual(calls.processed, ['canonical']);
  });

  it('fails closed when a matching movie is not playable at the required quality', async () => {
    const { service, calls } = buildService({
      exact: item({ id: 'known-movie', width: 1920 }),
      search: [item({ id: 'also-hd', width: 1920 })],
    });

    const result = await service.reconcile(movieTarget({ is4k: true }));

    assert.equal(result.state, 'not_ready');
    if (result.state === 'not_ready')
      assert.equal(result.reason, 'not_playable');
    assert.deepEqual(calls.processed, []);
  });

  it('does not grant title-only authority when provider identity is missing', async () => {
    const { service, calls } = buildService({
      search: [item({ id: 'title-only', includeTmdb: false })],
    });

    const result = await service.reconcile(
      movieTarget({ jellyfinMediaId: undefined })
    );

    assert.equal(result.state, 'not_ready');
    if (result.state === 'not_ready') {
      assert.equal(result.reason, 'identity_missing');
    }
    assert.deepEqual(calls.processed, []);
  });

  it('reports no bounded candidates as not ready without processing unrelated media', async () => {
    const { service, calls } = buildService({});

    const result = await service.reconcile(
      movieTarget({ jellyfinMediaId: undefined })
    );

    assert.equal(result.state, 'not_ready');
    if (result.state === 'not_ready')
      assert.equal(result.reason, 'item_absent');
    assert.equal(result.jellyfinRequestCount, 2);
    assert.deepEqual(calls.processed, []);
  });

  it('rejects multiple title candidates when none has exact canonical identity', async () => {
    const { service, calls } = buildService({
      search: [
        item({ id: 'wrong-a', tmdbId: 501 }),
        item({ id: 'wrong-b', tmdbId: 502 }),
      ],
    });

    const result = await service.reconcile(
      movieTarget({ jellyfinMediaId: undefined })
    );

    assert.equal(result.state, 'not_ready');
    if (result.state === 'not_ready') {
      assert.equal(result.reason, 'identity_mismatch');
    }
    assert.deepEqual(calls.processed, []);
  });

  it('uses exact IMDb only when canonical movie identity supplies it', async () => {
    const { service, calls } = buildService({
      search: [
        item({
          id: 'imdb-movie',
          includeTmdb: false,
          imdbId: 'tt0100101',
        }),
      ],
    });

    const result = await service.reconcile(
      movieTarget({
        jellyfinMediaId: undefined,
        imdbId: 'tt0100101',
      })
    );

    assert.equal(result.state, 'ready');
    assert.deepEqual(calls.processed, ['imdb-movie']);
  });

  it('processes only the requested quality when standard and 4K copies match', async () => {
    const { service, calls } = buildService({
      search: [
        item({ id: 'standard', width: 1920 }),
        item({ id: 'four-k', width: 3840 }),
      ],
      separate4kEnabled: true,
    });

    const result = await service.reconcile(
      movieTarget({ jellyfinMediaId: undefined, is4k: true })
    );

    assert.equal(result.state, 'ready');
    assert.deepEqual(calls.processed, ['four-k']);
  });

  it('preserves AniDB anime-as-movie identity and episode playability', async () => {
    const anime = item({
      id: 'anime-series',
      type: 'Series',
      includeTmdb: false,
      anidbId: 404,
    });
    const firstSeason = item({
      id: 'season-1',
      type: 'Season',
      includeTmdb: false,
      index: 1,
    });
    const { service, calls } = buildService({
      search: [anime],
      seasons: [firstSeason],
      episodes: [
        item({
          id: 'anime-movie-file',
          type: 'Episode',
          includeTmdb: false,
          index: 1,
        }),
      ],
      animeIdentity: { tmdbId: 101 },
    });

    const result = await service.reconcile(
      movieTarget({ jellyfinMediaId: undefined })
    );

    assert.equal(result.state, 'ready');
    assert.equal(calls.seasons, 1);
    assert.equal(calls.episodes, 1);
    assert.equal(calls.mappings, 1);
    assert.deepEqual(calls.processed, ['anime-series']);
  });

  it('requires every imported TV episode and supports combined multi-episode files', async () => {
    const series = item({
      id: 'series',
      type: 'Series',
      tmdbId: 303,
      tvdbId: 202,
    });
    const season = item({
      id: 'season-1',
      type: 'Season',
      includeTmdb: false,
      index: 1,
    });
    const combined = item({
      id: 'episode-1-2',
      type: 'Episode',
      includeTmdb: false,
      index: 1,
      indexEnd: 2,
    });
    const { service, calls } = buildService({
      exact: series,
      seasons: [season],
      episodes: [combined],
    });
    const result = await service.reconcile(
      movieTarget({
        mediaType: MediaType.TV,
        tmdbId: 303,
        tvdbId: 202,
        jellyfinMediaId: 'series',
        episodes: [
          {
            seasonNumber: 1,
            episodeNumber: 1,
            absoluteEpisodeNumber: 1,
            id: 11,
          },
          {
            seasonNumber: 1,
            episodeNumber: 2,
            absoluteEpisodeNumber: 2,
            id: 12,
          },
        ],
      })
    );

    assert.equal(result.state, 'ready');
    assert.equal(calls.seasons, 1);
    assert.equal(calls.episodes, 1);
    assert.deepEqual(calls.processed, ['series']);
  });

  it('proves each episode in a 4K season-pack target without per-episode requests', async () => {
    const series = item({
      id: 'series-4k',
      type: 'Series',
      tmdbId: 303,
      tvdbId: 202,
    });
    const season = item({
      id: 'season-2',
      type: 'Season',
      includeTmdb: false,
      index: 2,
    });
    const episodes = [1, 2, 3].map((episodeNumber) =>
      item({
        id: `episode-${episodeNumber}`,
        type: 'Episode',
        includeTmdb: false,
        index: episodeNumber,
        width: 3840,
      })
    );
    const { service, calls } = buildService({
      exact: series,
      seasons: [season],
      episodes,
      separate4kEnabled: true,
    });
    const result = await service.reconcile(
      movieTarget({
        mediaType: MediaType.TV,
        tmdbId: 303,
        tvdbId: 202,
        jellyfinMediaId: 'series-4k',
        is4k: true,
        episodes: [1, 2, 3].map((episodeNumber) => ({
          seasonNumber: 2,
          episodeNumber,
          absoluteEpisodeNumber: episodeNumber,
          id: 20 + episodeNumber,
        })),
      })
    );

    assert.equal(result.state, 'ready');
    assert.equal(calls.seasons, 1);
    assert.equal(calls.episodes, 1);
    assert.equal(result.jellyfinRequestCount, 3);
    assert.deepEqual(calls.processed, ['series-4k']);
  });

  it('does not treat a pre-existing partial TV season as proof of the imported episode', async () => {
    const series = item({
      id: 'series',
      type: 'Series',
      tmdbId: 303,
      tvdbId: 202,
    });
    const season = item({
      id: 'season-1',
      type: 'Season',
      includeTmdb: false,
      index: 1,
    });
    const { service, calls } = buildService({
      exact: series,
      seasons: [season],
      episodes: [
        item({
          id: 'episode-1',
          type: 'Episode',
          includeTmdb: false,
          index: 1,
        }),
      ],
      satisfied: true,
    });
    const result = await service.reconcile(
      movieTarget({
        mediaType: MediaType.TV,
        tmdbId: 303,
        tvdbId: 202,
        jellyfinMediaId: 'series',
        episodes: [
          {
            seasonNumber: 1,
            episodeNumber: 2,
            absoluteEpisodeNumber: 2,
            id: 12,
          },
        ],
      })
    );

    assert.equal(result.state, 'not_ready');
    if (result.state === 'not_ready')
      assert.equal(result.reason, 'episode_absent');
    assert.deepEqual(calls.processed, []);
  });

  it('uses exact TVDB fallback and proves specials across a bounded season request', async () => {
    const series = item({
      id: 'tvdb-series',
      type: 'Series',
      includeTmdb: false,
      tvdbId: 202,
    });
    const specials = item({
      id: 'specials',
      type: 'Season',
      includeTmdb: false,
      index: 0,
    });
    const { service, calls } = buildService({
      search: [series],
      seasons: [specials],
      episodes: [
        item({
          id: 'special-1',
          type: 'Episode',
          includeTmdb: false,
          index: 1,
        }),
      ],
    });

    const result = await service.reconcile(
      movieTarget({
        mediaType: MediaType.TV,
        tmdbId: 303,
        tvdbId: 202,
        jellyfinMediaId: undefined,
        episodes: [
          {
            seasonNumber: 0,
            episodeNumber: 1,
            absoluteEpisodeNumber: 0,
            id: 1,
          },
        ],
      })
    );

    assert.equal(result.state, 'ready');
    assert.equal(calls.search, 1);
    assert.equal(calls.seasons, 1);
    assert.equal(calls.episodes, 1);
    assert.deepEqual(calls.processed, ['tvdb-series']);
  });

  it('reports canonical processing failures as unknown without declaring availability', async () => {
    const exact = item({ id: 'known-movie' });
    const client = {
      getItemData: async () => exact,
    } as unknown as JellyfinAPI;
    const service = new JellyfinTargetedAvailability({
      prepareIdentityMappings: async () => undefined,
      getAnimeIdentity: () => undefined,
      isSeparate4kEnabled: () => false,
      createContext: async () => ({
        client,
        libraries: [
          { id: 'movies', name: 'Movies', type: 'movie', enabled: true },
        ],
      }),
      processItems: async () => ({
        status: 'failed',
        durationMs: 1,
        errorType: 'DatabaseError',
      }),
      isSatisfied: async () => true,
      now: () => 1_000,
    });

    const result = await service.reconcile(movieTarget());

    assert.equal(result.state, 'unknown');
    if (result.state === 'unknown') {
      assert.equal(result.reason, 'processing_failed');
      assert.equal(result.errorType, 'DatabaseError');
    }
  });
});
