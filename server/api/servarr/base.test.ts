import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance, AxiosRequestConfig } from 'axios';

import SonarrAPI from '@server/api/servarr/sonarr';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function getAxios(sonarr: SonarrAPI): AxiosInstance {
  return (sonarr as unknown as { axios: AxiosInstance }).axios;
}

function queueResponse(
  page: number,
  totalRecords: number,
  records: Record<string, unknown>[]
) {
  return {
    data: {
      page,
      pageSize: 100,
      sortKey: 'timeleft',
      sortDirection: 'ascending',
      totalRecords,
      records,
    },
  };
}

describe('ServarrBase queue pagination', () => {
  afterEach(() => mock.restoreAll());

  it('retrieves every queue page and preserves episode data', async () => {
    const sonarr = buildSonarr();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      episode: { seasonNumber: 1, episodeNumber: index + 1 },
    }));
    const secondPage = Array.from({ length: 14 }, (_, index) => ({
      id: index + 101,
      episode: { seasonNumber: 2, episodeNumber: index + 1 },
    }));
    const get = mock.method(
      getAxios(sonarr),
      'get',
      async (_path: string, config?: AxiosRequestConfig) =>
        config?.params?.page === 1
          ? queueResponse(1, 114, firstPage)
          : queueResponse(2, 114, secondPage)
    );

    const queue = await sonarr.getQueue();

    assert.strictEqual(queue.length, 114);
    assert.deepStrictEqual(queue[113].episode, {
      seasonNumber: 2,
      episodeNumber: 14,
    });
    assert.strictEqual(get.mock.callCount(), 2);
    assert.deepStrictEqual(get.mock.calls[0].arguments[1]?.params, {
      includeEpisode: true,
      page: 1,
      pageSize: 100,
    });
  });

  it('rejects the whole queue fetch when a later page fails', async () => {
    const sonarr = buildSonarr();
    let page = 0;
    mock.method(getAxios(sonarr), 'get', async () => {
      page += 1;
      if (page === 1) {
        return queueResponse(
          1,
          101,
          Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
        );
      }

      throw new Error('second page unavailable');
    });

    await assert.rejects(() => sonarr.getQueue(), /Failed to retrieve queue/);
  });
});

describe('ServarrBase command completion', () => {
  afterEach(() => mock.restoreAll());

  it('waits for the submitted command to complete successfully', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'post', async () => ({
      data: { id: 42, status: 'queued', result: 'unknown' },
    }));
    let poll = 0;
    const get = mock.method(getAxios(sonarr), 'get', async () => {
      poll += 1;
      return {
        data:
          poll === 1
            ? { id: 42, status: 'started', result: 'unknown' }
            : { id: 42, status: 'completed', result: 'successful' },
      };
    });

    await sonarr.refreshMonitoredDownloads({
      pollIntervalMs: 1,
      timeoutMs: 100,
    });

    assert.strictEqual(get.mock.callCount(), 2);
    assert.strictEqual(get.mock.calls[0].arguments[0], '/command/42');
  });

  it('rejects a failed command', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'post', async () => ({
      data: { id: 43, status: 'queued', result: 'unknown' },
    }));
    mock.method(getAxios(sonarr), 'get', async () => ({
      data: {
        id: 43,
        status: 'failed',
        result: 'unsuccessful',
        exception: 'client unavailable',
      },
    }));

    await assert.rejects(
      () =>
        sonarr.refreshMonitoredDownloads({
          pollIntervalMs: 1,
          timeoutMs: 100,
        }),
      /client unavailable/
    );
  });

  it('rejects when command completion times out', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'post', async () => ({
      data: { id: 44, status: 'queued', result: 'unknown' },
    }));
    mock.method(getAxios(sonarr), 'get', async () => ({
      data: { id: 44, status: 'started', result: 'unknown' },
    }));

    await assert.rejects(
      () =>
        sonarr.refreshMonitoredDownloads({
          pollIntervalMs: 1,
          timeoutMs: 5,
        }),
      /timed out/
    );
  });
});
