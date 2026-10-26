import { spawn, type ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';

type Reply = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
};

// Optional, explicit browser acceptance only; no persistent browser profile or
// external automation dependency. CDP connects exclusively to the child we start.
export class SubtitleBrowser {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  private listeners = new Set<(event: Reply) => void>();

  private constructor(
    private socket: WebSocket,
    private child: ChildProcess
  ) {
    socket.addEventListener('message', (event) => {
      const reply = JSON.parse(String(event.data)) as Reply;
      if (reply.id) {
        const pending = this.pending.get(reply.id);
        this.pending.delete(reply.id);
        if (reply.error) pending?.reject(new Error(reply.error.message));
        else pending?.resolve(reply.result ?? {});
      } else for (const listener of this.listeners) listener(reply);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values())
        pending.reject(new Error('Fixture browser closed.'));
      this.pending.clear();
    });
  }

  static async start(profile: string, certificatePin: string) {
    const executable = [
      process.env.SUBTITLE_TEST_CHROME,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].find(
      (candidate): candidate is string => !!candidate && existsSync(candidate)
    );
    if (!executable)
      throw new Error(
        'Set SUBTITLE_TEST_CHROME to an installed Chromium executable.'
      );
    const child = spawn(
      executable,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        `--ignore-certificate-errors-spki-list=${certificatePin}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-extensions',
        '--no-proxy-server',
        'about:blank',
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    const address = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('Fixture browser startup timed out.'));
      }, 15_000);
      let output = '';
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.stderr?.on('data', (data) => {
        output = `${output}${String(data)}`.slice(-8192);
        const match = output.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/
        );
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
    });
    const socket = new WebSocket(address);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('Fixture CDP connection failed.')),
        { once: true }
      );
    });
    return new SubtitleBrowser(socket, child);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ) {
    const id = ++this.sequence;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async page(html: string, permittedApiOrigin: string, origin: string) {
    // Test-only permission: the fixture API is loopback while the synthetic
    // document has a public origin. This does not relax CORS or certificate checks.
    await this.send('Browser.setPermission', {
      origin,
      embeddedOrigin: origin,
      permission: { name: 'loopback-network' },
      setting: 'granted',
    });
    const target = await this.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await this.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const sessionId = String(attached.sessionId);
    const failures: unknown[] = [];
    const listener = (event: Reply) => {
      if (
        event.sessionId === sessionId &&
        event.method === 'Network.loadingFailed'
      ) {
        failures.push({
          error: event.params?.errorText,
          cors: event.params?.corsErrorStatus,
          blocked: event.params?.blockedReason,
        });
      }
      if (
        event.sessionId !== sessionId ||
        event.method !== 'Fetch.requestPaused'
      )
        return;
      const request = event.params?.request as { url: string };
      const requestId = event.params?.requestId;
      const url = new URL(request.url);
      const operation =
        url.origin === permittedApiOrigin
          ? this.send('Fetch.continueRequest', { requestId }, sessionId)
          : url.origin === origin && event.params?.resourceType === 'Document'
            ? this.send(
                'Fetch.fulfillRequest',
                {
                  requestId,
                  responseCode: 200,
                  responseHeaders: [
                    { name: 'Content-Type', value: 'text/html; charset=utf-8' },
                  ],
                  body: Buffer.from(html).toString('base64'),
                },
                sessionId
              )
            : this.send(
                'Fetch.failRequest',
                { requestId, errorReason: 'BlockedByClient' },
                sessionId
              );
      void operation.catch(() => undefined);
    };
    this.listeners.add(listener);
    await this.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*' }] },
      sessionId
    );
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    const loaded = new Promise<void>((resolve) => {
      const onLoad = (event: Reply) => {
        if (
          event.sessionId === sessionId &&
          event.method === 'Page.loadEventFired'
        ) {
          this.listeners.delete(onLoad);
          resolve();
        }
      };
      this.listeners.add(onLoad);
    });
    // Synthetic Jellyfin-origin document; its request is fulfilled above and
    // NEVER contacts production. Only the local HTTPS fixture may reach a socket.
    await this.send(
      'Page.navigate',
      { url: `${origin}/__subtitle_fixture__` },
      sessionId
    );
    await loaded;
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = await this.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId
      );
      if (result.exceptionDetails)
        throw new Error('Fixture evaluation failed.');
      return (result.result as { value: T }).value;
    };
    await evaluate(
      `document.readyState === 'complete' ? true : new Promise(resolve => window.addEventListener('load', () => resolve(true), {once:true}))`
    );
    return {
      failures,
      evaluate,
      send: (method: string, params: Record<string, unknown>) =>
        this.send(method, params, sessionId),
      close: async () => {
        this.listeners.delete(listener);
        await this.send('Target.closeTarget', { targetId: target.targetId });
      },
    };
  }

  async close() {
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) resolve();
      else (this.child as EventEmitter).once('exit', () => resolve());
    });
    await this.send('Browser.close').catch(() => undefined);
    const timeout = setTimeout(() => this.child.kill(), 5000);
    await exited;
    clearTimeout(timeout);
    this.socket.close();
  }
}
