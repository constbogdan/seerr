import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('synchronization containment administrator presentation', () => {
  const status = readFileSync(
    path.join(__dirname, 'SynchronizationContainmentStatus.tsx'),
    'utf8'
  );
  const jobs = readFileSync(
    path.join(__dirname, 'SettingsJobsCache/index.tsx'),
    'utf8'
  );
  const historyImport = readFileSync(
    path.join(__dirname, 'SettingsHistoryImport/index.tsx'),
    'utf8'
  );

  it('shows one authoritative status on Jobs and History Import', () => {
    assert.match(status, /settings\/synchronization-containment/);
    assert.match(status, /role="status"/);
    assert.match(status, /role="alert"/);
    assert.match(jobs, /<SynchronizationContainmentStatus \/>/);
    assert.match(historyImport, /<SynchronizationContainmentStatus \/>/);
  });

  it('keeps intrinsic enablement separate from execution containment', () => {
    assert.match(jobs, /scheduledExecutionAllowed: boolean/);
    assert.match(jobs, /manualExecutionAllowed: boolean/);
    assert.match(
      jobs,
      /disabled=\{!job\.enabled \|\| !job\.manualExecutionAllowed\}/
    );
    assert.match(jobs, /Suppressed by synchronization mode/);
  });
});
