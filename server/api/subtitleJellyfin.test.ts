import { SubtitleJellyfin } from '@server/api/subtitleJellyfin';
import type { SubtitleReportError } from '@server/lib/subtitleIssue';
import logger from '@server/logger';
import axios from 'axios';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, mock } from 'node:test';

describe('credential-safe subtitle Jellyfin transport', () => {
  it('uses Users/Me, verified-user item paths and bounded requests without tokens in URLs', async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      assert.equal(req.method, 'GET');
      paths.push(req.url ?? '');
      assert.equal(req.headers['x-emby-token'], 'private-token');
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const originalCreate = axios.create;
    const create = mock.method(
      axios,
      'create',
      (config: Parameters<typeof axios.create>[0]) => {
        assert.equal(config?.timeout, 5000);
        assert.equal(config?.maxRedirects, 0);
        assert.equal(config?.maxContentLength, 1024 * 1024);
        return originalCreate(config);
      }
    );
    try {
      const client = new SubtitleJellyfin(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/jellyfin`,
        'private-token'
      );
      await client.getUser();
      await client.getItem('c'.repeat(32), 'a'.repeat(32));
      assert.deepEqual(paths, [
        '/jellyfin/Users/Me',
        `/jellyfin/Users/${'c'.repeat(32)}/Items/${'a'.repeat(32)}`,
      ]);
    } finally {
      create.mock.restore();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
  for (const status of [302, 401, 403, 404, 500]) {
    it(`sanitizes ${status} responses without following credential-bearing redirects or logging payloads`, async () => {
      let destinationHits = 0;
      const destination = createServer((_req, res) => {
        destinationHits++;
        res.end('{}');
      });
      await new Promise<void>((resolve) =>
        destination.listen(0, '127.0.0.1', resolve)
      );
      const server = createServer((_req, res) => {
        res.statusCode = status;
        res.setHeader(
          'Location',
          `http://127.0.0.1:${(destination.address() as AddressInfo).port}/private-token`
        );
        res.end('private-token Authorization: secret payload');
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      const logged = mock.method(logger, 'error', () => logger);
      try {
        const client = new SubtitleJellyfin(
          `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          'private-token'
        );
        await assert.rejects(client.getUser(), (error: SubtitleReportError) => {
          assert.equal(
            error.status,
            [401, 403].includes(status) ? 401 : status === 404 ? 404 : 502
          );
          assert.ok(!error.message.includes('private-token'));
          assert.ok(!error.message.includes('payload'));
          return true;
        });
        assert.equal(destinationHits, 0);
        assert.equal(logged.mock.callCount(), 0);
      } finally {
        logged.mock.restore();
        await Promise.all(
          [server, destination].map(
            (entry) =>
              new Promise<void>((resolve, reject) =>
                entry.close((error) => (error ? reject(error) : resolve()))
              )
          )
        );
      }
    });
  }
});
