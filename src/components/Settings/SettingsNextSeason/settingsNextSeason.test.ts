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
  it('provides an administrator-only enabled-state control inline with the heading', () => {
    assert.match(page, /useRouteGuard\(Permission\.ADMIN\)/);
    assert.match(source, /title: 'Next Season Automation'/);
    assert.match(
      source,
      /<h3 className="heading min-w-0">[\s\S]*<SlideCheckbox/
    );
    assert.match(source, /<SlideCheckbox/);
    assert.match(source, /next-season\/enabled/);
    assert.match(source, /configurableEnabled/);
    assert.doesNotMatch(source, /className="form-row"/);
    assert.doesNotMatch(source, /enableDescription|requestOwner/);
  });

  it('loads the read-only Upcoming evaluation independently of enabled state', () => {
    assert.match(source, /next-season\/dry-run/);
    assert.match(source, /axios\.post<NextSeasonUpcomingSummary>/);
    assert.match(source, /upcomingRefreshing \|\| job\.running/);
    assert.doesNotMatch(source, /upcomingRefreshing \|\| !job\.enabled/);
    assert.match(source, /upcoming\.failed > 0/);
    assert.match(source, /messages\.noUpcoming/);
    assert.match(source, /role="alert"/);
  });

  it('uses the concise user-facing automation description', () => {
    assert.match(
      source,
      /Automatically request the next season when the current season viewing progress reaches 70% within the last 24 hours\./
    );
  });

  it('uses an accessible icon-only Upcoming refresh control beside the heading', () => {
    assert.match(
      source,
      /<h4[\s\S]*messages\.upcoming[\s\S]*<Tooltip content=\{intl\.formatMessage\(messages\.refresh\)\}>/
    );
    assert.match(
      source,
      /aria-label=\{intl\.formatMessage\(messages\.refresh\)\}/
    );
    assert.match(source, /<ArrowPathIcon/);
    assert.match(source, /aria-busy=\{upcomingRefreshing\}/);
    assert.doesNotMatch(
      source,
      />\s*\{intl\.formatMessage\(messages\.refresh\)\}\s*<\/Button>/
    );
  });

  it('uses the shared dark Table with linked Series and explicit activity states', () => {
    assert.match(source, /<Table>/);
    assert.match(source, /href=\{row\.href\}/);
    assert.match(source, /row\.seriesTitle/);
    assert.match(source, /row\.lastWatchedAt/);
    assert.match(source, /bg-gray-800/);
    assert.match(source, /role="status"/);
    assert.match(source, /role="alert"/);
  });
});
