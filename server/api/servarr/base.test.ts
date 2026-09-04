import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance, AxiosRequestConfig } from 'axios';

import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';

function buildSonarr(): SonarrAPI {
  return new SonarrAPI({ url: 'http://localhost:8989/api/v3', apiKey: 'test' });
}

function buildRadarr(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

function getAxios(servarr: SonarrAPI | RadarrAPI): AxiosInstance {
  return (servarr as unknown as { axios: AxiosInstance }).axios;
}

function queueResponse(
  page: number,
  totalRecords: number,
  records: Record<string, unknown>[],
  pageSize = 100
) {
  return {
    data: {
      page,
      pageSize,
      sortKey: 'timeleft',
      sortDirection: 'ascending',
      totalRecords,
      records,
    },
  };
}

describe('ServarrBase queue pagination', () => {
  afterEach(() => mock.restoreAll());

  it('defaults to 10 records and preserves episode data', async () => {
    const sonarr = buildSonarr();
    const records = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      downloadId: 'shared-season-pack',
      episode: { seasonNumber: 1, episodeNumber: index + 1 },
    }));
    const get = mock.method(getAxios(sonarr), 'get', async () =>
      queueResponse(1, 20, records, 10)
    );

    const queue = await sonarr.getQueue();

    assert.strictEqual(queue.length, 10);
    assert.deepStrictEqual(queue[9].episode, {
      seasonNumber: 1,
      episodeNumber: 10,
    });
    assert.strictEqual(
      queue.filter((item) => item.downloadId === 'shared-season-pack').length,
      10
    );
    assert.strictEqual(get.mock.callCount(), 1);
    assert.deepStrictEqual(get.mock.calls[0].arguments[1]?.params, {
      includeEpisode: true,
      page: 1,
      pageSize: 10,
    });
  });

  it('returns a custom limit smaller than the available queue', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () =>
      queueResponse(
        1,
        20,
        Array.from({ length: 5 }, (_, index) => ({ id: index + 1 })),
        5
      )
    );

    assert.strictEqual((await sonarr.getQueue(5)).length, 5);
    assert.strictEqual(get.mock.callCount(), 1);
  });

  it('uses the configured limit as the stable Servarr page size', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () =>
      queueResponse(
        1,
        250,
        Array.from({ length: 250 }, (_, index) => ({
          id: index + 1,
          episode: { seasonNumber: 2, episodeNumber: index + 1 },
        })),
        250
      )
    );

    const queue = await sonarr.getQueue(250);

    assert.strictEqual(queue.length, 250);
    assert.deepStrictEqual(queue[249].episode, {
      seasonNumber: 2,
      episodeNumber: 250,
    });
    assert.strictEqual(get.mock.callCount(), 1);
    assert.deepStrictEqual(get.mock.calls[0].arguments[1]?.params, {
      includeEpisode: true,
      page: 1,
      pageSize: 250,
    });
  });

  it('stops when the queue is smaller than the limit', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () =>
      queueResponse(1, 3, [{ id: 1 }, { id: 2 }, { id: 3 }], 20)
    );

    assert.strictEqual((await sonarr.getQueue(20)).length, 3);
    assert.strictEqual(get.mock.callCount(), 1);
  });

  it('does not fetch another page at the exact limit', async () => {
    const sonarr = buildSonarr();
    const get = mock.method(getAxios(sonarr), 'get', async () =>
      queueResponse(
        1,
        20,
        Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })),
        10
      )
    );

    assert.strictEqual((await sonarr.getQueue(10)).length, 10);
    assert.strictEqual(get.mock.callCount(), 1);
  });

  it('truncates an oversized final page to the configured limit', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () =>
      queueResponse(
        1,
        12,
        Array.from({ length: 12 }, (_, index) => ({ id: index + 1 })),
        12
      )
    );

    const queue = await sonarr.getQueue(10);
    assert.deepStrictEqual(
      queue.map((item) => item.id),
      Array.from({ length: 10 }, (_, index) => index + 1)
    );
  });

  it('rejects an empty page before the expected range is satisfied', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () =>
      queueResponse(1, 20, [], 10)
    );

    await assert.rejects(() => sonarr.getQueue(), /contained 0 of 10/);
  });

  it('rejects an incomplete non-empty response atomically', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'get', async () =>
      queueResponse(
        1,
        11,
        Array.from({ length: 10 }, (_, index) => ({ id: index + 1 })),
        11
      )
    );

    await assert.rejects(() => sonarr.getQueue(11), /contained 10 of 11/);
  });

  it('retrieves a bounded Radarr queue without episode-specific assumptions', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () =>
      queueResponse(1, 2, [
        { id: 1, movieId: 101 },
        { id: 2, movieId: 102 },
      ])
    );

    const queue = await radarr.getQueue(2);

    assert.deepStrictEqual(
      queue.map((item) => item.movieId),
      [101, 102]
    );
    assert.deepStrictEqual(get.mock.calls[0].arguments[1]?.params, {
      includeEpisode: true,
      page: 1,
      pageSize: 2,
    });
  });

  for (const limit of [
    0,
    -1,
    1.5,
    1001,
    Number.NaN,
    Infinity,
    '10',
    true,
    false,
  ]) {
    it(`rejects invalid queue limit ${String(limit)}`, async () => {
      const sonarr = buildSonarr();
      const get = mock.method(getAxios(sonarr), 'get', async () =>
        queueResponse(1, 0, [])
      );

      await assert.rejects(
        () => sonarr.getQueue(limit as number),
        /integer between/
      );
      assert.strictEqual(get.mock.callCount(), 0);
    });
  }
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

  it('rejects when a command poll completes after the deadline', async () => {
    const sonarr = buildSonarr();
    mock.method(getAxios(sonarr), 'post', async () => ({
      data: { id: 45, status: 'queued', result: 'unknown' },
    }));
    const get = mock.method(
      getAxios(sonarr),
      'get',
      async (_path: string, config?: AxiosRequestConfig) => {
        assert.ok(config?.timeout);
        assert.ok(config.timeout <= 20);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          data: { id: 45, status: 'completed', result: 'successful' },
        };
      }
    );

    await assert.rejects(
      () =>
        sonarr.refreshMonitoredDownloads({
          pollIntervalMs: 1,
          timeoutMs: 20,
        }),
      /Command 45 timed out after 20ms/
    );
    assert.strictEqual(get.mock.callCount(), 1);
  });
});
