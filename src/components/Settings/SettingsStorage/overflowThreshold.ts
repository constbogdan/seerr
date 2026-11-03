import { BYTES_PER_OVERFLOW_GB } from '@server/constants/overflow';

export const overflowThresholdPosition = (
  totalSpace: number | null,
  thresholdGb: number | null
): number | null => {
  if (
    totalSpace === null ||
    totalSpace <= 0 ||
    thresholdGb === null ||
    !Number.isSafeInteger(thresholdGb) ||
    thresholdGb < 1
  ) {
    return null;
  }
  return Math.min(
    100,
    Math.max(0, (thresholdGb * BYTES_PER_OVERFLOW_GB * 100) / totalSpace)
  );
};
