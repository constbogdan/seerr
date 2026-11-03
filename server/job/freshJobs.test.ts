import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Fresh V2 native job registration', () => {
  const schedule = readFileSync(path.join(__dirname, 'schedule.ts'), 'utf8');
  const settings = readFileSync(
    path.join(__dirname, '../lib/settings/index.ts'),
    'utf8'
  );
  it('registers one guarded sync with normal lifecycle controls', () => {
    assert.equal((schedule.match(/id: 'fresh-sync'/g) ?? []).length, 1);
    assert.match(schedule, /scheduleGuardedJob\('fresh-sync'/);
    assert.match(schedule, /running: \(\) => freshService.running\(\)/);
    assert.match(schedule, /cancelFn: \(\) => freshService.cancel\(\)/);
    assert.ok(settings.includes("schedule: '0 */5 * * * *'"));
    assert.doesNotMatch(schedule + settings, /fresh-reconciliation/);
  });
});
