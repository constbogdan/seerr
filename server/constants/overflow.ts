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
  rootMappings?: OverflowRootMapping[];
}

export interface OverflowRootMapping {
  sourceLocationId: string;
  destinationLocationId: string;
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
  seriesRootPreferences?: SeriesRootPreference[];
}

export interface SeriesRootPreference extends OverflowRootMapping {
  destinationVolumeId: string;
}

export interface OverflowRootIdentity {
  provider: OverflowProvider;
  serviceId: number;
  isAnimation?: boolean;
  routable: boolean;
}

export interface IdentifiedOverflowRoot extends OverflowRootIdentity {
  id: string;
}

export type OverflowRootResolution<T extends OverflowRootIdentity> =
  | { status: 'resolved'; location: T }
  | {
      status:
        | 'source-classification-missing'
        | 'destination-root-missing'
        | 'destination-root-ambiguous';
    };

export const compatibleOverflowRoots = <T extends OverflowRootIdentity>(
  source: OverflowRootIdentity,
  destinations: T[]
): T[] =>
  source.routable && typeof source.isAnimation === 'boolean'
    ? destinations.filter(
        (destination) =>
          destination.routable &&
          typeof destination.isAnimation === 'boolean' &&
          destination.provider === source.provider &&
          destination.serviceId === source.serviceId &&
          destination.isAnimation === source.isAnimation
      )
    : [];

export const resolveOverflowRoot = <T extends OverflowRootIdentity>(
  source: OverflowRootIdentity,
  destinations: T[]
): OverflowRootResolution<T> => {
  if (!source.routable || typeof source.isAnimation !== 'boolean') {
    return { status: 'source-classification-missing' };
  }
  const matches = compatibleOverflowRoots(source, destinations);
  if (matches.length === 0) return { status: 'destination-root-missing' };
  if (matches.length > 1) {
    return { status: 'destination-root-ambiguous' };
  }
  return { status: 'resolved', location: matches[0] };
};

export type OverflowRouteRootResolution<T extends IdentifiedOverflowRoot> =
  | { status: 'resolved'; location: T }
  | {
      status:
        | 'source-classification-missing'
        | 'destination-root-missing'
        | 'destination-root-ambiguous'
        | 'invalid-root-mapping';
    };

export const resolveOverflowRouteRoot = <T extends IdentifiedOverflowRoot>(
  source: IdentifiedOverflowRoot,
  destinations: T[],
  mappings: OverflowRootMapping[] = []
): OverflowRouteRootResolution<T> => {
  const selected = mappings.filter(
    (mapping) => mapping.sourceLocationId === source.id
  );
  if (selected.length > 1) return { status: 'invalid-root-mapping' };
  if (selected.length === 0) return resolveOverflowRoot(source, destinations);
  const matches = compatibleOverflowRoots(source, destinations);
  const destination = matches.find(
    (candidate) => candidate.id === selected[0].destinationLocationId
  );
  return destination
    ? { status: 'resolved', location: destination }
    : { status: 'invalid-root-mapping' };
};

export const validateOverflowRouteRootMappings = <
  T extends IdentifiedOverflowRoot,
>(
  sources: IdentifiedOverflowRoot[],
  destinations: T[],
  mappings: OverflowRootMapping[] = []
): OverflowRouteRootResolution<T>['status'] => {
  if (!sources.length || !destinations.length) {
    return 'destination-root-missing';
  }
  const sourceIds = new Set(sources.map((source) => source.id));
  const selectedIds = new Set<string>();
  for (const mapping of mappings) {
    if (
      !sourceIds.has(mapping.sourceLocationId) ||
      selectedIds.has(mapping.sourceLocationId)
    ) {
      return 'invalid-root-mapping';
    }
    selectedIds.add(mapping.sourceLocationId);
  }
  for (const source of sources) {
    const result = resolveOverflowRouteRoot(source, destinations, mappings);
    if (result.status !== 'resolved') return result.status;
  }
  return 'resolved';
};

export const resolveSeriesPreferredRoot = <T extends IdentifiedOverflowRoot>(
  source: IdentifiedOverflowRoot,
  destinations: T[],
  destinationVolumeId: string,
  preferences: SeriesRootPreference[] = []
): OverflowRouteRootResolution<T> =>
  resolveOverflowRouteRoot(
    source,
    destinations,
    preferences
      .filter(
        (preference) => preference.destinationVolumeId === destinationVolumeId
      )
      .map(({ sourceLocationId, destinationLocationId }) => ({
        sourceLocationId,
        destinationLocationId,
      }))
  );

export const validateSeriesRootPreferenceEntries = (
  sources: IdentifiedOverflowRoot[],
  destinationsByVolume: ReadonlyMap<string, IdentifiedOverflowRoot[]>,
  preferences: SeriesRootPreference[] = []
): boolean => {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const seen = new Set<string>();
  for (const preference of preferences) {
    const key = `${preference.sourceLocationId}|${preference.destinationVolumeId}`;
    const source = sourceById.get(preference.sourceLocationId);
    const destinations = destinationsByVolume.get(
      preference.destinationVolumeId
    );
    if (!source || !destinations || seen.has(key)) return false;
    seen.add(key);
    const result = resolveSeriesPreferredRoot(
      source,
      destinations,
      preference.destinationVolumeId,
      preferences
    );
    if (
      result.status !== 'resolved' ||
      result.location.id !== preference.destinationLocationId
    )
      return false;
  }
  return true;
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

const validRootLocationId = (value: unknown): value is string =>
  typeof value === 'string' && /^(radarr|sonarr):\d+:root:\d+$/.test(value);

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
  let rootMappings: OverflowRootMapping[] | undefined;
  if (route.rootMappings !== undefined) {
    if (!Array.isArray(route.rootMappings)) return null;
    rootMappings = [];
    const seenSources = new Set<string>();
    for (const mapping of route.rootMappings) {
      if (
        !mapping ||
        !validRootLocationId(mapping.sourceLocationId) ||
        !validRootLocationId(mapping.destinationLocationId) ||
        seenSources.has(mapping.sourceLocationId)
      ) {
        return null;
      }
      seenSources.add(mapping.sourceLocationId);
      rootMappings.push({
        sourceLocationId: mapping.sourceLocationId,
        destinationLocationId: mapping.destinationLocationId,
      });
    }
  }
  return {
    sourceVolumeId: route.sourceVolumeId,
    destinationVolumeId: route.destinationVolumeId,
    thresholdGb: route.thresholdGb,
    enabled: route.enabled,
    ...(rootMappings !== undefined ? { rootMappings } : {}),
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
  let seriesRootPreferences: SeriesRootPreference[] | undefined;
  if (input.seriesRootPreferences !== undefined) {
    seriesRootPreferences = [];
    const seen = new Set<string>();
    const invalid = new Set<string>();
    if (Array.isArray(input.seriesRootPreferences)) {
      for (const preference of input.seriesRootPreferences) {
        if (
          !preference ||
          !validRootLocationId(preference.sourceLocationId) ||
          !validVolumeId(preference.destinationVolumeId) ||
          !validRootLocationId(preference.destinationLocationId)
        )
          continue;
        const key = `${preference.sourceLocationId}|${preference.destinationVolumeId}`;
        if (seen.has(key)) {
          invalid.add(key);
          continue;
        }
        seen.add(key);
        seriesRootPreferences.push({
          sourceLocationId: preference.sourceLocationId,
          destinationVolumeId: preference.destinationVolumeId,
          destinationLocationId: preference.destinationLocationId,
        });
      }
      seriesRootPreferences = seriesRootPreferences.filter(
        (preference) =>
          !invalid.has(
            `${preference.sourceLocationId}|${preference.destinationVolumeId}`
          )
      );
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
    ...(seriesRootPreferences !== undefined ? { seriesRootPreferences } : {}),
  };
};
