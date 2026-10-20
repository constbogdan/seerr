import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  beginCardPointerGesture,
  beginCardTouchFallbackGesture,
  cancelCardNavigationGesture,
  consumeCardNavigationClick,
  createCardNavigationGesture,
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

  it('suppresses Android Chrome compatibility click after focus reveals details', () => {
    let isDetailVisible = false;
    let gesture = beginCardPointerGesture({
      pointerType: 'touch',
      isTouchEnvironment: true,
      isDetailVisible,
    });

    assert.equal(gesture.suppressClick, true);

    // Android then emits touchstart/focus before the compatibility click.
    // The render caused by focus must not turn this into a second activation.
    isDetailVisible = true;
    gesture = beginCardTouchFallbackGesture({
      gesture,
      isTouchEnvironment: true,
      isDetailVisible,
    });
    assert.equal(
      consumeCardNavigationClick({
        gesture,
        isTouchEnvironment: true,
        isDetailVisible,
        isKeyboardActivation: false,
      }),
      true
    );

    gesture = beginCardPointerGesture({
      pointerType: 'touch',
      isTouchEnvironment: true,
      isDetailVisible,
    });
    assert.equal(
      consumeCardNavigationClick({
        gesture,
        isTouchEnvironment: true,
        isDetailVisible,
        isKeyboardActivation: false,
      }),
      false
    );
  });

  it('suppresses the first iOS-style touch click and allows the second', () => {
    let isDetailVisible = false;
    let gesture = beginCardTouchFallbackGesture({
      gesture: createCardNavigationGesture(),
      isTouchEnvironment: true,
      isDetailVisible,
    });

    isDetailVisible = true;
    assert.equal(
      consumeCardNavigationClick({
        gesture,
        isTouchEnvironment: true,
        isDetailVisible,
        isKeyboardActivation: false,
      }),
      true
    );

    gesture = beginCardTouchFallbackGesture({
      gesture: createCardNavigationGesture(),
      isTouchEnvironment: true,
      isDetailVisible,
    });
    assert.equal(
      consumeCardNavigationClick({
        gesture,
        isTouchEnvironment: true,
        isDetailVisible,
        isKeyboardActivation: false,
      }),
      false
    );
  });

  it('never lets stale touch state block mouse or keyboard activation', () => {
    const firstTouch = beginCardPointerGesture({
      pointerType: 'touch',
      isTouchEnvironment: true,
      isDetailVisible: false,
    });
    const mouseGesture = beginCardPointerGesture({
      pointerType: 'mouse',
      isTouchEnvironment: true,
      isDetailVisible: true,
    });

    assert.equal(firstTouch.suppressClick, true);
    assert.equal(
      consumeCardNavigationClick({
        gesture: mouseGesture,
        isTouchEnvironment: true,
        isDetailVisible: true,
        isKeyboardActivation: false,
      }),
      false
    );
    assert.equal(
      consumeCardNavigationClick({
        gesture: firstTouch,
        isTouchEnvironment: true,
        isDetailVisible: false,
        isKeyboardActivation: true,
      }),
      false
    );
  });

  it('suppresses any compatibility click after a cancelled touch scroll', () => {
    assert.equal(
      consumeCardNavigationClick({
        gesture: cancelCardNavigationGesture(),
        isTouchEnvironment: true,
        isDetailVisible: true,
        isKeyboardActivation: false,
      }),
      true
    );
  });

  it('keeps gesture decisions isolated per card and across rerenders', () => {
    const firstCardGesture = beginCardPointerGesture({
      pointerType: 'touch',
      isTouchEnvironment: true,
      isDetailVisible: false,
    });
    const secondCardGesture = createCardNavigationGesture();

    // A render changes visibility, but each card's ref-backed gesture remains
    // independent and retains the decision made at pointerdown.
    assert.equal(
      consumeCardNavigationClick({
        gesture: firstCardGesture,
        isTouchEnvironment: true,
        isDetailVisible: true,
        isKeyboardActivation: false,
      }),
      true
    );
    assert.equal(secondCardGesture.suppressClick, false);
  });
});
