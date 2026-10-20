export type FreeSpaceLevel = 'low' | 'normal' | 'unknown';

export const FREE_SPACE_LEVEL_COLORS: Record<FreeSpaceLevel, string> = {
  low: '#CD7F7F',
  normal: '#77AD8C',
  unknown: '#6B7280',
};

export const calculateFreePercentage = (
  totalSpace: number | null,
  freeSpace: number | null
): number | null => {
  if (
    totalSpace === null ||
    freeSpace === null ||
    !Number.isFinite(totalSpace) ||
    !Number.isFinite(freeSpace) ||
    totalSpace <= 0 ||
    freeSpace < 0 ||
    freeSpace > totalSpace
  ) {
    return null;
  }

  return (freeSpace / totalSpace) * 100;
};

export const classifyFreeSpace = (
  freePercentage: number | null,
  threshold: number
): FreeSpaceLevel => {
  if (
    freePercentage === null ||
    !Number.isFinite(freePercentage) ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 100
  ) {
    return 'unknown';
  }

  return freePercentage < threshold ? 'low' : 'normal';
};
