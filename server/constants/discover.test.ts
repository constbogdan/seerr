import { defaultSliders, DiscoverSliderType } from '@server/constants/discover';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Discover slider defaults', () => {
  it('places Fresh first and keeps it in the normal built-in registry', () => {
    assert.equal(defaultSliders[0].type, DiscoverSliderType.FRESH);
    assert.equal(defaultSliders[0].order, 0);
    assert.equal(defaultSliders[0].enabled, true);
    assert.equal(defaultSliders[0].isBuiltIn, true);
    assert.equal(defaultSliders[1].type, DiscoverSliderType.RECENTLY_ADDED);
    assert.deepEqual(
      defaultSliders.map(({ order }) => order),
      defaultSliders.map((_slider, index) => index)
    );
  });
});
