import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

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
  });

  it('uses useDiscover for the complete paginated Fresh page', () => {
    assert.match(page, /useDiscover</);
    assert.match(page, /FRESH_API_PATH, \{ mediaType, sort \}/);
    assert.match(page, /onScrollBottom=\{discover\.fetchMore\}/);
    assert.doesNotMatch(page, /applyFreshView|useSWR/);
  });

  it('leaves MediaSlider on its standard page query behavior', () => {
    assert.match(mediaSlider, /\$\{url\}\?page=\$\{pageIndex \+ 1\}/);
    assert.match(mediaSlider, /initialSize: 2/);
    assert.doesNotMatch(mediaSlider, /providedItems|itemsLoading/);
  });
});
