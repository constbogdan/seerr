export type CardPointerType = 'mouse' | 'touch' | 'pen' | 'unknown';

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
