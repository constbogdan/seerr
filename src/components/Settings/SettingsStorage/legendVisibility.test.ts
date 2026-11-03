import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { shouldShowCategoryLegend } from './legendVisibility';

describe('Storage category legend visibility', () => {
  it('hides only confirmed zero-byte categories', () => {
    assert.equal(shouldShowCategoryLegend('0'), false);
    assert.equal(shouldShowCategoryLegend('000'), false);
  });

  it('keeps positive category usage visible', () => {
    assert.equal(shouldShowCategoryLegend('1'), true);
    assert.equal(shouldShowCategoryLegend('1099511627776'), true);
  });

  it('keeps unknown or malformed category usage visible', () => {
    assert.equal(shouldShowCategoryLegend(null), true);
    assert.equal(shouldShowCategoryLegend('unknown'), true);
  });
});
