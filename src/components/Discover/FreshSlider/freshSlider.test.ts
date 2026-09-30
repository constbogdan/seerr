import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// The node:test harness cannot resolve @app imports from its server tsconfig.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import MediaTypeFilter from '../../Common/MediaTypeFilter';
// This leaf component has no @app imports and can be rendered by node:test.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import CandidateDiagnosticsShortcut from '../../Fresh/CandidateDiagnosticsShortcut';

describe('Fresh native pagination integration', () => {
  const slider = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
  const page = readFileSync(
    path.join(__dirname, '../../Fresh/index.tsx'),
    'utf8'
  );
  const mediaSlider = readFileSync(
    path.join(__dirname, '../../MediaSlider/index.tsx'),
    'utf8'
  );

  it('uses the ordinary URL-driven MediaSlider for the Fresh row', () => {
    assert.match(slider, /url=\{FRESH_API_PATH\}/);
    assert.match(slider, /linkUrl="\/fresh"/);
    assert.doesNotMatch(slider, /items=|itemsLoading=|useSWR/);
    assert.match(slider, /hasPermission\(Permission\.ADMIN\)/);
    assert.match(slider, /headerAction=/);
  });

  it('renders the Candidate Diagnostics shortcut only for administrators', () => {
    const admin = renderToStaticMarkup(
      createElement(CandidateDiagnosticsShortcut, { show: true })
    );
    const user = renderToStaticMarkup(
      createElement(CandidateDiagnosticsShortcut, { show: false })
    );
    assert.match(
      admin,
      /href="\/settings\/discovery-sources\/fresh#candidates"/
    );
    assert.match(admin, /aria-label="Candidate Diagnostics"/);
    assert.match(admin, /<svg/);
    assert.doesNotMatch(admin, />Candidate Diagnostics<\/a>/);
    assert.equal(user, '');
    assert.match(page, /hasPermission\(Permission\.ADMIN\)/);
    assert.match(page, /CandidateDiagnosticsShortcut/);
    assert.match(mediaSlider, /className="ml-2 flex items-center"/);
    assert.doesNotMatch(mediaSlider, /className="ml-auto flex items-center"/);
  });

  it('uses useDiscover for the complete paginated Fresh page', () => {
    assert.match(page, /useDiscover</);
    assert.match(page, /FRESH_API_PATH, \{ mediaType, sort \}/);
    assert.match(page, /MediaTypeFilter/);
    assert.match(page, /value: 'all'/);
    assert.match(page, /value: 'movie'/);
    assert.match(page, /value: 'tv'/);
    assert.match(page, /onScrollBottom=\{discover\.fetchMore\}/);
    assert.doesNotMatch(page, /applyFreshView|useSWR/);
  });

  it('renders the shared media icon segment used by the main Fresh page', () => {
    const markup = renderToStaticMarkup(
      createElement(MediaTypeFilter, {
        value: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'movie', label: 'Movies' },
          { value: 'tv', label: 'Series' },
        ],
        onChange: () => undefined,
      })
    );
    const control = markup.match(
      /<div class="flex"><span class="[^"]*shrink-0[^"]*">[\s\S]*?<\/span><select class="[^"]*rounded-r-only[^"]*"[^>]*>/
    );

    assert.ok(control, 'expected an adjacent icon segment and media select');
    assert.match(control[0], /<svg/);
  });

  it('leaves MediaSlider on its standard page query behavior', () => {
    assert.match(mediaSlider, /\$\{url\}\?page=\$\{pageIndex \+ 1\}/);
    assert.match(mediaSlider, /initialSize: 2/);
    assert.doesNotMatch(mediaSlider, /providedItems|itemsLoading/);
  });
});
