import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { invalidLeavingSoonPage } from './pagination';

describe('Leaving Soon pagination reconciliation', () => {
  it('clamps only when an authoritative result proves the page is invalid', () => {
    assert.equal(invalidLeavingSoonPage(3, 2), 2);
    assert.equal(invalidLeavingSoonPage(3, 3), null);
    assert.equal(invalidLeavingSoonPage(2, 4), null);
  });

  it('uses page one when the refreshed result has no pages', () => {
    assert.equal(invalidLeavingSoonPage(2, 0), 1);
    assert.equal(invalidLeavingSoonPage(1, 0), null);
  });
});
