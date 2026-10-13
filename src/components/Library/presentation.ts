import type {
  LibrarySeasonSummary,
  LibraryWatchedUser,
} from '@server/interfaces/api/libraryInterfaces';

export type LibrarySeasonAvailabilityPresentation =
  | 'available'
  | 'partial'
  | 'available_unknown_total'
  | 'archive'
  | 'missing';

export const classifyLibrarySeasonAvailability = (
  season: Pick<
    LibrarySeasonSummary,
    'state' | 'availableEpisodeCount' | 'knownEpisodeCount'
  >
): LibrarySeasonAvailabilityPresentation => {
  if (season.state === 'archive') return 'archive';
  if (season.state === 'known_missing') return 'missing';
  const knownEpisodeCount = season.knownEpisodeCount;
  if (
    knownEpisodeCount === null ||
    knownEpisodeCount <= 0 ||
    season.availableEpisodeCount > knownEpisodeCount
  )
    return 'available_unknown_total';
  return season.availableEpisodeCount === knownEpisodeCount
    ? 'available'
    : 'partial';
};

export const formatLibrarySize = (value: string | null): string => {
  if (!value) return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  const digits =
    unit === 0 || Math.abs(amount - Math.round(amount)) < 0.05 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unit]}`;
};

export const formatLibraryResolution = (
  resolution: number | null
): string | null =>
  resolution === 1080 || resolution === 2160 ? `${resolution}p` : null;

export const libraryWatchedLabel = (
  viewer: Pick<LibraryWatchedUser, 'watchedPercentage'>
): string => `${viewer.watchedPercentage}%`;

export const libraryLastActiveTooltip = (
  displayName: string,
  activeAt?: string
): string => (activeAt ? `${displayName} · ${activeAt}` : displayName);

export const sortLibraryWatchedUsersForPresentation = <
  T extends Pick<LibraryWatchedUser, 'key' | 'userId' | 'watchedPercentage'>,
>(
  users: readonly T[]
): T[] =>
  [...users].sort(
    (left, right) =>
      right.watchedPercentage - left.watchedPercentage ||
      (left.userId ?? Number.MAX_SAFE_INTEGER) -
        (right.userId ?? Number.MAX_SAFE_INTEGER) ||
      left.key.localeCompare(right.key)
  );

export const libraryWatchedTooltip = (
  viewer: Pick<
    LibraryWatchedUser,
    'displayName' | 'watchedEpisodeCount' | 'availableEpisodeCount'
  >,
  viewedAt?: string
): string => {
  const completion =
    viewer.watchedEpisodeCount !== null && viewer.availableEpisodeCount !== null
      ? `${viewer.displayName} · ${viewer.watchedEpisodeCount}/${viewer.availableEpisodeCount}`
      : `${viewer.displayName} · Watched`;
  return viewedAt ? `${completion} · ${viewedAt}` : completion;
};
