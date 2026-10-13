export const STORAGE_ROOT_COLOR_PALETTE = [
  '#60a5fa',
  '#22d3ee',
  '#2dd4bf',
  '#4ade80',
  '#a3e635',
  '#facc15',
  '#fb923c',
  '#f87171',
  '#f472b6',
  '#c084fc',
  '#818cf8',
  '#94a3b8',
] as const;

export type StorageRootColor = (typeof STORAGE_ROOT_COLOR_PALETTE)[number];

export const normalizeStorageRootColor = (
  value?: string | null
): StorageRootColor | null => {
  const normalized = value?.trim().toLowerCase();
  return (
    STORAGE_ROOT_COLOR_PALETTE.find((color) => color === normalized) ?? null
  );
};
