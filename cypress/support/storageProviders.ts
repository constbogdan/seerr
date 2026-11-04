import { createServer, type Server } from 'node:http';

// Provider-boundary fixture: the browser still uses Seerr's real Storage route.
// Never connects to external services and rejects every provider mutation.
export function registerStorageProviderTasks(on: Cypress.PluginEvents) {
  let server: Server | undefined;
  const requests: Record<string, number> = {};
  const stop = async () => {
    if (!server) return null;
    const current = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()));
      current.closeAllConnections();
    });
    return null;
  };
  on('task', {
    async startStorageProviders() {
      await stop();
      for (const key of Object.keys(requests)) delete requests[key];
      server = createServer((request, response) => {
        const pathname = new URL(request.url ?? '/', 'http://127.0.0.1')
          .pathname;
        requests[`${request.method} ${pathname}`] =
          (requests[`${request.method} ${pathname}`] ?? 0) + 1;
        response.setHeader('Content-Type', 'application/json');
        if (request.method !== 'GET') {
          response.writeHead(405).end('{}');
          return;
        }
        const match =
          /^\/(radarr|sonarr)\/api\/v3\/(rootfolder|diskspace)$/.exec(pathname);
        if (!match) {
          response.writeHead(404).end('{}');
          return;
        }
        const movie = match[1] === 'radarr';
        const volume = movie ? 1 : 3;
        response.end(
          JSON.stringify(
            match[2] === 'rootfolder'
              ? [
                  {
                    id: movie ? 10 : 20,
                    path: `/volume${volume}/media-${movie ? 'movies' : 'shows'}`,
                    accessible: true,
                    freeSpace: 400,
                  },
                  {
                    id: movie ? 11 : 21,
                    path: `/volume9/media-${movie ? 'movies' : 'shows'}`,
                    accessible: true,
                    freeSpace: 800,
                  },
                ]
              : [
                  {
                    path: `/volume${volume}`,
                    freeSpace: 400,
                    totalSpace: 1000,
                  },
                  { path: '/volume9', freeSpace: 800, totalSpace: 2000 },
                ]
          )
        );
      });
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Fixture did not bind.');
      return address.port;
    },
    storageProviderRequests: () => ({ ...requests }),
    stopStorageProviders: stop,
  });
  on('after:run', async () => {
    await stop();
  });
}
