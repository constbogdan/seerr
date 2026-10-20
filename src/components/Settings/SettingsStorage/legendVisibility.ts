export const shouldShowCategoryLegend = (value: string | null): boolean => {
  if (value === null) return true;
  try {
    return BigInt(value) !== 0n;
  } catch {
    // Preserve unexpected/unknown facts for diagnosis instead of hiding them
    // as though they were a confirmed zero-byte category.
    return true;
  }
};
