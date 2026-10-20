import type { Tag } from '@server/api/servarr/base';
import {
  BYTES_PER_OVERFLOW_GB,
  resolveOverflowRoot,
  type OverflowProvider,
  type OverflowSettings,
} from '@server/constants/overflow';
import type {
  PhysicalVolume,
  StorageDiscoveryResult,
  StorageLocation,
} from '@server/lib/storageSettings';

export type OverflowPlacement = 'internal' | 'external';

export type OverflowDecisionReason =
  | 'selected'
  | 'disabled'
  | 'explicit-root'
  | 'existing-media-with-files'
  | 'existing-media-acquisition-active-or-unknown'
  | 'existing-series'
  | 'series-placement-disabled'
  | 'missing-route'
  | 'ambiguous-route'
  | 'configured-root-not-found'
  | 'preferred-volume-not-configured'
  | 'missing-root'
  | 'ambiguous-destination-root'
  | 'same-physical-volume'
  | 'source-capacity-unavailable'
  | 'threshold-exceeds-source-capacity'
  | 'destination-capacity-unavailable';

export interface OverflowPlacementDecision {
  selected: boolean;
  reason: OverflowDecisionReason;
  placement: OverflowPlacement | null;
  location: StorageLocation | null;
  routeKey: string | null;
}

interface BaseEvaluationInput {
  settings: OverflowSettings;
  discovery: StorageDiscoveryResult;
  provider: OverflowProvider;
  serviceId: number;
  configuredRootPath: string;
  explicitRoot: boolean;
}

export interface MovieOverflowEvaluationInput extends BaseEvaluationInput {
  mediaType: 'movie';
  existingMediaHasFiles: boolean;
  existingMediaAcquisitionActiveOrUnknown: boolean;
}

export interface SeriesOverflowEvaluationInput extends BaseEvaluationInput {
  mediaType: 'series';
  existingSeries: boolean;
  requestedRegularSeasonNumbers: number[];
}

export type OverflowEvaluationInput =
  | MovieOverflowEvaluationInput
  | SeriesOverflowEvaluationInput;

const normalizedRootPath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';

const noSelection = (
  reason: Exclude<OverflowDecisionReason, 'selected'>
): OverflowPlacementDecision => ({
  selected: false,
  reason,
  placement: null,
  location: null,
  routeKey: null,
});

const usableVolume = (volume: PhysicalVolume | undefined): boolean =>
  Boolean(
    volume?.accessible &&
    !volume.capacityReadingsDiffer &&
    volume.totalSpace !== null &&
    volume.totalSpace > 0 &&
    volume.freeSpace !== null &&
    volume.freeSpace >= 0 &&
    volume.freeSpace <= volume.totalSpace
  );

export const requestedRegularSeasonCount = (seasons: number[]): number =>
  new Set(
    seasons.filter((season) => Number.isSafeInteger(season) && season > 0)
  ).size;

export const evaluateOverflowPlacement = (
  input: OverflowEvaluationInput
): OverflowPlacementDecision => {
  if (input.mediaType === 'movie' && !input.settings.enabled) {
    return noSelection('disabled');
  }
  if (
    input.mediaType === 'series' &&
    !input.settings.automaticSeriesPlacement
  ) {
    return noSelection('series-placement-disabled');
  }
  if (input.explicitRoot) return noSelection('explicit-root');
  if (input.mediaType === 'movie' && input.existingMediaHasFiles) {
    return noSelection('existing-media-with-files');
  }
  if (
    input.mediaType === 'movie' &&
    input.existingMediaAcquisitionActiveOrUnknown
  ) {
    return noSelection('existing-media-acquisition-active-or-unknown');
  }
  if (input.mediaType === 'series' && input.existingSeries) {
    return noSelection('existing-series');
  }
  const locations = new Map(
    input.discovery.locations.map((location) => [location.id, location])
  );
  const volumeByLocation = new Map(
    input.discovery.volumes.flatMap((volume) =>
      volume.locationIds.map((locationId) => [locationId, volume] as const)
    )
  );
  const configuredPath = normalizedRootPath(input.configuredRootPath);
  const configuredRoots = input.discovery.locations.filter(
    (location) =>
      location.provider === input.provider &&
      location.serviceId === input.serviceId &&
      normalizedRootPath(location.path) === configuredPath
  );
  if (configuredRoots.length !== 1) {
    return noSelection('configured-root-not-found');
  }
  const source = configuredRoots[0];
  const sourceVolume = volumeByLocation.get(source.id);
  if (!sourceVolume) return noSelection('missing-root');

  const resolveRoot = (
    volume: PhysicalVolume | undefined
  ):
    | { location: StorageLocation; reason?: never }
    | {
        location?: never;
        reason: 'missing-root' | 'ambiguous-destination-root';
      } => {
    if (!volume) return { reason: 'missing-root' as const };
    const candidates = volume.locationIds
      .map((locationId) => locations.get(locationId))
      .filter((location): location is StorageLocation =>
        Boolean(location?.routable)
      );
    const resolution = resolveOverflowRoot(source, candidates);
    switch (resolution.status) {
      case 'resolved':
        return { location: resolution.location };
      case 'destination-root-ambiguous':
        return { reason: 'ambiguous-destination-root' };
      case 'source-classification-missing':
      case 'destination-root-missing':
        return { reason: 'missing-root' };
    }
  };

  const routeForSource = (volumeId: string) =>
    input.settings.routes.filter(
      (candidate) => candidate.enabled && candidate.sourceVolumeId === volumeId
    );

  let route: OverflowSettings['routes'][number] | undefined = routeForSource(
    sourceVolume.id
  )[0];
  let preferredVolume = sourceVolume;
  let alternateVolume: PhysicalVolume | undefined;
  let placement: OverflowPlacement = 'internal';

  if (input.mediaType === 'series') {
    const defaultId = input.settings.defaultSeriesVolumeId;
    const expansionId = input.settings.expansionSeriesVolumeId;
    if (!defaultId || !expansionId) {
      return noSelection('preferred-volume-not-configured');
    }
    if (defaultId === expansionId) {
      return noSelection('same-physical-volume');
    }
    const defaultVolume = input.discovery.volumes.find(
      (volume) => volume.id === defaultId
    );
    const expansionVolume = input.discovery.volumes.find(
      (volume) => volume.id === expansionId
    );
    if (!defaultVolume || !expansionVolume) {
      return noSelection('preferred-volume-not-configured');
    }
    const preferExpansion =
      requestedRegularSeasonCount(input.requestedRegularSeasonNumbers) >=
      input.settings.seriesSeasonThreshold;
    preferredVolume = preferExpansion ? expansionVolume : defaultVolume;
    alternateVolume = preferExpansion ? defaultVolume : expansionVolume;
    placement = preferExpansion ? 'external' : 'internal';
    route = routeForSource(defaultId).find(
      (candidate) => candidate.destinationVolumeId === expansionId
    );
  }

  if (input.mediaType === 'movie' && !route) {
    return noSelection('missing-route');
  }
  if (
    input.mediaType === 'movie' &&
    route &&
    routeForSource(route.sourceVolumeId).length > 1
  ) {
    return noSelection('ambiguous-route');
  }
  const routeKey = route
    ? `${route.sourceVolumeId}->${route.destinationVolumeId}`
    : null;
  const mappedSource = route
    ? input.discovery.volumes.find(
        (volume) => volume.id === route.sourceVolumeId
      )
    : undefined;
  const mappedDestination = route
    ? input.discovery.volumes.find(
        (volume) => volume.id === route.destinationVolumeId
      )
    : undefined;
  if (
    input.mediaType === 'movie' &&
    mappedSource?.id === mappedDestination?.id
  ) {
    return noSelection('same-physical-volume');
  }

  let location: StorageLocation;
  if (input.mediaType === 'movie') {
    const movieRoute = route!;
    if (!usableVolume(mappedSource)) {
      return noSelection('source-capacity-unavailable');
    }
    const thresholdBytes = movieRoute.thresholdGb * BYTES_PER_OVERFLOW_GB;
    if (thresholdBytes > mappedSource!.totalSpace!) {
      return noSelection('threshold-exceeds-source-capacity');
    }
    if (mappedSource!.freeSpace! > thresholdBytes) {
      placement = 'internal';
      const resolved = resolveRoot(mappedSource);
      if (!resolved.location) return noSelection(resolved.reason);
      location = resolved.location;
    } else {
      if (
        !usableVolume(mappedDestination) ||
        mappedDestination!.freeSpace! <= 0
      ) {
        return noSelection('destination-capacity-unavailable');
      }
      placement = 'external';
      const resolved = resolveRoot(mappedDestination);
      if (!resolved.location) return noSelection(resolved.reason);
      location = resolved.location;
    }
  } else {
    const volumeSuitable = (volume: PhysicalVolume | undefined): boolean => {
      if (!usableVolume(volume) || volume!.freeSpace! <= 0) return false;
      const volumeRoutes = routeForSource(volume!.id);
      if (volumeRoutes.length > 1) return false;
      return volumeRoutes.length === 0
        ? true
        : volume!.freeSpace! >
            volumeRoutes[0].thresholdGb * BYTES_PER_OVERFLOW_GB;
    };
    const selectedVolume = volumeSuitable(preferredVolume)
      ? preferredVolume
      : alternateVolume;
    if (!volumeSuitable(selectedVolume)) {
      return noSelection('destination-capacity-unavailable');
    }
    const resolved = resolveRoot(selectedVolume);
    if (!resolved.location) return noSelection(resolved.reason);
    location = resolved.location;
    placement =
      selectedVolume!.id === input.settings.expansionSeriesVolumeId
        ? 'external'
        : 'internal';
  }

  return {
    selected: true,
    reason: 'selected',
    placement,
    location,
    routeKey,
  };
};

export type OverflowTagResolution =
  | { valid: true; tags: number[]; selectedTagId: number }
  | { valid: false; reason: 'missing-routing-tag' | 'ambiguous-routing-tag' };

export const resolveOverflowRoutingTags = (
  providerTags: Tag[],
  existingTagIds: number[],
  placement: OverflowPlacement
): OverflowTagResolution => {
  const tagsByLabel = (label: OverflowPlacement) =>
    providerTags.filter((tag) => tag.label.trim().toLowerCase() === label);
  const internal = tagsByLabel('internal');
  const external = tagsByLabel('external');
  const selected = placement === 'internal' ? internal : external;
  if (selected.length === 0) {
    return { valid: false, reason: 'missing-routing-tag' };
  }
  if (internal.length > 1 || external.length > 1 || selected.length !== 1) {
    return { valid: false, reason: 'ambiguous-routing-tag' };
  }
  const routingTagIds = new Set(
    [...internal, ...external].map((tag) => tag.id)
  );
  return {
    valid: true,
    selectedTagId: selected[0].id,
    tags: [
      ...existingTagIds.filter((tagId) => !routingTagIds.has(tagId)),
      selected[0].id,
    ],
  };
};
