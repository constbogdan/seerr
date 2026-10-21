import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const tooltip = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');

const directConsumers = [
  '../../Library/LibraryEngagement.tsx',
  '../../Library/LibraryItem.tsx',
  '../../Library/SeriesDetail.tsx',
  '../../TitleCard/index.tsx',
  '../CancelScheduledRemovalButton.tsx',
  '../../Fresh/CandidateDiagnosticsShortcut.tsx',
  '../../Settings/SettingsRemoval/index.tsx',
].map((file) => ({
  file,
  source: readFileSync(path.join(__dirname, file), 'utf8'),
}));

describe('shared Tooltip lazy lifecycle', () => {
  it('mounts usePopperTooltip only inside the active positioned child', () => {
    const positionedStart = tooltip.indexOf('const PositionedTooltip');
    const sharedStart = tooltip.indexOf('const Tooltip =');
    const hook = tooltip.indexOf('usePopperTooltip({', positionedStart);

    assert.ok(positionedStart >= 0);
    assert.ok(hook > positionedStart && hook < sharedStart);
    assert.equal(tooltip.indexOf('usePopperTooltip({', sharedStart), -1);
    assert.match(tooltip, /\{visible && content && \(/);
    assert.match(tooltip, /triggerElement=\{triggerElement\}/);
    assert.match(tooltip, /setTriggerRef\(triggerElement\)/);
  });

  it('keeps positioning resources active-only and cleans delayed work', () => {
    assert.match(tooltip, /trigger: null/);
    assert.match(tooltip, /visible: true/);
    assert.match(
      tooltip,
      /useEffect\(\(\) => cancelPending, \[cancelPending\]\)/
    );
    assert.match(tooltip, /if \(!nextVisible\) deactivate\(\)/);
    assert.match(tooltip, /onMouseEnter: cancelPending/);
    assert.match(tooltip, /onMouseLeave: close/);
  });

  it('preserves pointer, focus, touch, Escape, and accessible labels', () => {
    assert.match(tooltip, /\['hover', 'focus'\]/);
    assert.match(tooltip, /triggerProps\.onPointerEnter/);
    assert.match(tooltip, /event\.pointerType === 'touch'/);
    assert.match(tooltip, /triggerProps\.onFocus/);
    assert.match(tooltip, /matches\(':focus-visible'\)/);
    assert.match(tooltip, /if \(!hasTrigger\('click'\)\)/);
    assert.match(
      tooltip,
      /callChildHandler\('onClick', event\);[\s\S]*?dismiss\(\)/
    );
    assert.match(tooltip, /event\.key === 'Escape'\) dismiss\(\)/);
    assert.match(
      tooltip,
      /removeEventListener\('keydown', handleEscape, true\)/
    );
    assert.match(tooltip, /'aria-label': String\(content\)/);
    assert.match(tooltip, /role: 'tooltip'/);
  });

  it('keeps the audited page families on the shared implementation', () => {
    directConsumers.forEach(({ file, source }) => {
      assert.match(source, /Common\/Tooltip|\.\.\/Common\/Tooltip/, file);
    });

    const leavingSoon = readFileSync(
      path.join(__dirname, '../../LeavingSoon/index.tsx'),
      'utf8'
    );
    assert.match(leavingSoon, /CancelScheduledRemovalButton/);
    assert.match(leavingSoon, /<TitleCard/);
  });
});
