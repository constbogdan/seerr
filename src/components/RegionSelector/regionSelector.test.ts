import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('RegionSelector hydration stability', () => {
  const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');

  it('uses server-provided English names for hydration before client localization', () => {
    assert.match(
      source,
      /clientDisplayNamesReady\s*\?\s*\(intl\.formatDisplayName[\s\S]*?: region\.english_name/
    );
    assert.match(
      source,
      /useEffect\(\(\) => setClientDisplayNamesReady\(true\)/
    );
    assert.doesNotMatch(source, /regions\?\.forEach/);
  });
});
