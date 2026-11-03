import type { FreshRelease, FreshReleasePage } from '@server/api/autobrr';
import type {
  TmdbMovieResult,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import FreshDiscovery from '@server/entity/FreshDiscovery';
import FreshSourceState from '@server/entity/FreshSourceState';
import FreshWork from '@server/entity/FreshWork';
import type { FreshIdentityProvider } from '@server/lib/fresh/matching';
import type { FreshSettings } from '@server/lib/settings';
import { DataSource } from 'typeorm';

export const fixtureSettings: FreshSettings = {
  enabled: true,
  baseUrl: 'https://autobrr.test',
  apiToken: 'fixture-token',
  filterId: 7,
  cachedFilterName: 'Fresh',
  freshVisibilityDays: 7,
};
export const fixtureNow = new Date('2026-10-25T12:00:00Z');
export const createFixtureDatabase = async () => {
  const database = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [FreshSourceState, FreshWork, FreshDiscovery],
    synchronize: true,
  });
  await database.initialize();
  return database;
};
export const fixtureRelease = (
  id: number,
  overrides: Partial<FreshRelease> = {}
): FreshRelease => ({
  releaseId: String(id),
  mediaType: 'movie',
  title: 'Movie ' + id,
  sourceTitle: 'Movie.' + id + '.2025.1080p.WEB-DL-GROUP',
  year: 2025,
  seasonNumber: -1,
  episodeNumber: -1,
  explicitSeason: false,
  explicitSpecial: false,
  observedAt: fixtureNow.getTime() - 3600000,
  availabilityType: 'digital',
  ...overrides,
});
export const fixturePage = (
  releases: FreshRelease[],
  cursor = 0,
  size = 2
): FreshReleasePage => {
  const rows = releases
    .filter((release) => !cursor || Number(release.releaseId) < cursor)
    .slice(0, size);
  const ids = rows.map((row) => row.releaseId);
  return {
    releases: rows,
    releaseIds: ids,
    newestReleaseId: ids[0],
    oldestReleaseId: ids.at(-1),
    nextCursor: Number(ids.at(-1) ?? 0),
    filterObserved: true,
    counts: {
      inspected: rows.length,
      selectedFilter: rows.length,
      eligibleMovies: rows.filter((row) => row.mediaType === 'movie').length,
      eligibleTv: rows.filter((row) => row.mediaType === 'tv').length,
    },
  };
};
export const fixtureMovie = (id: number, title: string, date = '2026-05-13') =>
  ({
    id,
    title,
    original_title: title,
    media_type: 'movie',
    release_date: date,
    vote_count: 0,
    vote_average: 0,
    genre_ids: [],
    original_language: 'en',
    overview: '',
    popularity: 0,
    adult: false,
    video: false,
  }) as TmdbMovieResult;
export const fixtureTv = (id: number, name: string) =>
  ({
    id,
    name,
    original_name: name,
    media_type: 'tv',
    first_air_date: '2001-01-01',
    genre_ids: [],
    original_language: 'en',
    overview: '',
    popularity: 0,
    vote_count: 0,
    vote_average: 0,
    origin_country: [],
  }) as TmdbTvResult;
export const fixtureSearch = <T>(results: T[], page = 1) => ({
  page,
  total_pages: results.length ? 1 : 0,
  total_results: results.length,
  results,
});
export const fixtureProvider = (): FreshIdentityProvider => ({
  searchMoviesStrict: async ({ query, page = 1 }) =>
    fixtureSearch(
      [fixtureMovie(Number(query.match(/\d+$/)?.[0] ?? 101), query)],
      page
    ),
  searchTvShowsStrict: async ({ query, page = 1 }) =>
    fixtureSearch([fixtureTv(201, query)], page),
  getMovie: async ({ movieId }) =>
    ({ id: movieId, title: 'Movie ' + movieId }) as never,
  getTvShow: async ({ tvId }) =>
    ({ id: tvId, name: 'Series ' + tvId }) as never,
  getByExternalId: async () => ({
    movie_results: [],
    tv_results: [],
    person_results: [],
    tv_episode_results: [],
    tv_season_results: [],
  }),
  getDiscoveryAliases: async () => [],
});
