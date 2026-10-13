import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');

describe('historical import status presentation', () => {
  it('separates observed range from historical completeness', () => {
    assert.match(
      source,
      /observedRange: 'Observed historical range: \{range\}'/
    );
    assert.match(
      source,
      /completeness: 'Historical completeness: not asserted'/
    );
    assert.match(source, /completenessShort: '\(completeness not asserted\)'/);
    assert.match(source, /validation\.disposition/);
  });

  it('localizes status labels, counts, and dates', () => {
    assert.match(
      source,
      /defineMessages\('components\.Settings\.SettingsHistoryImport'/
    );
    assert.match(source, /intl\.formatDate\(value\.startedAt/);
    assert.match(source, /count: '\{label\}: \{count, number\}'/);
    assert.doesNotMatch(source, /\.toLocaleString\(\)/);
  });

  it('does not enable import for a valid but non-importable inspection', () => {
    assert.match(source, /!validation\?\.importable/);
    assert.doesNotMatch(source, /!validation\?\.valid \|\| busy/);
  });
});
