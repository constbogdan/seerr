import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(path.join(__dirname, 'JellyfinIcon.tsx'), 'utf8');

describe('JellyfinIcon', () => {
  it('uses instance-unique gradient identifiers and local references', () => {
    assert.match(source, /useId\(\)\.replaceAll\(':', ''\)/);
    assert.match(source, /id=\{gradientId\}/);
    assert.equal(
      (source.match(/fill=\{`url\(#\$\{gradientId\}\)`\}/g) ?? []).length,
      2
    );
    assert.doesNotMatch(source, /id="(?:icon-transparent|linear-gradient)"/);
  });
});
