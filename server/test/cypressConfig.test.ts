import type { defineConfig } from 'cypress';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

const config = createRequire(__filename)(
  path.join(__dirname, '../../cypress.config.ts')
).default as ReturnType<typeof defineConfig>;

function hooks() {
  const handlers = new Map<string, unknown>();
  const on = (name: string, handler: unknown) => handlers.set(name, handler);
  const e2e = config.e2e;
  assert.ok(e2e && typeof e2e === 'object');
  e2e.setupNodeEvents?.(
    on as Cypress.PluginEvents,
    {} as Cypress.PluginConfigOptions
  );
  return handlers;
}

it('retains provider tasks and browser hooks alongside failure-video handling', () => {
  const handlers = hooks();
  assert.ok(handlers.has('task'));
  assert.ok(handlers.has('before:browser:launch'));
  assert.ok(handlers.has('after:spec'));
  assert.equal(config.expose?.ADMIN_EMAIL, 'admin@seerr.dev');
});

it('preserves a video if any attempt failed, but removes an entirely passing video', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'seerr-cypress-video-'));
  const video = path.join(directory, 'synthetic.mp4');
  const after = hooks().get('after:spec') as (
    spec: object,
    result?: { video?: string; tests: { attempts: { state: string }[] }[] }
  ) => void;
  try {
    writeFileSync(video, 'synthetic');
    after(
      {},
      {
        video,
        tests: [{ attempts: [{ state: 'failed' }, { state: 'passed' }] }],
      }
    );
    assert.ok(existsSync(video));
    after({}, { video, tests: [{ attempts: [{ state: 'passed' }] }] });
    assert.equal(existsSync(video), false);
    after({}, undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
