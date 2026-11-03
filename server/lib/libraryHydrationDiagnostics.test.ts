import {
  describeHydrationFailure,
  type HydrationDatabaseOperation,
} from '@server/lib/libraryHydrationDiagnostics';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryFailedError } from 'typeorm';

describe('Sanitized Library hydration diagnostics', () => {
  for (const [prefix, category] of [
    ['UNIQUE', 'unique'],
    ['FOREIGN KEY', 'foreign-key'],
    ['NOT NULL', 'not-null'],
    ['CHECK', 'check'],
  ]) {
    it(`classifies ${prefix} without returning constraint names or values`, () => {
      const driver = Object.assign(
        new Error(
          `SQLITE_CONSTRAINT: ${prefix} constraint failed: private-value`
        ),
        { code: 'SQLITE_CONSTRAINT' }
      );
      const error = new QueryFailedError(
        'private SQL',
        ['private parameter'],
        driver
      );
      const diagnostic = describeHydrationFailure(error, 'identity-insert');
      assert.equal(diagnostic.sqliteCode, 'SQLITE_CONSTRAINT');
      assert.equal(diagnostic.constraintCategory, category);
      assert.equal(diagnostic.operation, 'identity-insert');
      assert.doesNotMatch(JSON.stringify(diagnostic), /private/);
    });
  }

  for (const code of [
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'SQLITE_FULL',
    'SQLITE_IOERR',
    'SQLITE_READONLY',
  ]) {
    it(`recognizes ${code}`, () => {
      assert.equal(
        describeHydrationFailure({ driverError: { code } }).sqliteCode,
        code
      );
    });
  }

  it('extracts nested driver errors and cause wrappers', () => {
    const error = new QueryFailedError(
      'secret SQL',
      ['secret token'],
      Object.assign(new Error('wrapper'), {
        driverError: { cause: { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' } },
      })
    );
    const diagnostic = describeHydrationFailure(error);
    assert.equal(diagnostic.sqliteCode, 'SQLITE_CONSTRAINT');
    assert.equal(diagnostic.constraintCategory, 'foreign-key');
  });

  it('recognizes extended codes without confusing bare POSIX errno with SQLite', () => {
    assert.equal(describeHydrationFailure({ errno: 6 }).sqliteCode, 'unknown');
    assert.equal(
      describeHydrationFailure({ code: 'EACCES', errno: 13 }).sqliteCode,
      'unknown'
    );
    const busy = describeHydrationFailure({ code: 'SQLITE_BUSY_SNAPSHOT' });
    assert.equal(busy.sqliteCode, 'SQLITE_BUSY');
    const unique = describeHydrationFailure({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    assert.equal(unique.constraintCategory, 'unique');
  });

  it('does not infer SQLite errors from arbitrary message text', () => {
    const diagnostic = describeHydrationFailure(
      new Error('SQLITE_BUSY: private provider payload')
    );
    assert.equal(diagnostic.sqliteCode, 'unknown');
    assert.equal(diagnostic.constraintCategory, 'none');
    assert.doesNotMatch(diagnostic.failureMessage, /private|provider payload/);
  });

  it('bounds output to 500 characters and allows only known operations and codes', () => {
    const secret = 'credential/private-id?api_key=secret';
    const error = {
      code: secret.repeat(1000),
      message: secret.repeat(1000),
      query: secret,
      parameters: [secret],
      driverError: { code: 'SQLITE_CONSTRAINT', message: secret },
    };
    const diagnostic = describeHydrationFailure(
      error,
      secret as HydrationDatabaseOperation
    );
    assert.equal(diagnostic.operation, 'unknown');
    assert.equal(diagnostic.constraintCategory, 'unknown');
    assert.ok(diagnostic.failureMessage.length <= 500);
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      /credential|api_key|private-id|secret/
    );
  });

  it('handles primitive errors, hostile getters, cycles and excessive nesting safely', () => {
    for (const error of [undefined, null, 'secret', 42])
      assert.equal(describeHydrationFailure(error).sqliteCode, 'unknown');
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('private getter');
        },
      }
    );
    assert.equal(describeHydrationFailure(hostile).sqliteCode, 'unknown');
    const cycle: { driverError?: unknown; cause?: unknown } = {};
    cycle.driverError = cycle;
    cycle.cause = { code: 'SQLITE_BUSY' };
    assert.equal(describeHydrationFailure(cycle).sqliteCode, 'SQLITE_BUSY');
    let deep: unknown = { code: 'SQLITE_LOCKED' };
    for (let index = 0; index < 100; index++) deep = { driverError: deep };
    assert.equal(describeHydrationFailure(deep).sqliteCode, 'unknown');
  });
});
