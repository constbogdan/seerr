import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
const page = readFileSync(
  path.join(
    __dirname,
    '..',
    '..',
    '..',
    'pages',
    'settings',
    'next-season.tsx'
  ),
  'utf8'
);

describe('Next Season settings presentation', () => {
  it('provides an administrator-only enabled-state control', () => {
    assert.match(page, /useRouteGuard\(Permission\.ADMIN\)/);
    assert.match(source, /<SlideCheckbox/);
    assert.match(source, /next-season\/enabled/);
    assert.match(source, /configurableEnabled/);
  });

  it('offers a read-only dry run independently of enabled state', () => {
    assert.match(source, /next-season\/dry-run/);
    assert.match(source, /dryRunning \|\| job\.running/);
    assert.doesNotMatch(source, /dryRunning \|\| !job\.enabled/);
  });

  it('explains the shared automatic-request owner', () => {
    assert.match(
      source,
      /administrator configured as the Watchlist Roulette request owner/
    );
  });
});
