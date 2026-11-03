export type OverflowProvider = 'radarr' | 'sonarr';

export const DEFAULT_OVERFLOW_THRESHOLD_GB = 50;
export const MIN_OVERFLOW_THRESHOLD_GB = 1;
export const DEFAULT_SERIES_SEASON_THRESHOLD = 3;
export const MIN_SERIES_SEASON_THRESHOLD = 1;
export const DEFAULT_TORRENT_RELOCATION_DELAY_HOURS = 48;
export const MIN_TORRENT_RELOCATION_DELAY_HOURS = 0;
export const BYTES_PER_OVERFLOW_GB = 1024 ** 3;

export interface OverflowVolumeRoute {
  sourceVolumeId: string;
  destinationVolumeId: string;
  thresholdGb: number;
  enabled: boolean;
}

export interface OverflowSettings {
  enabled: boolean;
  freeSpaceThreshold: FreeSpaceThreshold;
  automaticSeriesPlacement: boolean;
  defaultSeriesVolumeId: string | null;
  expansionSeriesVolumeId: string | null;
  seriesSeasonThreshold: number;
  torrentRelocationDelayHours: number;
  routes: OverflowVolumeRoute[];
}

export interface OverflowRootIdentity {
  provider: OverflowProvider;
  serviceId: number;
  isAnimation?: boolean;
  routable: boolean;
}

export type OverflowRootResolution<T extends OverflowRootIdentity> =
  | { status: 'resolved'; location: T }
  | {
      status:
        | 'source-classification-missing'
        | 'destination-root-missing'
        | 'destination-root-ambiguous';
    };

export const resolveOverflowRoot = <T extends OverflowRootIdentity>(
  source: OverflowRootIdentity,
  destinations: T[]
): OverflowRootResolution<T> => {
  if (!source.routable || typeof source.isAnimation !== 'boolean') {
    return { status: 'source-classification-missing' };
  }
  const matches = destinations.filter(
    (destination) =>
      destination.routable &&
      typeof destination.isAnimation === 'boolean' &&
      destination.provider === source.provider &&
      destination.serviceId === source.serviceId &&
      destination.isAnimation === source.isAnimation
  );
  if (matches.length === 0) return { status: 'destination-root-missing' };
  if (matches.length > 1) {
    return { status: 'destination-root-ambiguous' };
  }
  return { status: 'resolved', location: matches[0] };
};

export const FREE_SPACE_THRESHOLDS = [5, 10, 15, 20] as const;
export type FreeSpaceThreshold = (typeof FREE_SPACE_THRESHOLDS)[number];

export const DEFAULT_OVERFLOW_SETTINGS: OverflowSettings = {
  enabled: false,
  freeSpaceThreshold: 10,
  automaticSeriesPlacement: false,
  defaultSeriesVolumeId: null,
  expansionSeriesVolumeId: null,
  seriesSeasonThreshold: DEFAULT_SERIES_SEASON_THRESHOLD,
  torrentRelocationDelayHours: DEFAULT_TORRENT_RELOCATION_DELAY_HOURS,
  routes: [],
};

export const isOverflowThresholdGb = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= MIN_OVERFLOW_THRESHOLD_GB;

export const isSeriesSeasonThreshold = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= MIN_SERIES_SEASON_THRESHOLD;

export const isTorrentRelocationDelayHours = (
  value: unknown
): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= MIN_TORRENT_RELOCATION_DELAY_HOURS;

export const isFreeSpaceThreshold = (
  value: unknown
): value is FreeSpaceThreshold =>
  typeof value === 'number' &&
  FREE_SPACE_THRESHOLDS.includes(value as FreeSpaceThreshold);

const validVolumeId = (value: unknown): value is string =>
  typeof value === 'string' && /^(physical|location):[^\s]+$/.test(value);

const normalizeRoute = (value: unknown): OverflowVolumeRoute | null => {
  if (!value || typeof value !== 'object') return null;
  const route = value as Partial<OverflowVolumeRoute>;
  if (
    !validVolumeId(route.sourceVolumeId) ||
    !validVolumeId(route.destinationVolumeId) ||
    route.sourceVolumeId === route.destinationVolumeId ||
    !isOverflowThresholdGb(route.thresholdGb) ||
    typeof route.enabled !== 'boolean'
  ) {
    return null;
  }
  return {
    sourceVolumeId: route.sourceVolumeId,
    destinationVolumeId: route.destinationVolumeId,
    thresholdGb: route.thresholdGb,
    enabled: route.enabled,
  };
};

export const overflowRouteKey = (
  route: Pick<OverflowVolumeRoute, 'sourceVolumeId' | 'destinationVolumeId'>
): string => `${route.sourceVolumeId}->${route.destinationVolumeId}`;

export const normalizeOverflowSettings = (value: unknown): OverflowSettings => {
  if (!value || typeof value !== 'object') {
    return structuredClone(DEFAULT_OVERFLOW_SETTINGS);
  }
  const input = value as Partial<OverflowSettings>;
  const freeSpaceThreshold = isFreeSpaceThreshold(input.freeSpaceThreshold)
    ? input.freeSpaceThreshold
    : DEFAULT_OVERFLOW_SETTINGS.freeSpaceThreshold;
  const routes: OverflowVolumeRoute[] = [];
  const seenSources = new Set<string>();
  if (Array.isArray(input.routes)) {
    for (const value of input.routes) {
      const route = normalizeRoute(value);
      if (!route) continue;
      if (seenSources.has(route.sourceVolumeId)) continue;
      seenSources.add(route.sourceVolumeId);
      routes.push(route);
    }
  }
  return {
    enabled: input.enabled === true,
    freeSpaceThreshold,
    automaticSeriesPlacement: input.automaticSeriesPlacement === true,
    defaultSeriesVolumeId: validVolumeId(input.defaultSeriesVolumeId)
      ? input.defaultSeriesVolumeId
      : null,
    expansionSeriesVolumeId: validVolumeId(input.expansionSeriesVolumeId)
      ? input.expansionSeriesVolumeId
      : null,
    seriesSeasonThreshold: isSeriesSeasonThreshold(input.seriesSeasonThreshold)
      ? input.seriesSeasonThreshold
      : DEFAULT_SERIES_SEASON_THRESHOLD,
    torrentRelocationDelayHours: isTorrentRelocationDelayHours(
      input.torrentRelocationDelayHours
    )
      ? input.torrentRelocationDelayHours
      : DEFAULT_TORRENT_RELOCATION_DELAY_HOURS,
    routes,
  };
};
