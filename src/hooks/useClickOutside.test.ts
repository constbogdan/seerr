import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(path.join(__dirname, 'useClickOutside.ts'), 'utf8');

describe('useClickOutside', () => {
  it('removes the body listener with the same capture option used to add it', () => {
    assert.match(
      source,
      /addEventListener\('click', handleBodyClick, \{ capture: true \}\)/
    );
    assert.match(
      source,
      /removeEventListener\('click', handleBodyClick, \{\s*capture: true,?\s*\}\)/
    );
  });
});
