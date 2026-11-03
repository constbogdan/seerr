export const LIBRARY_PROGRESSIVE_BATCH_SIZE = 5;
export const LIBRARY_RETAINED_QUERY_LIMIT = 10;

export const getInitialLibraryMountCount = (
  total: number,
  batchSize = LIBRARY_PROGRESSIVE_BATCH_SIZE,
  retainedCount = 0
) => Math.min(total, Math.max(batchSize, retainedCount));

export const getNextLibraryMountCount = (
  current: number,
  total: number,
  batchSize = LIBRARY_PROGRESSIVE_BATCH_SIZE
) => Math.min(total, current + batchSize);

export const retainLibraryMountCount = (
  retainedCounts: Map<string, number>,
  queryKey: string,
  count: number,
  limit = LIBRARY_RETAINED_QUERY_LIMIT
): void => {
  retainedCounts.delete(queryKey);
  retainedCounts.set(queryKey, Math.max(0, Math.floor(count)));

  while (retainedCounts.size > limit) {
    const oldestKey = retainedCounts.keys().next().value;
    if (oldestKey === undefined) break;
    retainedCounts.delete(oldestKey);
  }
};
