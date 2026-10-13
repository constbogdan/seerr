import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LibraryIndividualActionCoordinator } from './libraryIndividualActionCoordinator';

describe('Library individual action coordination', () => {
  it('rejects a duplicate action for one target until ownership is released', () => {
    const coordinator = new LibraryIndividualActionCoordinator();
    const first = coordinator.begin('target');
    assert.ok(first);
    assert.equal(coordinator.begin('target'), null);
    assert.equal(coordinator.finish(first), true);
    assert.ok(coordinator.begin('target'));
  });

  it('allows unrelated Season targets to proceed independently', () => {
    const coordinator = new LibraryIndividualActionCoordinator();
    const seasonOne = coordinator.begin('season:1');
    const seasonTwo = coordinator.begin('season:2');
    assert.ok(seasonOne);
    assert.ok(seasonTwo);
    assert.equal(coordinator.owns(seasonOne), true);
    assert.equal(coordinator.owns(seasonTwo), true);
  });

  it('fences late completion after target invalidation or unmount', () => {
    const coordinator = new LibraryIndividualActionCoordinator();
    const stale = coordinator.begin('target');
    assert.ok(stale);
    coordinator.invalidate();
    assert.equal(coordinator.owns(stale), false);
    assert.equal(coordinator.finish(stale), false);
    assert.ok(coordinator.begin('target'));
  });
});
