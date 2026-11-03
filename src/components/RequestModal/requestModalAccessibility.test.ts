import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const tv = readFileSync(path.join(__dirname, 'TvRequestModal.tsx'), 'utf8');
const collection = readFileSync(
  path.join(__dirname, 'CollectionRequestModal.tsx'),
  'utf8'
);
const movie = readFileSync(
  path.join(__dirname, 'MovieRequestModal.tsx'),
  'utf8'
);
const loadError = readFileSync(
  path.join(__dirname, 'RequestModalLoadError.tsx'),
  'utf8'
);
const wrapper = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');

describe('RequestModal keyboard and loading-error behavior', () => {
  it('uses native buttons for Space and Enter toggle activation', () => {
    [tv, collection].forEach((source) => {
      assert.match(
        source,
        /<button[\s\S]*?type="button"[\s\S]*?role="checkbox"/
      );
      assert.match(source, /disabled=\{/);
      assert.doesNotMatch(source, /e\.key === 'Space'/);
      assert.doesNotMatch(source, /event\.key === 'Space'/);
    });
  });

  it('renders a retryable load error instead of an availability conclusion', () => {
    [movie, tv, collection].forEach((source) => {
      assert.match(source, /error \|\| quotaError/);
      assert.match(source, /<RequestModalLoadError/);
      assert.match(source, /onRetry=\{\(\) => void retryLoad\(\)\}/);
    });
    assert.match(loadError, /Unable to load authoritative availability/);
    assert.match(loadError, /okDisabled=\{retrying\}/);
    assert.match(loadError, /backgroundClickable=\{!retrying\}/);
  });

  it('preserves the original trigger across error-to-loaded modal replacement', () => {
    assert.match(wrapper, /const returnFocusRef = useRef<HTMLElement \| null>/);
    assert.match(wrapper, /afterLeave=\{\(\) => \{/);
    assert.match(
      wrapper,
      /returnFocusRef\.current\.focus\(\{ preventScroll: true \}\)/
    );
  });
});
