import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import RadarrAPI, {
  type RadarrMovie,
  type RadarrMovieOptions,
} from '@server/api/servarr/radarr';
import SonarrAPI, {
  type AddSeriesOptions,
  type SonarrSeries,
} from '@server/api/servarr/sonarr';

const getAxios = (provider: RadarrAPI | SonarrAPI): AxiosInstance =>
  (provider as unknown as { axios: AxiosInstance }).axios;

const movie = (overrides: Partial<RadarrMovie> = {}): RadarrMovie =>
  ({
    id: 10,
    title: 'Movie',
    isAvailable: false,
    monitored: true,
    tmdbId: 100,
    imdbId: 'tt100',
    titleSlug: 'movie',
    folderName: 'Movie',
    path: '/volume1/movies/Movie',
    rootFolderPath: '/volume1/movies',
    profileId: 1,
    qualityProfileId: 1,
    added: '2026-10-18T00:00:00.000Z',
    hasFile: false,
    tags: [1, 3],
    ...overrides,
  }) as RadarrMovie;

const movieOptions: RadarrMovieOptions = {
  title: 'Movie',
  qualityProfileId: 1,
  profileId: 1,
  year: 2026,
  minimumAvailability: 'released',
  tags: [2, 3],
  rootFolderPath: '/volume9/movies',
  tmdbId: 100,
  monitored: true,
  searchNow: false,
  applyRootFolderAndTagsToExisting: true,
};

describe('Servarr Overflow placement boundaries', () => {
  afterEach(() => mock.restoreAll());

  it('updates an existing monitored Movie without files before search', async () => {
    const radarr = new RadarrAPI({
      url: 'http://localhost:7878/api/v3',
      apiKey: 'test',
    });
    const put = mock.method(
      getAxios(radarr),
      'put',
      async (_url: string, body: unknown) => ({ data: body })
    );

    const result = await radarr.addMovie(movieOptions, movie());

    assert.equal(put.mock.callCount(), 1);
    assert.equal(put.mock.calls[0].arguments[0], '/movie');
    assert.equal(
      (put.mock.calls[0].arguments[1] as RadarrMovie).rootFolderPath,
      '/volume9/movies'
    );
    assert.deepEqual(
      (put.mock.calls[0].arguments[1] as RadarrMovie).tags,
      [2, 3]
    );
    assert.equal(result.rootFolderPath, '/volume9/movies');
  });

  it('never updates a Movie that already has a file', async () => {
    const radarr = new RadarrAPI({
      url: 'http://localhost:7878/api/v3',
      apiKey: 'test',
    });
    const put = mock.method(getAxios(radarr), 'put', async () => {
      throw new Error('must not be called');
    });

    const result = await radarr.addMovie(
      movieOptions,
      movie({ hasFile: true })
    );

    assert.equal(put.mock.callCount(), 0);
    assert.equal(result.rootFolderPath, '/volume1/movies');
  });

  it('replaces the opposite routing tag when re-monitoring a Movie without files', async () => {
    const radarr = new RadarrAPI({
      url: 'http://localhost:7878/api/v3',
      apiKey: 'test',
    });
    const put = mock.method(
      getAxios(radarr),
      'put',
      async (_url: string, body: unknown) => ({ data: body })
    );

    await radarr.addMovie(movieOptions, movie({ monitored: false }));

    assert.deepEqual(
      (put.mock.calls[0].arguments[1] as RadarrMovie).tags,
      [2, 3]
    );
  });

  it('retains an existing Series root during additional Season requests', async () => {
    const sonarr = new SonarrAPI({
      url: 'http://localhost:8989/api/v3',
      apiKey: 'test',
    });
    const existing = {
      id: 20,
      title: 'Series',
      path: '/volume3/shows/Series',
      rootFolderPath: '/volume3/shows',
      monitored: true,
      tags: [1],
      seasons: [{ seasonNumber: 1, monitored: true }],
    } as SonarrSeries;
    const put = mock.method(
      getAxios(sonarr),
      'put',
      async (_url: string, body: unknown) => ({ data: body })
    );
    mock.method(sonarr, 'getEpisodes', async () => []);
    const options = {
      tvdbid: 200,
      title: 'Series',
      profileId: 1,
      seasons: [2],
      seasonFolder: true,
      rootFolderPath: '/volume9/shows',
      tags: [1],
      seriesType: 'standard',
      monitored: true,
      searchNow: false,
    } as AddSeriesOptions;

    await sonarr.addSeries(options, existing);

    assert.equal(put.mock.callCount(), 1);
    assert.equal(
      (put.mock.calls[0].arguments[1] as SonarrSeries).rootFolderPath,
      '/volume3/shows'
    );
  });
});
