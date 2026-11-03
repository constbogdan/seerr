import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { normalizeRemovalJobSchedules } from '@server/lib/settings';

describe('Removal native jobs', () => {
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

  it('registers independent native-cadence scan and processing jobs', () => {
    assert.match(schedule, /id: 'removal-candidate-selection'/);
    assert.match(schedule, /name: 'Removal Scan'/);
    assert.match(schedule, /interval: 'days'/);
    assert.match(schedule, /startRemovalScan\(\)/);
    assert.match(schedule, /isCandidateSelectionRunning\(\)/);
    assert.match(schedule, /id: 'scheduled-removal-processing'/);
    assert.match(schedule, /name: 'Removal Processing'/);
    assert.match(schedule, /startRemovalProcessing\(\)/);
    assert.match(schedule, /isScheduledRemovalProcessingRunning\(\)/);
    assert.match(schedule, /enabled: \(\) => removalJobEnabled\('scan'\)/);
    assert.match(
      schedule,
      /enabled: \(\) => removalJobEnabled\('processing'\)/
    );
    assert.doesNotMatch(schedule, /configuredNextRemovalRun/);
    assert.doesNotMatch(schedule, /settingsRoute: '\/settings\/removal'/);
    assert.doesNotMatch(schedule, /id: 'removal-schedule-evaluation'/);
    assert.match(
      settings,
      /'removal-candidate-selection': \{\s*schedule: '0 0 1 \*\/14 \* \*'/
    );
    assert.match(
      settings,
      /'scheduled-removal-processing': \{\s*schedule: '0 30 1 \* \* \*'/
    );
  });

  it('provides localized names and descriptions instead of Unknown Job', () => {
    assert.match(jobsUi, /'removal-candidate-selection': 'Removal Scan'/);
    assert.match(jobsUi, /'removal-candidate-selection-description':/);
    assert.match(
      jobsUi,
      /'scheduled-removal-processing': 'Removal Processing'/
    );
    assert.match(jobsUi, /'scheduled-removal-processing-description':/);
    assert.match(jobsUi, /Finds media eligible for scheduled removal\./);
    assert.match(
      jobsUi,
      /Processes scheduled removals when their deadlines arrive\./
    );
    assert.match(jobsUi, /\[1, 2, 3, 4, 5, 6, 7, 10, 14, 21, 30\]/);
    assert.match(
      jobsUi,
      /disabled=\{!job\.enabled \|\| !job\.manualExecutionAllowed\}/
    );
  });

  it('migrates only the rejected temporary Removal job schedules', () => {
    const jobs = {
      'removal-candidate-selection': { schedule: '0 * * * * *' },
      'scheduled-removal-processing': { schedule: '30 * * * * *' },
    } as Parameters<typeof normalizeRemovalJobSchedules>[0];

    assert.deepEqual(normalizeRemovalJobSchedules(jobs), {
      'removal-candidate-selection': { schedule: '0 0 1 */14 * *' },
      'scheduled-removal-processing': { schedule: '0 30 1 * * *' },
    });
    assert.deepEqual(
      normalizeRemovalJobSchedules({
        ...jobs,
        'removal-candidate-selection': { schedule: '0 0 1 */30 * *' },
      }),
      {
        'removal-candidate-selection': { schedule: '0 0 1 */30 * *' },
        'scheduled-removal-processing': { schedule: '0 30 1 * * *' },
      }
    );
    assert.equal(
      (settings.match(/this\.data\.removal = normalizeRemovalSettings/g) ?? [])
        .length,
      2
    );
  });
});
