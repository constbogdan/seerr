import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Fresh native jobs', () => {
  const schedule = readFileSync(path.join(__dirname, 'schedule.ts'), 'utf8');
  const settings = readFileSync(
    path.join(__dirname, '../lib/settings/index.ts'),
    'utf8'
  );
  const jobsUi = readFileSync(
    path.join(
      __dirname,
      '../../src/components/Settings/SettingsJobsCache/index.tsx'
    ),
    'utf8'
  );

  it('registers sync and reconciliation through the native jobs infrastructure', () => {
    assert.match(schedule, /id: 'fresh-sync'/);
    assert.match(schedule, /name: 'Fresh Sync'/);
    assert.match(schedule, /void freshService\.sync\(\)/);
    assert.match(schedule, /id: 'fresh-reconciliation'/);
    assert.match(schedule, /name: 'Fresh Reconciliation'/);
    assert.match(schedule, /void freshService\.reconcile\(\)/);
    assert.match(schedule, /running: \(\) => freshService\.running\(\)/);
    assert.match(schedule, /cancelFn: \(\) => freshService\.cancel\(\)/);
    assert.match(schedule, /freshService\.startCatchUp\(\)/);
  });

  it('uses the approved native default schedules', () => {
    assert.match(
      settings,
      /'fresh-sync': \{[\s\S]*?schedule: '0 \*\/5 \* \* \* \*'/
    );
    assert.match(
      settings,
      /'fresh-reconciliation': \{[\s\S]*?schedule: '0 15 3 \* \* \*'/
    );
  });

  it('maps both Fresh job identifiers to native display names', () => {
    assert.match(jobsUi, /'fresh-sync': 'Fresh Sync'/);
    assert.match(jobsUi, /'fresh-reconciliation': 'Fresh Reconciliation'/);
    assert.match(jobsUi, /messages\[job\.id\] \?\? messages\.unknownJob/);
  });
});
