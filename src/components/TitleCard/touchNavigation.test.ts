import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeCardPointerType,
  shouldRevealTitleCard,
} from './touchNavigation';

describe('TitleCard touch navigation', () => {
  it('reveals details for the first touch or pen activation', () => {
    for (const pointerType of ['touch', 'pen'] as const) {
      assert.equal(
        shouldRevealTitleCard({
          pointerType,
          isTouchEnvironment: true,
          isDetailVisible: false,
          isKeyboardActivation: false,
        }),
        true
      );
    }
  });

  it('allows a subsequent activation after details are visible', () => {
    assert.equal(
      shouldRevealTitleCard({
        pointerType: 'touch',
        isTouchEnvironment: true,
        isDetailVisible: true,
        isKeyboardActivation: false,
      }),
      false
    );
  });

  it('preserves mouse and keyboard navigation on touch-capable devices', () => {
    for (const interaction of [
      { pointerType: 'mouse' as const, isKeyboardActivation: false },
      { pointerType: 'unknown' as const, isKeyboardActivation: true },
    ]) {
      assert.equal(
        shouldRevealTitleCard({
          ...interaction,
          isTouchEnvironment: true,
          isDetailVisible: false,
        }),
        false
      );
    }
  });

  it('falls back to the touch environment when pointer metadata is absent', () => {
    assert.equal(
      shouldRevealTitleCard({
        pointerType: normalizeCardPointerType(''),
        isTouchEnvironment: true,
        isDetailVisible: false,
        isKeyboardActivation: false,
      }),
      true
    );
  });
});
