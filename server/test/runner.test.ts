import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = path.resolve(__dirname, '../..');

const executeFixture = (source: string, reporter = 'spec') => {
  const directory = mkdtempSync(path.join(tmpdir(), 'seerr-test-runner-'));
  try {
    const fixture = path.join(directory, 'fixture.cjs');
    writeFileSync(fixture, source);
    const config = path.join(directory, 'config');
    mkdirSync(config);
    const env: NodeJS.ProcessEnv = { ...process.env, CONFIG_DIRECTORY: config };
    // Nested CLI tests are independent runners, not workers of this test file.
    delete env.NODE_TEST_CONTEXT;
    delete env.CI;
    const command = process.env.npm_execpath
      ? [process.env.npm_execpath, 'test']
      : [path.join(root, 'server/test/index.mts')];
    const result = spawnSync(
      process.execPath,
      [...command, fixture, '--test-reporter', reporter],
      {
        cwd: root,
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('application test command exit status', () => {
  it('succeeds when the executed fixture passes', () => {
    const result = executeFixture(`
      const { test } = require('node:test');
      test('fixture passes', () => {});
    `);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /fixture passes/);
    assert.match(result.output, /fail 0/);
  });

  it('fails the validation command when an assertion fails, independently of reporter selection', () => {
    const result = executeFixture(
      `
        const { test } = require('node:test');
        const assert = require('node:assert/strict');
        test('fixture assertion failure', () => assert.fail('controlled failure'));
      `,
      'tap'
    );
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /fixture assertion failure/);
    assert.match(result.output, /fail 1/);
  });

  it('fails the command when a suite setup hook fails', () => {
    const result = executeFixture(`
      const { describe, before, test } = require('node:test');
      describe('fixture hook failure', () => {
        before(() => { throw new Error('controlled hook failure'); });
        test('blocked fixture', () => {});
      });
    `);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /controlled hook failure/);
  });

  it('does not turn explicit skipped or todo tests into genuine failures', () => {
    const result = executeFixture(`
      const { test } = require('node:test');
      test('fixture skipped', { skip: true }, () => { throw new Error('skip'); });
      test('fixture todo', { todo: true }, () => { throw new Error('todo'); });
    `);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /fixture todo/);
    assert.match(result.output, /fail 0/);
  });
});
