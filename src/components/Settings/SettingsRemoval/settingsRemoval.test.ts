import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_REMOVAL_SETTINGS } from '@server/constants/removal';
import {
  newlyEnabledRemovalPolicies,
  normalizeRemovalThresholds,
  revertNewlyEnabledRemovalPolicies,
} from './helpers';

describe('Removal Settings interaction structure', () => {
  const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
  const routeSource = readFileSync(
    path.join(__dirname, '../../../../server/routes/settings/removal.ts'),
    'utf8'
  );
  const policySource = readFileSync(
    path.join(__dirname, 'RemovalPolicyEditor.tsx'),
    'utf8'
  );
  const slideCheckboxSource = readFileSync(
    path.join(__dirname, '../../Common/SlideCheckbox/index.tsx'),
    'utf8'
  );
  const badgeSource = readFileSync(
    path.join(__dirname, '../../Common/Badge/index.tsx'),
    'utf8'
  );

  it('debounces a non-mutating preview from current form values', () => {
    assert.match(source, /setTimeout\(\(\) => \{/);
    assert.match(source, /\/api\/v1\/settings\/removal\/preview/);
    assert.match(source, /}, 400\)/);
    assert.match(
      routeSource,
      /routes\.post\('\/preview'[\s\S]*removalScheduler\.preview\(proposed\)/
    );
    assert.match(source, /removalSettingsFingerprint\(values\)/);
    assert.match(source, /isCurrentRemovalPreviewRequest\(/);
    assert.match(source, /currentRemovalPreview\(previewState, values\)/);
  });

  it('preserves dirty drafts and requires explicit remote-conflict resolution', () => {
    assert.match(source, /reconcileRemovalDraft\(/);
    assert.match(source, /reconciliation\.type === 'remote-conflict'/);
    assert.match(source, /messages\.useServerSettings/);
    assert.match(source, /messages\.keepMyEdits/);
    assert.match(
      source,
      /disabled=\{clearing \|\| saving \|\| Boolean\(remoteValues\) \|\| !dirty\}/
    );
  });

  it('fences duplicate Save and preserves newer edits after an older response', () => {
    assert.match(
      source,
      /if \(saveRequestRef\.current \|\| remoteValues\) return/
    );
    assert.match(source, /saveRequestRef\.current = true/);
    assert.match(
      source,
      /removalSettingsFingerprint\(valuesRef\.current\) === submittedFingerprint/
    );
    assert.match(source, /messages\.saveRefreshFailed/);
  });

  it('keeps the zero-schedule Clear path render-safe with a ref-capable tooltip trigger', () => {
    assert.match(
      source,
      /<Tooltip content=\{intl\.formatMessage\(messages\.clearDescription\)\}>\s*<Badge/
    );
    assert.match(
      source,
      /className="h-6 w-6 items-center justify-center !px-0"/
    );
    assert.match(source, /preview\?\.actionableScheduleCount \?\? 0/);
    assert.match(
      source,
      /!previewIsActionable[\s\S]*\(preview\?\.actionableScheduleCount \?\? 0\) === 0/
    );
    assert.match(badgeSource, /React\.forwardRef\(Badge\)/);
  });

  it('uses bounded inline month dropdowns without the superseded timeline', () => {
    assert.equal((policySource.match(/<select/g) ?? []).length, 3);
    assert.match(policySource, /maximumSelectableMonths/);
    assert.match(policySource, /Older than/);
    assert.match(policySource, /No activity in/);
    assert.equal(
      (policySource.match(/className="short(?: flex-none)?"/g) ?? []).length,
      3
    );
    assert.doesNotMatch(policySource, /role="slider"/);
    assert.doesNotMatch(policySource, /onPointerMove/);
    assert.doesNotMatch(policySource, /Timeline/);
  });

  it('clamps obsolete persisted thresholds to the factual current-library bound', () => {
    const settings = structuredClone(DEFAULT_REMOVAL_SETTINGS);
    settings.movie.minimumAgeMonths = 200;
    settings.movie.inactivityMonths = 199;
    settings.series.minimumAgeMonths = 180;
    settings.series.inactivityMonths = 179;
    const preview = {
      movie: {
        eligibleUnscheduled: 0,
        itemsPerRun: 0,
        oldestCurrentAddedAt: null,
        maximumSelectableMonths: 12,
        candidates: [],
      },
      series: {
        eligibleUnscheduled: 0,
        itemsPerRun: 0,
        oldestCurrentAddedAt: null,
        maximumSelectableMonths: 24,
        candidates: [],
      },
    };

    const normalized = normalizeRemovalThresholds(settings, preview);
    assert.equal(normalized.movie.minimumAgeMonths, 12);
    assert.equal(normalized.movie.inactivityMonths, 12);
    assert.equal(normalized.series.minimumAgeMonths, 24);
    assert.equal(normalized.series.inactivityMonths, 24);
  });

  it('keeps native Jobs as the only cadence, Edit, and Run Now surface', () => {
    assert.match(source, /removalScanEnabled: 'Removal Scan'/);
    assert.match(source, /removalProcessingEnabled: 'Removal Processing'/);
    assert.doesNotMatch(source, /href="\/settings\/jobs"/);
    assert.doesNotMatch(source, /intervalDays/);
    assert.doesNotMatch(source, /nextRunAt/);
    assert.doesNotMatch(source, /candidate-selection\/run/);
    assert.doesNotMatch(source, /scheduled-removal-processing\/run/);
  });

  it('renders native settings rows and responsive Movie and Series cards', () => {
    assert.equal((source.match(/<section/g) ?? []).length, 2);
    assert.match(
      source,
      /grid grid-cols-1 items-start gap-6 sm:grid-cols-\[minmax\(0,27\.25rem\)\] xl:grid-cols-\[repeat\(2,minmax\(0,27\.25rem\)\)\]/
    );
    assert.doesNotMatch(source, /xl:max-w-4xl/);
    assert.doesNotMatch(source, /Removal Configuration/);
    assert.doesNotMatch(source, /Movie & Series Configuration/);
    assert.match(source, /className="form-row"/);
    assert.match(policySource, /rounded-lg bg-gray-800/);
    assert.match(policySource, /flex items-center gap-3/);
  });

  it('offers only the accepted countdown values', () => {
    assert.match(source, /countdownLabel: 'Removal Grace Period'/);
    assert.match(source, /\[10, 20, 30, 60, 90\] as const/);
    assert.match(source, /REMOVAL_DELAY_OPTIONS\.map/);
    assert.match(source, /id="removalDelayDays"[\s\S]*className="short"/);
    assert.equal(DEFAULT_REMOVAL_SETTINGS.removalDelayDays, 60);
  });

  it('orders Processing, Scan, then Removal Grace Period', () => {
    const sectionStart = source.indexOf('<section className="section">');
    const section = source.slice(
      sectionStart,
      source.indexOf('</section>', sectionStart)
    );
    assert.ok(
      section.indexOf('messages.removalProcessingEnabled') <
        section.indexOf('messages.removalScanEnabled')
    );
    assert.ok(
      section.indexOf('messages.removalScanEnabled') <
        section.indexOf('messages.countdownLabel')
    );
  });

  it('uses native toggle switches for all four boolean controls', () => {
    assert.equal((source.match(/<SlideCheckbox/g) ?? []).length, 2);
    assert.equal((policySource.match(/<SlideCheckbox/g) ?? []).length, 1);
    assert.doesNotMatch(source, /type="checkbox"/);
    assert.doesNotMatch(policySource, /type="checkbox"/);
    assert.match(slideCheckboxSource, /aria-checked=\{checked\}/);
  });

  it('uses one Items per run control with an exact ordered candidate expansion', () => {
    assert.match(policySource, /eligibleUnscheduled/);
    assert.match(policySource, /policy\.itemsPerRun/);
    assert.match(policySource, /ITEMS_PER_RUN_OPTIONS/);
    assert.match(policySource, /className="short flex-none"/);
    assert.doesNotMatch(policySource, /type="number"/);
    assert.match(policySource, /eligibleCount: '\{count\} eligible'/);
    assert.match(policySource, /InformationCircleIcon/);
    assert.match(policySource, /Sorted by Last active, oldest first\./);
    assert.match(policySource, /preview\.candidates\.map/);
    assert.match(policySource, /CalendarDaysIcon/);
    assert.match(policySource, /ClockIcon/);
    assert.match(policySource, /factualDaysAgo/);
    assert.match(policySource, /parseFactualDate/);
    assert.doesNotMatch(policySource, /Math\.floor/);
  });

  it('requires confirmation only for disabled-to-enabled transitions', () => {
    const saved = structuredClone(DEFAULT_REMOVAL_SETTINGS);
    const ordinaryEdit = structuredClone(saved);
    ordinaryEdit.movie.minimumAgeMonths += 1;
    assert.deepEqual(newlyEnabledRemovalPolicies(saved, ordinaryEdit), []);

    const movieEnabled = structuredClone(ordinaryEdit);
    movieEnabled.movie.enabled = true;
    assert.deepEqual(newlyEnabledRemovalPolicies(saved, movieEnabled), [
      'movie',
    ]);

    const bothEnabled = structuredClone(movieEnabled);
    bothEnabled.series.enabled = true;
    assert.deepEqual(newlyEnabledRemovalPolicies(saved, bothEnabled), [
      'movie',
      'series',
    ]);
    assert.match(source, /Enable automatic Movie and Series scheduling\?/);
    assert.match(source, /currently qualify/);
    assert.match(source, /would enter Leaving Soon/);
    assert.match(source, /Removal delay/);
    assert.match(source, /Activity during the countdown cancels/);
  });

  it('reverts only newly enabled toggles when confirmation is cancelled', () => {
    const proposed = structuredClone(DEFAULT_REMOVAL_SETTINGS);
    proposed.movie.enabled = true;
    proposed.series.enabled = true;
    proposed.movie.minimumAgeMonths = 12;

    const reverted = revertNewlyEnabledRemovalPolicies(proposed, [
      'movie',
      'series',
    ]);
    assert.equal(reverted.movie.enabled, false);
    assert.equal(reverted.series.enabled, false);
    assert.equal(reverted.movie.minimumAgeMonths, 12);
    assert.equal(proposed.movie.enabled, true);
    assert.match(source, /revertNewlyEnabledRemovalPolicies/);
  });

  it('keeps one counted clear action explicitly non-media-destructive', () => {
    assert.match(source, /actionableScheduleCount/);
    assert.match(source, /Clear \{count, plural/);
    assert.match(source, /\(preview\?\.actionableScheduleCount \?\? 0\) === 0/);
    assert.equal(
      (
        source.match(/Cancels all pending removals\. No media is removed\./g) ??
        []
      ).length,
      1
    );
    assert.match(
      source,
      /className="actions"[\s\S]*<Tooltip content=\{intl\.formatMessage\(messages\.clearDescription\)\}>[\s\S]*badgeType="warning"[\s\S]*InformationCircleIcon[\s\S]*<Button[\s\S]*setClearPreviewFingerprint\(valuesFingerprint\)[\s\S]*setShowClearConfirmation\(true\)[\s\S]*messages\.save/
    );
    assert.match(source, /\/api\/v1\/settings\/removal\/clear/);
    assert.match(
      routeSource,
      /routes\.post\('\/clear'[\s\S]*clearAllScheduledRemovals/
    );
  });

  it('opens and cancels the native Clear scheduled items confirmation modal', () => {
    assert.match(source, /clearTitle: 'Clear scheduled items\?'/);
    assert.match(
      source,
      /This will cancel all pending Movie, Series, and Season removal schedules and clear Leaving Soon\. No media will be removed\./
    );
    assert.match(
      source,
      /cancelText=\{intl\.formatMessage\(globalMessages\.cancel\)\}/
    );
    assert.match(
      source,
      /onCancel=\{\(\) => \{\s*if \(!clearing\) \{\s*setShowClearConfirmation\(false\);\s*setClearPreviewFingerprint\(null\);\s*\}\s*\}\}/
    );
  });

  it('confirms through the existing destructive Clear operation without a native dialog', () => {
    assert.match(source, /okButtonType="danger"/);
    assert.match(source, /onOk=\{clearScheduledItems\}/);
    assert.match(source, /\/api\/v1\/settings\/removal\/clear/);
    assert.doesNotMatch(
      source,
      /window\.confirm\(intl\.formatMessage\(messages\.clearConfirmation\)\)/
    );
  });

  it('uses the factual actionable count in the modal destructive action', () => {
    assert.match(
      source,
      /okText=\{[\s\S]*messages\.clearItems,[\s\S]*count: preview\?\.actionableScheduleCount \?\? 0/
    );
  });

  it('prevents duplicate Clear submission while the request is running', () => {
    assert.match(
      source,
      /clearRequestRef\.current[\s\S]*clearRequestRef\.current = true;[\s\S]*setClearing\(true\)/
    );
    assert.match(
      source,
      /okDisabled=\{[\s\S]*!clearPreviewIsCurrent[\s\S]*\(preview\?\.actionableScheduleCount \?\? 0\) === 0/
    );
    assert.match(source, /cancelButtonProps=\{\{ disabled: clearing \}\}/);
    assert.match(source, /backgroundClickable=\{!clearing\}/);
  });

  it('uses the same native row spacing for Processing, Scan, and Grace Period', () => {
    assert.match(
      source,
      /messages\.removalProcessingEnabled[\s\S]*<div className="form-row">[\s\S]*messages\.removalScanEnabled[\s\S]*<div className="form-row">[\s\S]*htmlFor="removalDelayDays"/
    );
    assert.doesNotMatch(
      source,
      /messages\.removalProcessingEnabled[\s\S]*className="mt-6 pt-1"[\s\S]*messages\.removalScanEnabled/
    );
    assert.doesNotMatch(
      source,
      /className="mt-6 border-t border-gray-700 pt-1"/
    );
  });

  it('uses the native Advanced badge with the Jobs tooltip', () => {
    assert.match(source, /<SettingsBadge/);
    assert.match(source, /badgeType="advanced"/);
    assert.match(
      source,
      /Job frequency and manual runs are managed in Jobs & Cache\./
    );
  });
});
