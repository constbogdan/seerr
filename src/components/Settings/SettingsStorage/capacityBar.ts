export interface RootCapacitySplit {
  retainedBytes: string | null;
  retainedPercentage: number;
  leavingSoonPercentage: number;
}

export const splitRootCapacity = ({
  indexedUsageBytes,
  pendingRemovalBytes,
  percentage,
  totalSpace,
}: {
  indexedUsageBytes: string | null;
  pendingRemovalBytes: string | null;
  percentage: number | null;
  totalSpace: number | null;
}): RootCapacitySplit => {
  const totalPercentage = Math.max(0, percentage ?? 0);
  const indexedBytes = Number(indexedUsageBytes);
  const pendingBytes = Number(pendingRemovalBytes);
  const confirmedPendingBytes =
    indexedUsageBytes !== null &&
    Number.isFinite(indexedBytes) &&
    indexedBytes > 0 &&
    pendingRemovalBytes !== null &&
    Number.isFinite(pendingBytes) &&
    pendingBytes > 0
      ? Math.min(indexedBytes, pendingBytes)
      : 0;
  const leavingSoonPercentage =
    totalSpace !== null && totalSpace > 0
      ? Math.min(
          totalPercentage,
          Math.max(0, (confirmedPendingBytes / totalSpace) * 100)
        )
      : 0;

  return {
    retainedBytes:
      indexedUsageBytes !== null &&
      Number.isFinite(indexedBytes) &&
      indexedBytes >= 0
        ? String(Math.max(0, indexedBytes - confirmedPendingBytes))
        : null,
    retainedPercentage: Math.max(0, totalPercentage - leavingSoonPercentage),
    leavingSoonPercentage,
  };
};
