export const LIBRARY_PROGRESSIVE_BATCH_SIZE = 5;

export const getInitialLibraryMountCount = (
  total: number,
  batchSize = LIBRARY_PROGRESSIVE_BATCH_SIZE
) => Math.min(total, batchSize);

export const getNextLibraryMountCount = (
  current: number,
  total: number,
  batchSize = LIBRARY_PROGRESSIVE_BATCH_SIZE
) => Math.min(total, current + batchSize);
