import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const delay = (milliseconds: number) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const chromePath = async () => {
  const candidates = [
    process.env.R11_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported installation path.
    }
  }
  throw new Error('Chrome was not found. Set R11_CHROME_PATH explicitly.');
};

interface PendingCommand {
  resolve: (value: Record<string, unknown>) => void;
  reject: (reason: Error) => void;
}

class SmokeCdp {
  private socket: WebSocket;
  private commandId = 0;
  private pending = new Map<number, PendingCommand>();

  constructor(
    url: string,
    private readonly label: string
  ) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: Record<string, unknown>;
        error?: { message: string };
      };
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    };
    this.socket.onclose = () => {
      for (const pending of this.pending.values())
        pending.reject(
          new Error(`Chrome DevTools smoke socket closed: ${this.label}`)
        );
      this.pending.clear();
    };
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolveOpen, reject) => {
      this.socket.onopen = () => resolveOpen();
      this.socket.onerror = () =>
        reject(new Error('Chrome DevTools smoke socket failed'));
    });
  }

  send(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.commandId;
    return new Promise<Record<string, unknown>>((resolveCommand, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools smoke command timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolveCommand(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params: Record<string, unknown> = {}) {
    this.socket.send(JSON.stringify({ id: ++this.commandId, method, params }));
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (response.exceptionDetails)
      throw new Error(response.exceptionDetails.text);
    return response.result?.value as T;
  }

  close() {
    this.socket.close();
  }
}

const waitForHttp = async (url: string, child: ChildProcess) => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Chrome exited during startup with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chrome has not bound its isolated debugging port yet.
    }
    await delay(100);
  }
  throw new Error(`Chrome did not expose ${url}`);
};

const waitForTitle = async (page: SmokeCdp, title: string) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await page.evaluate<string>('document.title')) === title) return;
    await delay(50);
  }
  throw new Error(`Navigation did not reach ${title}`);
};

const waitForExit = (child: ChildProcess, timeoutMilliseconds: number) =>
  Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) =>
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
    ),
    delay(timeoutMilliseconds).then(() => undefined),
  ]);

const runVariant = async (name: string, port: number, extraFlags: string[]) => {
  const executable = await chromePath();
  const profile = await mkdtemp(join(tmpdir(), `seerr-r11-${name}-`));
  let stderr = '';
  const child = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      ...extraFlags,
      'about:blank',
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  const startedAt = Date.now();
  let cleanShutdown = false;
  let phase = 'startup';
  try {
    phase = 'wait-for-version-endpoint';
    const version = (await waitForHttp(
      `http://127.0.0.1:${port}/json/version`,
      child
    )) as { Browser: string; webSocketDebuggerUrl: string };
    phase = 'browser-websocket-open';
    const browser = new SmokeCdp(
      version.webSocketDebuggerUrl,
      `${name}:browser`
    );
    await browser.open();
    phase = 'browser-get-version';
    const browserVersion = await browser.send('Browser.getVersion');
    const navigationTitles: string[] = [];

    for (const index of [1, 2]) {
      phase = `target-${index}-create`;
      const created = (await browser.send('Target.createTarget', {
        url: 'about:blank',
      })) as { targetId: string };
      phase = `target-${index}-list`;
      const targets = (await fetch(`http://127.0.0.1:${port}/json/list`).then(
        (response) => response.json()
      )) as {
        id: string;
        webSocketDebuggerUrl: string;
      }[];
      const target = targets.find(({ id }) => id === created.targetId);
      assert.ok(target?.webSocketDebuggerUrl);
      phase = `target-${index}-websocket-open`;
      const page = new SmokeCdp(
        target.webSocketDebuggerUrl,
        `${name}:target-${index}`
      );
      await page.open();
      phase = `target-${index}-page-enable`;
      await page.send('Page.enable');
      phase = `target-${index}-runtime-enable`;
      await page.send('Runtime.enable');
      for (const suffix of ['first', 'second', 'third']) {
        const title = `${name}-${index}-${suffix}`;
        phase = `target-${index}-navigate-${suffix}`;
        await page.send('Page.navigate', {
          url: `data:text/html,<title>${title}</title><main>${title}</main>`,
        });
        await waitForTitle(page, title);
        navigationTitles.push(title);
      }
      phase = `target-${index}-socket-close`;
      page.close();
      phase = `target-${index}-close`;
      const closed = (await browser.send('Target.closeTarget', {
        targetId: created.targetId,
      })) as { success: boolean };
      assert.equal(closed.success, true);
    }

    phase = 'browser-close';
    browser.notify('Browser.close');
    const exit = await waitForExit(child, 10_000);
    cleanShutdown = Boolean(exit);
    browser.close();
    assert.ok(exit, 'Chrome did not exit after Browser.close');
    return {
      name,
      executable,
      browser: version.Browser,
      browserVersion,
      navigationTitles,
      durationMilliseconds: Date.now() - startedAt,
      cleanShutdown,
      exit,
      stderr: stderr.trim().split(/\r?\n/).filter(Boolean),
    };
  } catch (error) {
    throw new Error(
      `${name} Chrome smoke failed during ${phase}; cause=${
        error instanceof Error ? error.message : String(error)
      }; pid=${child.pid}; exitCode=${child.exitCode}; signal=${child.signalCode}; stderr=${JSON.stringify(
        stderr.trim().split(/\r?\n/).filter(Boolean)
      )}`,
      { cause: error }
    );
  } finally {
    if (!cleanShutdown && child.exitCode === null) {
      child.kill();
      await waitForExit(child, 5_000);
    }
    await rm(profile, { recursive: true, force: true });
  }
};

const main = async () => {
  const benchmarkFlags = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
  ];
  const variants = [
    { name: 'minimal', port: 9230, flags: [] },
    { name: 'benchmark', port: 9231, flags: benchmarkFlags },
    {
      name: 'benchmark-disable-gpu',
      port: 9232,
      flags: [...benchmarkFlags, '--disable-gpu'],
    },
    {
      name: 'benchmark-disable-gpu-sandbox',
      port: 9233,
      flags: [...benchmarkFlags, '--disable-gpu-sandbox'],
    },
    {
      name: 'benchmark-in-process-gpu',
      port: 9234,
      flags: [...benchmarkFlags, '--in-process-gpu'],
    },
    {
      name: 'benchmark-ci-containment',
      port: 9235,
      flags: [...benchmarkFlags, '--disable-gpu', '--no-sandbox'],
    },
    {
      name: 'benchmark-no-sandbox',
      port: 9236,
      flags: [...benchmarkFlags, '--no-sandbox'],
    },
  ];
  const selectedVariants = process.argv.includes('--recovery-only')
    ? variants.slice(-1)
    : variants;
  const results = [];
  for (const variant of selectedVariants) {
    try {
      results.push({
        status: 'passed',
        ...(await runVariant(variant.name, variant.port, variant.flags)),
      });
    } catch (error) {
      results.push({
        name: variant.name,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  assert.equal(
    results.at(-1)?.status,
    'passed',
    'The recovered Chrome launch did not pass'
  );
};

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
