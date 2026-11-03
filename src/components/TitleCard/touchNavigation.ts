export type CardPointerType = 'mouse' | 'touch' | 'pen' | 'unknown';

export type CardNavigationGesture = {
  inputSource: 'none' | 'pointer' | 'touch' | 'cancelled';
  pointerType: CardPointerType;
  suppressClick: boolean;
};

export const createCardNavigationGesture = (): CardNavigationGesture => ({
  inputSource: 'none',
  pointerType: 'unknown',
  suppressClick: false,
});

export const normalizeCardPointerType = (
  pointerType: string
): CardPointerType => {
  if (
    pointerType === 'mouse' ||
    pointerType === 'touch' ||
    pointerType === 'pen'
  ) {
    return pointerType;
  }

  return 'unknown';
};

export const shouldRevealTitleCard = ({
  pointerType,
  isTouchEnvironment,
  isDetailVisible,
  isKeyboardActivation,
}: {
  pointerType: CardPointerType;
  isTouchEnvironment: boolean;
  isDetailVisible: boolean;
  isKeyboardActivation: boolean;
}): boolean => {
  if (isKeyboardActivation || isDetailVisible) return false;

  return (
    pointerType === 'touch' ||
    pointerType === 'pen' ||
    (pointerType === 'unknown' && isTouchEnvironment)
  );
};

export const beginCardPointerGesture = ({
  pointerType,
  isTouchEnvironment,
  isDetailVisible,
}: {
  pointerType: string;
  isTouchEnvironment: boolean;
  isDetailVisible: boolean;
}): CardNavigationGesture => {
  const normalizedPointerType = normalizeCardPointerType(pointerType);

  return {
    inputSource: 'pointer',
    pointerType: normalizedPointerType,
    suppressClick: shouldRevealTitleCard({
      pointerType: normalizedPointerType,
      isTouchEnvironment,
      isDetailVisible,
      isKeyboardActivation: false,
    }),
  };
};

export const beginCardTouchFallbackGesture = ({
  gesture,
  isTouchEnvironment,
  isDetailVisible,
}: {
  gesture: CardNavigationGesture;
  isTouchEnvironment: boolean;
  isDetailVisible: boolean;
}): CardNavigationGesture => {
  // Pointer-enabled browsers also dispatch touch events. Keep the decision
  // captured at pointerdown so a focus-driven render cannot change it.
  if (gesture.inputSource === 'pointer') return gesture;

  return {
    inputSource: 'touch',
    pointerType: 'touch',
    suppressClick: shouldRevealTitleCard({
      pointerType: 'touch',
      isTouchEnvironment,
      isDetailVisible,
      isKeyboardActivation: false,
    }),
  };
};

export const cancelCardNavigationGesture = (): CardNavigationGesture => ({
  inputSource: 'cancelled',
  pointerType: 'unknown',
  // A cancelled gesture should not produce a click, but suppress one if a
  // browser does synthesize it after a touch scroll or interruption.
  suppressClick: true,
});

export const consumeCardNavigationClick = ({
  gesture,
  isTouchEnvironment,
  isDetailVisible,
  isKeyboardActivation,
}: {
  gesture: CardNavigationGesture;
  isTouchEnvironment: boolean;
  isDetailVisible: boolean;
  isKeyboardActivation: boolean;
}): boolean => {
  if (isKeyboardActivation) return false;

  if (gesture.inputSource !== 'none') return gesture.suppressClick;

  // Retain the compatibility fallback for browsers that emit neither a
  // PointerEvent nor a TouchEvent before click.
  return shouldRevealTitleCard({
    pointerType: 'unknown',
    isTouchEnvironment,
    isDetailVisible,
    isKeyboardActivation: false,
  });
};
