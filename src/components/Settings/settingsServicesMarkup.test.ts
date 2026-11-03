import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const overrideRuleTiles = readFileSync(
  path.join(__dirname, 'OverrideRule/OverrideRuleTiles.tsx'),
  'utf8'
);

describe('Services settings markup', () => {
  it('uses stable Override Rule keys and valid phrasing-content markup', () => {
    assert.match(overrideRuleTiles, /key=\{`override-rule-\$\{rule\.id\}`\}/);
    for (const keyPattern of [
      /key=\{`override-rule-\$\{rule\.id\}-user-/,
      /key=\{`override-rule-\$\{rule\.id\}-genre-/,
      /key=\{`override-rule-\$\{rule\.id\}-language-/,
      /key=\{`override-rule-\$\{rule\.id\}-keyword-/,
      /key=\{`override-rule-\$\{rule\.id\}-tag-/,
    ]) {
      assert.match(overrideRuleTiles, keyPattern);
    }
    assert.doesNotMatch(
      overrideRuleTiles,
      /<div className="inline-flex gap-2">/
    );
    assert.match(overrideRuleTiles, /<span className="inline-flex gap-2">/);
  });
});
