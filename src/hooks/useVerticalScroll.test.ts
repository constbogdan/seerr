import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(
  path.join(__dirname, 'useVerticalScroll.ts'),
  'utf8'
);

describe('useVerticalScroll lifecycle', () => {
  it('keeps callback state current without rebuilding the debounced listener', () => {
    assert.match(source, /const callbackRef = useRef\(callback\)/);
    assert.match(source, /const shouldFetchRef = useRef\(shouldFetch\)/);
    assert.match(source, /callbackRef\.current = callback/);
    assert.match(source, /shouldFetchRef\.current = shouldFetch/);
    assert.match(
      source,
      /const debouncedCallback = useMemo\([\s\S]*?debounce\(runCallback, 50\)[\s\S]*?\[runCallback\]/
    );
    assert.match(source, /\}, \[debouncedCallback\]\);/);
  });

  it('cancels every delayed callback when the hook unmounts', () => {
    assert.match(
      source,
      /removeEventListener\('scroll', onScroll\)[\s\S]*?removeEventListener\('resize', onResize\)[\s\S]*?debouncedCallback\.cancel\(\)[\s\S]*?clearTimeout\(scrollingTimer\.current\)/
    );
  });

  it('preserves the established threshold and bottom buffer', () => {
    assert.match(source, /const BUFFER_HEIGHT = 200/);
    assert.match(source, /const IS_SCROLLING_CHECK_THROTTLE = 200/);
    assert.match(
      source,
      /document\.documentElement\.offsetHeight - BUFFER_HEIGHT/
    );
  });
});
