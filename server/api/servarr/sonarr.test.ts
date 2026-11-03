import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import SonarrAPI from '@server/api/servarr/sonarr';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function getAxios(sonarr: SonarrAPI): AxiosInstance {
  return (sonarr as unknown as { axios: AxiosInstance }).axios;
}

describe('SonarrAPI removeSeries', () => {
  afterEach(() => mock.restoreAll());

  it('removes the series when it exists in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getLibrarySeriesByTvdbId', async () => [
      {
        id: 9,
        title: 'Test Series',
        tvdbId: 1234,
      },
    ]);
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await sonarr.removeSeries(1234);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/series/9');
    assert.deepEqual(del.mock.calls[0].arguments[1], {
      params: { deleteFiles: true, addImportListExclusion: false },
    });
  });

  it('does nothing when the series is not in the library', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({
      data: [{ id: 0, title: 'Breaking Bad' }],
    }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('revalidates fenced ownership immediately before deletion', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getLibrarySeriesByTvdbId', async () => [
      { id: 9, title: 'Test Series', tvdbId: 1234 },
    ]);
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));
    const beforeDelete = mock.fn(async () => {
      assert.equal(del.mock.callCount(), 0);
    });

    await sonarr.removeSeries(1234, beforeDelete);

    assert.equal(beforeDelete.mock.callCount(), 1);
    assert.equal(del.mock.callCount(), 1);
  });

  it('is idempotent when the tvdbId is absent from the library', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the series was already removed in Sonarr', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getLibrarySeriesByTvdbId', async () => [
      {
        id: 9,
        title: 'Test Series',
        tvdbId: 1234,
      },
    ]);
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => sonarr.removeSeries(1234));
  });

  it('rethrows errors other than 404', async () => {
    const sonarr = buildSonarr();
    mock.method(SonarrAPI.prototype, 'getLibrarySeriesByTvdbId', async () => [
      {
        id: 9,
        title: 'Test Series',
        tvdbId: 1234,
      },
    ]);
    mock.method(getAxios(sonarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => sonarr.removeSeries(1234));
  });

  it('rethrows a 404 from the library query instead of treating it as removed', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(sonarr), 'delete', async () => ({}));

    await assert.rejects(
      () => sonarr.removeSeries(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('SonarrAPI getSeriesByTvdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => sonarr.getSeriesByTvdbId(1234),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Series not found" when the lookup returns no results', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => sonarr.getSeriesByTvdbId(1234), {
      message: 'Series not found',
    });
  });
});

describe('SonarrAPI whole-Series relocation', () => {
  afterEach(() => mock.restoreAll());

  it('uses the native Sonarr moveFiles update and returns the verified target path', async () => {
    const sonarr = buildSonarr();
    const put = mock.method(getAxios(sonarr), 'put', async () => ({
      data: {},
    }));
    const series = {
      id: 20,
      title: 'Example',
      path: '/volume3/shows/Example',
    } as Parameters<SonarrAPI['moveSeries']>[0];

    assert.deepEqual(await sonarr.moveSeries(series, '/volume9/shows/'), {
      destinationPath: '/volume9/shows/Example',
    });
    assert.equal(put.mock.callCount(), 1);
    assert.equal(put.mock.calls[0].arguments[0], '/series/20');
    const body = put.mock.calls[0].arguments[1] as {
      path: string;
      rootFolderPath: string;
    };
    assert.equal(body.path, '/volume9/shows/Example');
    assert.equal(body.rootFolderPath, '/volume9/shows');
    assert.deepEqual(put.mock.calls[0].arguments[2], {
      params: { moveFiles: true },
    });
  });

  it('rejects a Series without a provider identity before issuing a request', async () => {
    const sonarr = buildSonarr();
    const put = mock.method(getAxios(sonarr), 'put', async () => ({
      data: {},
    }));
    await assert.rejects(
      () =>
        sonarr.moveSeries(
          { path: '/volume3/shows/Example' } as Parameters<
            SonarrAPI['moveSeries']
          >[0],
          '/volume9/shows'
        ),
      /without an ID/
    );
    assert.equal(put.mock.callCount(), 0);
  });

  it('reads and filters the Sonarr move commands for the requested Series', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: [
        {
          id: 1,
          commandName: 'MoveSeries',
          status: 'started',
          body: { seriesId: 20, destinationPath: '/volume9/shows/Example' },
        },
        {
          id: 2,
          name: 'MoveSeries',
          status: 'queued',
          body: { seriesId: 21, destinationPath: '/volume9/shows/Other' },
        },
        {
          id: 3,
          commandName: 'RefreshSeries',
          status: 'started',
          body: { seriesId: 20 },
        },
      ],
    }));

    assert.deepEqual(await sonarr.getSeriesMoveCommands(20), [
      {
        id: 1,
        commandName: 'MoveSeries',
        status: 'started',
        body: { seriesId: 20, destinationPath: '/volume9/shows/Example' },
      },
    ]);
    assert.deepEqual(get.mock.calls[0].arguments, ['/command']);
  });
});

describe('SonarrAPI current EpisodeFile reads', () => {
  afterEach(() => mock.restoreAll());

  it('retrieves EpisodeFiles in one read-only series-scoped request', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () => ({
      data: [{ id: 4, seriesId: 9, size: 1000 }],
    }));

    const files = await sonarr.getEpisodeFiles(9);

    assert.equal(files.length, 1);
    assert.deepEqual(get.mock.calls[0].arguments, [
      '/episodefile',
      { params: { seriesId: 9 } },
    ]);
  });
});

describe('SonarrAPI season removal mutations', () => {
  afterEach(() => mock.restoreAll());

  it('updates the exact season and episode monitoring state', async () => {
    const sonarr = buildSonarr();
    const put = mock.method(getAxios(sonarr), 'put', async () => ({
      data: { id: 9 },
    }));
    const series = {
      id: 9,
      seasons: [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: true },
      ],
    } as never;

    await sonarr.setSeasonMonitored(series, 2, false);
    await sonarr.setEpisodesMonitored([10, 11], false);

    assert.strictEqual(put.mock.calls[0].arguments[0], '/series');
    assert.deepEqual(
      (put.mock.calls[0].arguments[1] as { seasons: unknown[] }).seasons,
      [
        { seasonNumber: 1, monitored: true },
        { seasonNumber: 2, monitored: false },
      ]
    );
    assert.deepEqual(put.mock.calls[1].arguments, [
      '/episode/monitor',
      { episodeIds: [10, 11], monitored: false },
    ]);
  });

  it('deduplicates EpisodeFile deletion and treats 404 as converged', async () => {
    const sonarr = buildSonarr();
    const del = mock.method(
      getAxios(sonarr),
      'delete',
      async (path: string) => {
        if (path === '/episodefile/4') throw { response: { status: 404 } };
        return {};
      }
    );

    await assert.doesNotReject(() => sonarr.deleteEpisodeFiles([4, 4, 5]));
    assert.deepEqual(
      del.mock.calls.map((call) => call.arguments[0]),
      ['/episodefile/4', '/episodefile/5']
    );
  });
});
