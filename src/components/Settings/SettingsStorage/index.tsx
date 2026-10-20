import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SlideCheckbox from '@app/components/Common/SlideCheckbox';
import Tooltip from '@app/components/Common/Tooltip';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import {
  ArrowPathIcon,
  ArrowRightIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import type {
  OverflowSettings,
  OverflowVolumeRoute,
} from '@server/constants/overflow';
import {
  BYTES_PER_OVERFLOW_GB,
  DEFAULT_OVERFLOW_THRESHOLD_GB,
  FREE_SPACE_THRESHOLDS,
  isFreeSpaceThreshold,
  isOverflowThresholdGb,
  isSeriesSeasonThreshold,
  isTorrentRelocationDelayHours,
  overflowRouteKey,
  resolveOverflowRoot,
} from '@server/constants/overflow';
import type { SeriesRelocationPreviewResult } from '@server/lib/seriesRelocation';
import type {
  PhysicalVolume,
  StorageDiscoveryResult,
  StorageLocation,
} from '@server/lib/storageSettings';
import axios from 'axios';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

import { splitRootCapacity } from './capacityBar';
import {
  isOverflowRoutingActivationValid,
  replaceStorageJobState,
  seriesRelocationConfigurationChanged,
  setAutomaticSeriesPlacementEnabled,
  setOverflowRoutingEnabled,
  type StorageJobState,
} from './featureToggleState';
import {
  FREE_SPACE_LEVEL_COLORS,
  calculateFreePercentage,
  classifyFreeSpace,
} from './freeSpaceLevel';
import { shouldShowCategoryLegend } from './legendVisibility';
import { overflowThresholdPosition } from './overflowThreshold';
import { classifyStorageRefresh } from './refreshResult';

const messages = defineMessages('components.Settings.SettingsStorage', {
  title: 'Storage',
  routeThreshold: 'Threshold (GB)',
  routeThresholdInvalid:
    'Enter a whole number from 1 GB through the selected source volume capacity.',
  overflowRouteRequired:
    'Configure at least one enabled storage route before enabling Overflow Routing.',
  automation: 'Automation',
  automaticSeriesPlacement: 'Automatic Series Placement',
  automaticSeriesPlacementDescription:
    'Places new Series using the configured Series Routing preferences.',
  seriesRelocation: 'Series Relocation',
  seriesRelocationDescription:
    'Allows the scheduled job to relocate eligible existing Series.',
  seriesRouting: 'Series Routing',
  seriesRoutingDescription:
    'Choose where new Series are stored and when existing Series should be relocated.',
  seriesRelocationEnabled: 'Series Relocation enabled.',
  seriesRelocationDisabled: 'Series Relocation disabled.',
  seriesRelocationSaveFailed: 'Unable to update the Series Relocation job.',
  seriesRelocationSaveFailedDetail:
    'Unable to update the Series Relocation job: {message}',
  seriesRelocationUnsavedConfiguration:
    'Save the Series Routing volume and policy settings before enabling Series Relocation.',
  seriesRelocationConfigurationInvalid:
    'Series Relocation requires two different eligible Sonarr volumes.',
  seriesRelocationUnavailable:
    'Series Relocation job settings are unavailable.',
  seriesRelocationPolicyInvalid:
    'Enter a whole-number Season threshold of at least 1 and a non-negative whole-number torrent relocation delay.',
  nextCandidate: 'Next candidate',
  refreshCandidate: 'Refresh',
  candidateIdle: 'Refresh to evaluate the next eligible Series.',
  candidateLoading: 'Evaluating the next eligible Series…',
  candidateNone: 'No Series is currently eligible for relocation.',
  candidateUnavailable: 'The next candidate is currently unavailable.',
  candidateStale:
    'Save the Series Routing changes before refreshing the next candidate.',
  candidateSummary:
    '{count, plural, one {# Season} other {# Seasons}} · {size}',
  defaultSeriesVolume: 'Default volume',
  expansionSeriesVolume: 'Expansion volume',
  seriesSeasonThreshold: 'Season threshold',
  torrentRelocationDelay: 'Relocation delay (h)',
  seriesPreferencesInvalid:
    'Automatic Series Placement requires two different eligible Sonarr volumes.',
  chooseVolume: 'Choose a volume',
  threshold: 'Capacity warning',
  locations: 'Physical volumes',
  refresh: 'Refresh capacity',
  refreshSucceeded: 'Storage capacity refreshed.',
  refreshPartial:
    'Storage capacity refreshed with warnings. Unable to refresh: {services}.',
  refreshFailed: 'Unable to refresh storage capacity.',
  lastRefreshed: 'Last refreshed {date}',
  loadFailed: 'Unable to load storage locations.',
  retry: 'Retry',
  noLocations: 'No Radarr or Sonarr storage roots were found.',
  total: 'Total',
  used: 'Used',
  free: 'Free',
  pendingRemoval: 'Leaving Soon',
  pendingRemovalUnavailable: 'Leaving Soon data unavailable',
  pendingRemovalIncomplete:
    '{count, plural, one {# actionable removal could not be attributed safely.} other {# actionable removals could not be attributed safely.}} Known Leaving Soon bytes are shown; ambiguous bytes remain ordinary occupied usage.',
  other: 'Other',
  provisioned: 'Provisioned',
  unknown: 'Unknown',
  unavailable: 'Capacity unavailable',
  differingCapacity:
    'Fresh provider capacity readings differed. Physical capacity is unavailable until the providers agree.',
  usageExceedsPhysical:
    'Foundation Library usage exceeds the provider-reported used space. Values are shown without adjustment.',
  overflowRouting: 'Overflow Routing',
  overflowRoutingDescription:
    'Applies configured volume routes when source capacity reaches its threshold.',
  storageRouting: 'Storage Routing',
  routesDescription:
    'Choose where media should be stored based on remaining volume capacity.',
  source: 'Source volume',
  destination: 'Target volume',
  chooseSource: 'Choose a source',
  chooseDestination: 'Choose a target',
  noCompatibleDestinations:
    'No compatible target volume has exactly one matching root for each source root. Check the Servarr instance and root Animation settings.',
  unknownVolume: 'Unknown volume',
  addRoute: 'Add route',
  removeRoute: 'Remove route from {source} to {destination}',
  save: 'Save changes',
  saving: 'Saving…',
  saved: 'Storage settings saved.',
  saveFailed: 'Unable to save Storage settings.',
  inaccessibleInstances:
    '{count, plural, one {# Servarr instance is unavailable. Its known roots show Unknown capacity.} other {# Servarr instances are unavailable. Their known roots show Unknown capacity.}}',
});

interface StorageSettingsResponse extends StorageDiscoveryResult {
  settings: OverflowSettings;
}

type StorageJob = StorageJobState;

const capacity = (value: number | null, unknown: string) =>
  value === null ? unknown : formatBytes(value);

const libraryCapacity = (value: string | null, unknown: string) =>
  value === null ? unknown : formatBytes(Number(value));

const segmentPercentage = (
  value: string | null,
  volume: PhysicalVolume
): number => {
  if (value === null || volume.totalSpace === null || volume.totalSpace <= 0)
    return 0;
  return Math.min(100, Math.max(0, (Number(value) / volume.totalSpace) * 100));
};

const formatPercentage = (value: number | null, unknown: string) =>
  value === null ? unknown : `${value.toFixed(1)}%`;

const hasPositiveBytes = (value: string | null): value is string =>
  value !== null && Number.isFinite(Number(value)) && Number(value) > 0;

const leavingSoonHatch = {
  backgroundColor: '#111827',
  backgroundImage:
    'repeating-linear-gradient(135deg, #eab308 0, #eab308 2px, transparent 2px, transparent 4px)',
} as const;

const rootSegmentWidths = (
  segment: PhysicalVolume['segments'][number],
  volume: PhysicalVolume
) =>
  splitRootCapacity({
    indexedUsageBytes: segment.indexedUsageBytes,
    pendingRemovalBytes: segment.pendingRemovalBytes,
    percentage: segment.percentage,
    totalSpace: volume.totalSpace,
  });

const SettingsStorage = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, isValidating, mutate } = useSWR<StorageSettingsResponse>(
    '/api/v1/settings/storage'
  );
  const {
    data: jobs,
    error: jobsError,
    mutate: mutateJobs,
  } = useSWR<StorageJob[]>('/api/v1/settings/jobs', {
    refreshInterval: 5000,
  });
  const [values, setValues] = useState<OverflowSettings | null>(null);
  const [savedValues, setSavedValues] = useState<OverflowSettings | null>(null);
  const [sourceVolumeId, setSourceVolumeId] = useState('');
  const [destinationVolumeId, setDestinationVolumeId] = useState('');
  const [routeThresholdInput, setRouteThresholdInput] = useState(
    String(DEFAULT_OVERFLOW_THRESHOLD_GB)
  );
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingSeriesRelocation, setSavingSeriesRelocation] = useState(false);
  const [seriesRelocationPreview, setSeriesRelocationPreview] =
    useState<SeriesRelocationPreviewResult | null>(null);
  const [
    refreshingSeriesRelocationPreview,
    setRefreshingSeriesRelocationPreview,
  ] = useState(false);
  const [seriesRelocationPreviewError, setSeriesRelocationPreviewError] =
    useState(false);
  const savingRef = useRef(false);
  const refreshingRef = useRef(false);
  const savingSeriesRelocationRef = useRef(false);
  const refreshingSeriesRelocationPreviewRef = useRef(false);

  useEffect(() => {
    if (data && values === null) {
      setValues(data.settings);
      setSavedValues(data.settings);
    }
  }, [data, values]);

  const locations = useMemo(() => data?.locations ?? [], [data?.locations]);
  const volumes = useMemo(() => data?.volumes ?? [], [data?.volumes]);
  const locationById = useMemo(
    () => new Map(locations.map((location) => [location.id, location])),
    [locations]
  );
  const routableVolumes = volumes.filter(
    (volume) =>
      volume.volumeKey !== null &&
      volume.locationIds.some((id) => locationById.get(id)?.routable)
  );
  const sourceVolume = routableVolumes.find(
    (volume) => volume.id === sourceVolumeId
  );
  const destinations = sourceVolume
    ? routableVolumes.filter((volume) => {
        if (volume.id === sourceVolume.id) return false;
        const sourceLocations = sourceVolume.locationIds
          .map((id) => locationById.get(id))
          .filter((location): location is StorageLocation =>
            Boolean(location?.routable)
          );
        const destinationLocations = volume.locationIds
          .map((id) => locationById.get(id))
          .filter((location): location is StorageLocation =>
            Boolean(location?.routable)
          );
        return sourceLocations.every(
          (sourceLocation) =>
            resolveOverflowRoot(sourceLocation, destinationLocations).status ===
            'resolved'
        );
      })
    : [];
  const selectedDestination = routableVolumes.find(
    (volume) => volume.id === destinationVolumeId
  );
  const parsedRouteThreshold = Number(routeThresholdInput);
  const sourceMaximumGb = sourceVolume?.totalSpace
    ? Math.floor(sourceVolume.totalSpace / BYTES_PER_OVERFLOW_GB)
    : null;
  const routeThresholdValid =
    isOverflowThresholdGb(parsedRouteThreshold) &&
    sourceMaximumGb !== null &&
    parsedRouteThreshold <= sourceMaximumGb;
  const pendingRoute: OverflowVolumeRoute | null =
    sourceVolume && selectedDestination && routeThresholdValid
      ? {
          sourceVolumeId: sourceVolume.id,
          destinationVolumeId: selectedDestination.id,
          thresholdGb: parsedRouteThreshold,
          enabled: true,
        }
      : null;
  const duplicateRoute = Boolean(
    pendingRoute &&
    values?.routes.some(
      (route) => route.sourceVolumeId === pendingRoute.sourceVolumeId
    )
  );
  const dirty =
    values !== null &&
    savedValues !== null &&
    JSON.stringify(values) !== JSON.stringify(savedValues);
  const freeSpaceThresholdValid =
    values !== null && isFreeSpaceThreshold(values.freeSpaceThreshold);
  const routeThresholdsValid =
    values?.routes.every((route) => {
      const volume = volumes.find(
        (candidate) => candidate.id === route.sourceVolumeId
      );
      const maximum = volume?.totalSpace
        ? Math.floor(volume.totalSpace / BYTES_PER_OVERFLOW_GB)
        : null;
      return (
        isOverflowThresholdGb(route.thresholdGb) &&
        (!route.enabled || (maximum !== null && route.thresholdGb <= maximum))
      );
    }) ?? false;
  const overflowRoutingActivationValid =
    values !== null && isOverflowRoutingActivationValid(values);
  const sonarrVolumes = routableVolumes.filter((volume) =>
    volume.locationIds.some((id) => locationById.get(id)?.provider === 'sonarr')
  );
  const seriesRelocationPolicyValid =
    values !== null &&
    isSeriesSeasonThreshold(values.seriesSeasonThreshold) &&
    isTorrentRelocationDelayHours(values.torrentRelocationDelayHours);
  const seriesRelocationJob = jobs?.find(
    (job) => job.id === 'series-relocation'
  );
  const selectedSeriesVolumesValid =
    values !== null &&
    values.defaultSeriesVolumeId !== null &&
    values.expansionSeriesVolumeId !== null &&
    values.defaultSeriesVolumeId !== values.expansionSeriesVolumeId &&
    sonarrVolumes.some(
      (volume) => volume.id === values.defaultSeriesVolumeId
    ) &&
    sonarrVolumes.some(
      (volume) => volume.id === values.expansionSeriesVolumeId
    );
  const automaticSeriesPlacementVolumesValid =
    values !== null &&
    (!values.automaticSeriesPlacement || selectedSeriesVolumesValid);
  const seriesRelocationVolumesValid =
    !seriesRelocationJob?.enabled || selectedSeriesVolumesValid;
  const seriesPreferencesValid =
    seriesRelocationPolicyValid &&
    automaticSeriesPlacementVolumesValid &&
    seriesRelocationVolumesValid;
  const seriesRelocationPreviewStale =
    values !== null &&
    savedValues !== null &&
    seriesRelocationConfigurationChanged(values, savedValues);
  const unavailableInstances =
    data?.instances.filter((instance) => !instance.available).length ?? 0;
  const refreshedAt = data?.refreshedAt;

  const volumeLabel = (volumeId: string): string =>
    volumes.find((volume) => volume.id === volumeId)?.name ?? volumeId;

  const save = async () => {
    if (
      !values ||
      !freeSpaceThresholdValid ||
      !routeThresholdsValid ||
      !overflowRoutingActivationValid ||
      !seriesPreferencesValid ||
      savingRef.current
    )
      return;
    savingRef.current = true;
    setSaving(true);
    try {
      const response = await axios.post<OverflowSettings>(
        '/api/v1/settings/storage',
        values
      );
      setValues((current) =>
        current && JSON.stringify(current) !== JSON.stringify(values)
          ? current
          : response.data
      );
      setSavedValues(response.data);
      if (seriesRelocationPreviewStale) {
        setSeriesRelocationPreview(null);
        setSeriesRelocationPreviewError(false);
      }
      if (data) {
        await mutate({ ...data, settings: response.data }, false);
      }
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.saveFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const refreshCapacity = async () => {
    if (refreshingRef.current || isValidating) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const refreshed = await mutate();
      if (!refreshed) throw new Error('Storage refresh returned no data.');
      const result = classifyStorageRefresh(refreshed.instances);
      if (result.status === 'success') {
        addToast(intl.formatMessage(messages.refreshSucceeded), {
          appearance: 'success',
          autoDismiss: true,
        });
      } else if (result.status === 'partial') {
        addToast(
          intl.formatMessage(messages.refreshPartial, {
            services: result.failedServices.join(', '),
          }),
          { appearance: 'warning', autoDismiss: true }
        );
      } else {
        addToast(intl.formatMessage(messages.refreshFailed), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } catch {
      // SWR retains the previously displayed data when revalidation fails.
      addToast(intl.formatMessage(messages.refreshFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  const setSeriesRelocationEnabled = async (enabled: boolean) => {
    if (
      !seriesRelocationJob?.configurableEnabled ||
      savingSeriesRelocationRef.current
    )
      return;
    if (enabled && !selectedSeriesVolumesValid) {
      addToast(
        intl.formatMessage(messages.seriesRelocationConfigurationInvalid),
        { appearance: 'error', autoDismiss: true }
      );
      return;
    }
    if (
      enabled &&
      values &&
      savedValues &&
      seriesRelocationConfigurationChanged(values, savedValues)
    ) {
      addToast(
        intl.formatMessage(messages.seriesRelocationUnsavedConfiguration),
        { appearance: 'error', autoDismiss: true }
      );
      return;
    }
    savingSeriesRelocationRef.current = true;
    setSavingSeriesRelocation(true);
    try {
      await mutateJobs(
        async (current) => {
          const response = await axios.post<StorageJob>(
            '/api/v1/settings/jobs/series-relocation/enabled',
            { enabled }
          );
          return replaceStorageJobState(current, response.data);
        },
        { revalidate: false }
      );
      addToast(
        intl.formatMessage(
          enabled
            ? messages.seriesRelocationEnabled
            : messages.seriesRelocationDisabled
        ),
        { appearance: 'success', autoDismiss: true }
      );
    } catch (error) {
      const responseMessage =
        axios.isAxiosError(error) &&
        typeof error.response?.data?.message === 'string'
          ? error.response.data.message
          : null;
      addToast(
        intl.formatMessage(
          responseMessage
            ? messages.seriesRelocationSaveFailedDetail
            : messages.seriesRelocationSaveFailed,
          responseMessage ? { message: responseMessage } : undefined
        ),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      savingSeriesRelocationRef.current = false;
      setSavingSeriesRelocation(false);
    }
  };

  const refreshSeriesRelocationPreview = async () => {
    if (
      refreshingSeriesRelocationPreviewRef.current ||
      seriesRelocationPreviewStale
    )
      return;
    refreshingSeriesRelocationPreviewRef.current = true;
    setRefreshingSeriesRelocationPreview(true);
    setSeriesRelocationPreviewError(false);
    try {
      const response = await axios.get<SeriesRelocationPreviewResult>(
        '/api/v1/settings/storage/series-relocation/next-candidate'
      );
      setSeriesRelocationPreview(response.data);
    } catch {
      setSeriesRelocationPreview(null);
      setSeriesRelocationPreviewError(true);
    } finally {
      refreshingSeriesRelocationPreviewRef.current = false;
      setRefreshingSeriesRelocationPreview(false);
    }
  };

  const refreshPending = refreshing || isValidating;

  if (!data && !error) return <LoadingSpinner />;

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      {error && !data ? (
        <div className="rounded-md bg-gray-800 p-4 text-red-400" role="alert">
          <p>{intl.formatMessage(messages.loadFailed)}</p>
          <Button className="mt-3" onClick={() => void mutate()}>
            {intl.formatMessage(messages.retry)}
          </Button>
        </div>
      ) : values ? (
        <>
          <section data-testid="storage-physical-volumes-section">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold">
                  {intl.formatMessage(messages.locations)}
                </h2>
                {refreshedAt && (
                  <p className="mt-1 text-xs text-gray-500">
                    <time dateTime={refreshedAt}>
                      {intl.formatMessage(messages.lastRefreshed, {
                        date: intl.formatDate(refreshedAt, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }),
                      })}
                    </time>
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col items-end">
                  <label
                    htmlFor="overflow-free-space-threshold"
                    className="mb-1 block text-right text-xs font-medium text-gray-400"
                  >
                    {intl.formatMessage(messages.threshold)}
                  </label>
                  <select
                    id="overflow-free-space-threshold"
                    data-testid="overflow-free-space-threshold"
                    className="w-[90px] flex-none"
                    value={values.freeSpaceThreshold}
                    onChange={(event) => {
                      const freeSpaceThreshold = Number(event.target.value);
                      if (!isFreeSpaceThreshold(freeSpaceThreshold)) return;
                      setValues({ ...values, freeSpaceThreshold });
                    }}
                  >
                    {FREE_SPACE_THRESHOLDS.map((threshold) => (
                      <option key={threshold} value={threshold}>
                        {threshold}%
                      </option>
                    ))}
                  </select>
                </div>
                <Tooltip content={intl.formatMessage(messages.refresh)}>
                  <Button
                    className="h-[42px] w-[42px] !p-0"
                    aria-label={intl.formatMessage(messages.refresh)}
                    aria-busy={refreshPending}
                    onClick={() => void refreshCapacity()}
                    disabled={refreshPending}
                  >
                    <ArrowPathIcon
                      className={`h-5 w-5 ${refreshPending ? 'animate-spin motion-reduce:animate-none' : ''}`}
                      aria-hidden
                    />
                  </Button>
                </Tooltip>
              </div>
            </div>
            {unavailableInstances > 0 && (
              <p className="mt-4 rounded-md border border-yellow-500/50 bg-yellow-900/30 p-3 text-sm text-yellow-100">
                {intl.formatMessage(messages.inaccessibleInstances, {
                  count: unavailableInstances,
                })}
              </p>
            )}
            {volumes.length === 0 ? (
              <p className="mt-4 text-sm text-gray-400">
                {intl.formatMessage(messages.noLocations)}
              </p>
            ) : (
              <div className="mt-5 space-y-5" data-testid="storage-volume-list">
                {volumes.map((volume) => {
                  const unknown = intl.formatMessage(messages.unknown);
                  const otherPercentage = segmentPercentage(
                    volume.unaccountedUsageBytes,
                    volume
                  );
                  const provisionedPercentage = segmentPercentage(
                    volume.provisionedSpaceBytes,
                    volume
                  );
                  const freePercentage = calculateFreePercentage(
                    volume.totalSpace,
                    volume.freeSpace
                  );
                  const occupiedSpace =
                    freePercentage === null ||
                    volume.totalSpace === null ||
                    volume.freeSpace === null
                      ? null
                      : volume.totalSpace - volume.freeSpace;
                  const occupiedPercentage =
                    freePercentage === null ? null : 100 - freePercentage;
                  const freeSpaceLevel = classifyFreeSpace(
                    freePercentage,
                    values.freeSpaceThreshold
                  );
                  const freeSpaceColor =
                    FREE_SPACE_LEVEL_COLORS[freeSpaceLevel];
                  const overflowRoute = values.routes.find(
                    (route) =>
                      route.enabled && route.sourceVolumeId === volume.id
                  );
                  const overflowThresholdPercentage = overflowThresholdPosition(
                    volume.totalSpace,
                    overflowRoute?.thresholdGb ?? null
                  );
                  return (
                    <article
                      key={volume.id}
                      data-testid={`storage-volume-${volume.volumeKey ?? volume.id}`}
                      className="min-w-0 rounded-lg bg-gray-800 p-5 shadow ring-1 ring-gray-700"
                    >
                      <div
                        className="flex flex-wrap items-stretch gap-2"
                        data-testid={`storage-volume-summary-${volume.volumeKey ?? volume.id}`}
                      >
                        <div className="flex min-w-0 flex-1 basis-40 items-center justify-between gap-2 rounded-md bg-gray-900/50 px-3 py-1">
                          <h3 className="break-words text-lg font-semibold">
                            {volume.name}
                          </h3>
                          {!volume.accessible && (
                            <span className="shrink-0 rounded-full bg-yellow-900 px-2 py-1 text-xs text-yellow-200">
                              {intl.formatMessage(messages.unavailable)}
                            </span>
                          )}
                        </div>
                        <dl className="contents">
                          <div className="min-w-0 flex-1 basis-40 rounded-md bg-gray-900/50 px-3 py-1">
                            <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                              {intl.formatMessage(messages.total)}
                            </dt>
                            <dd
                              className="mt-0.5 whitespace-nowrap text-base font-semibold text-gray-100"
                              data-testid={`storage-capacity-total-${volume.volumeKey ?? volume.id}`}
                            >
                              {capacity(volume.totalSpace, unknown)}
                            </dd>
                          </div>
                          <div className="min-w-0 flex-1 basis-40 rounded-md bg-gray-900/50 px-3 py-1">
                            <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                              {intl.formatMessage(messages.used)}
                            </dt>
                            <dd
                              className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-base font-semibold text-gray-100"
                              data-testid={`storage-capacity-occupied-${volume.volumeKey ?? volume.id}`}
                            >
                              <span className="whitespace-nowrap">
                                {capacity(occupiedSpace, unknown)}
                              </span>
                              <span className="whitespace-nowrap font-normal text-gray-400">
                                ({formatPercentage(occupiedPercentage, unknown)}
                                )
                              </span>
                            </dd>
                          </div>
                          <div className="min-w-0 flex-1 basis-40 rounded-md bg-gray-900/50 px-3 py-1">
                            <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">
                              {intl.formatMessage(messages.free)}
                            </dt>
                            <dd
                              className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-base font-semibold"
                              style={{ color: freeSpaceColor }}
                              data-testid={`storage-capacity-free-${volume.volumeKey ?? volume.id}`}
                            >
                              <span className="whitespace-nowrap">
                                {capacity(volume.freeSpace, unknown)}
                              </span>{' '}
                              <span className="whitespace-nowrap font-normal">
                                ({formatPercentage(freePercentage, unknown)})
                              </span>
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <div className={overflowRoute ? 'relative mt-8' : 'mt-3'}>
                        {overflowRoute &&
                          overflowThresholdPercentage !== null && (
                            <div
                              className="pointer-events-none absolute inset-y-0 z-10 border-r-2 border-dashed border-white"
                              style={{
                                right: `${overflowThresholdPercentage}%`,
                              }}
                              data-testid={`storage-overflow-threshold-${volume.id}`}
                              aria-label={`Overflow threshold ${overflowRoute.thresholdGb} GB`}
                            >
                              <span className="absolute bottom-full right-0 mb-1 whitespace-nowrap text-xs font-medium text-gray-200">
                                {overflowRoute.thresholdGb} GB
                              </span>
                            </div>
                          )}
                        <div
                          className="flex h-3.5 overflow-hidden rounded-full bg-gray-700"
                          data-testid={`storage-volume-bar-${volume.volumeKey ?? volume.id}`}
                          role={
                            occupiedPercentage === null
                              ? undefined
                              : 'progressbar'
                          }
                          aria-label={intl.formatMessage(messages.used)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={
                            occupiedPercentage === null
                              ? undefined
                              : Math.round(occupiedPercentage)
                          }
                        >
                          {volume.segments.flatMap((segment) => {
                            const {
                              retainedPercentage,
                              leavingSoonPercentage,
                            } = rootSegmentWidths(segment, volume);

                            return [
                              <div
                                key={`${segment.id}:retained`}
                                data-testid={`storage-segment-${segment.id}`}
                                className="h-full"
                                style={{
                                  width: `${retainedPercentage}%`,
                                  backgroundColor: segment.color,
                                }}
                                aria-hidden
                              />,
                              ...(leavingSoonPercentage > 0
                                ? [
                                    <div
                                      key={`${segment.id}:leaving-soon`}
                                      data-testid={`storage-leaving-soon-segment-${segment.id}`}
                                      className="h-full shrink-0"
                                      style={{
                                        width: `${leavingSoonPercentage}%`,
                                        ...leavingSoonHatch,
                                      }}
                                      aria-hidden
                                    />,
                                  ]
                                : []),
                            ];
                          })}
                          {volume.unaccountedUsageBytes !== null && (
                            <div
                              className="h-full bg-gray-500"
                              style={{ width: `${otherPercentage}%` }}
                              aria-hidden
                            />
                          )}
                          {hasPositiveBytes(volume.provisionedSpaceBytes) && (
                            <div
                              data-testid={`storage-provisioned-segment-${volume.volumeKey ?? volume.id}`}
                              className="h-full bg-amber-500"
                              style={{ width: `${provisionedPercentage}%` }}
                              aria-hidden
                            />
                          )}
                          {volume.freeSpace !== null &&
                            freePercentage !== null && (
                              <div
                                data-testid={`storage-free-space-segment-${volume.volumeKey ?? volume.id}`}
                                className="h-full"
                                style={{
                                  width: `${freePercentage}%`,
                                  backgroundColor: freeSpaceColor,
                                }}
                                aria-hidden
                              />
                            )}
                        </div>
                      </div>
                      <dl
                        className="mt-3 flex flex-wrap gap-2 text-sm"
                        data-testid={`storage-volume-legend-${volume.volumeKey ?? volume.id}`}
                      >
                        {volume.segments.map((segment) => {
                          const { retainedBytes, retainedPercentage } =
                            rootSegmentWidths(segment, volume);

                          if (!shouldShowCategoryLegend(retainedBytes)) {
                            return null;
                          }

                          return (
                            <div
                              key={segment.id}
                              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-gray-900/30 px-2.5 py-1.5"
                              data-testid={`storage-segment-legend-${segment.id}`}
                            >
                              <dt className="flex min-w-0 items-center gap-2 text-gray-400">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                                  style={{ backgroundColor: segment.color }}
                                  aria-hidden
                                />
                                <span className="break-words">
                                  {segment.label}
                                </span>
                              </dt>
                              <dd className="whitespace-nowrap font-semibold">
                                <span className="sr-only">
                                  {intl.formatMessage(messages.used)}:{' '}
                                </span>
                                {libraryCapacity(retainedBytes, unknown)}{' '}
                                <span className="font-normal text-gray-400">
                                  (
                                  {formatPercentage(
                                    retainedPercentage,
                                    unknown
                                  )}
                                  )
                                </span>
                              </dd>
                            </div>
                          );
                        })}
                        {shouldShowCategoryLegend(
                          volume.pendingRemovalBytes
                        ) && (
                          <div
                            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-gray-900/30 px-2.5 py-1.5"
                            data-testid={`storage-leaving-soon-legend-${volume.id}`}
                          >
                            <dt className="flex items-center gap-2 text-gray-400">
                              <span
                                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                                style={leavingSoonHatch}
                                aria-hidden
                              />
                              <span>
                                {intl.formatMessage(messages.pendingRemoval)}
                              </span>
                            </dt>
                            <dd className="whitespace-nowrap font-semibold text-yellow-200">
                              {libraryCapacity(
                                volume.pendingRemovalBytes,
                                unknown
                              )}{' '}
                              <span className="font-normal text-gray-400">
                                (
                                {formatPercentage(
                                  volume.pendingRemovalPercentage,
                                  unknown
                                )}
                                )
                              </span>
                            </dd>
                          </div>
                        )}
                        {shouldShowCategoryLegend(
                          volume.unaccountedUsageBytes
                        ) && (
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-gray-900/30 px-2.5 py-1.5">
                            <dt className="flex items-center gap-2 text-gray-400">
                              <span
                                className="h-2.5 w-2.5 rounded-sm bg-gray-500"
                                aria-hidden
                              />
                              <span>{intl.formatMessage(messages.other)}</span>
                            </dt>
                            <dd className="whitespace-nowrap font-semibold">
                              {libraryCapacity(
                                volume.unaccountedUsageBytes,
                                unknown
                              )}{' '}
                              <span className="font-normal text-gray-400">
                                (
                                {formatPercentage(
                                  volume.unaccountedUsageBytes === null
                                    ? null
                                    : otherPercentage,
                                  unknown
                                )}
                                )
                              </span>
                            </dd>
                          </div>
                        )}
                        <div
                          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-gray-900/30 px-2.5 py-1.5"
                          data-testid={`storage-free-legend-${
                            volume.volumeKey ?? volume.id
                          }`}
                        >
                          <dt className="flex items-center gap-2 text-gray-400">
                            <span
                              className="h-2.5 w-2.5 rounded-sm"
                              style={{ backgroundColor: freeSpaceColor }}
                              aria-hidden
                            />
                            {intl.formatMessage(messages.free)}
                          </dt>
                          <dd
                            className="whitespace-nowrap font-semibold"
                            style={{ color: freeSpaceColor }}
                          >
                            {capacity(volume.freeSpace, unknown)}{' '}
                            <span className="font-normal">
                              ({formatPercentage(freePercentage, unknown)})
                            </span>
                          </dd>
                        </div>
                        {volume.provisionedSpaceBytes !== null &&
                          shouldShowCategoryLegend(
                            volume.provisionedSpaceBytes
                          ) && (
                            <div
                              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-gray-900/30 px-2.5 py-1.5"
                              data-testid={`storage-provisioned-legend-${volume.volumeKey ?? volume.id}`}
                            >
                              <dt className="flex items-center gap-2 text-gray-400">
                                <span
                                  className="h-2.5 w-2.5 rounded-sm bg-amber-500"
                                  aria-hidden
                                />
                                {intl.formatMessage(messages.provisioned)}
                              </dt>
                              <dd className="whitespace-nowrap font-semibold">
                                {libraryCapacity(
                                  volume.provisionedSpaceBytes,
                                  unknown
                                )}{' '}
                                <span className="font-normal text-gray-400">
                                  (
                                  {formatPercentage(
                                    provisionedPercentage,
                                    unknown
                                  )}
                                  )
                                </span>
                              </dd>
                            </div>
                          )}
                      </dl>
                      {!volume.pendingRemovalAvailable && (
                        <p
                          className="mt-3 text-xs text-yellow-200"
                          data-testid={`storage-leaving-soon-unavailable-${volume.id}`}
                        >
                          {intl.formatMessage(
                            messages.pendingRemovalUnavailable
                          )}
                        </p>
                      )}
                      {volume.pendingRemovalAvailable &&
                        !volume.pendingRemovalComplete && (
                          <p className="mt-2 text-xs text-yellow-200">
                            {intl.formatMessage(
                              messages.pendingRemovalIncomplete,
                              {
                                count: volume.omittedRemovalScheduleCount,
                              }
                            )}
                          </p>
                        )}
                      {(volume.capacityReadingsDiffer ||
                        volume.usageExceedsPhysical) && (
                        <div className="mt-4 space-y-2 text-xs text-yellow-200">
                          {volume.capacityReadingsDiffer && (
                            <p>
                              {intl.formatMessage(messages.differingCapacity)}
                            </p>
                          )}
                          {volume.usageExceedsPhysical && (
                            <p>
                              {intl.formatMessage(
                                messages.usageExceedsPhysical
                              )}
                            </p>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section
            className="mt-8 border-t border-gray-700 pt-6"
            data-testid="storage-overflow-routing-section"
          >
            <h2 className="text-xl font-bold">
              {intl.formatMessage(messages.storageRouting)}
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.routesDescription)}
            </p>
            <div className="storage-routing-container mt-5 rounded-lg bg-gray-800 p-5 text-white shadow ring-1 ring-gray-700">
              <div
                className="storage-route-grid storage-add-route-grid"
                data-testid="storage-add-route"
              >
                <div className="storage-route-source min-w-0">
                  <label
                    htmlFor="overflow-source"
                    className="whitespace-nowrap"
                  >
                    {intl.formatMessage(messages.source)}
                  </label>
                  <select
                    id="overflow-source"
                    className="h-10 w-full"
                    value={sourceVolumeId}
                    onChange={(event) => {
                      const nextSourceId = event.target.value;
                      setSourceVolumeId(nextSourceId);
                      setDestinationVolumeId('');
                      setRouteThresholdInput(
                        String(DEFAULT_OVERFLOW_THRESHOLD_GB)
                      );
                    }}
                  >
                    <option value="">
                      {intl.formatMessage(messages.chooseSource)}
                    </option>
                    {routableVolumes.map((volume) => (
                      <option key={volume.id} value={volume.id}>
                        {volume.name}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="storage-route-arrow flex min-h-10 items-center justify-center">
                  <ArrowRightIcon
                    className="storage-route-arrow-icon h-5 w-5 text-gray-400"
                    aria-hidden
                  />
                </span>
                <div className="storage-route-target min-w-0">
                  <label
                    htmlFor="overflow-destination"
                    className="whitespace-nowrap"
                  >
                    {intl.formatMessage(messages.destination)}
                  </label>
                  <select
                    id="overflow-destination"
                    className="h-10 w-full"
                    value={destinationVolumeId}
                    onChange={(event) =>
                      setDestinationVolumeId(event.target.value)
                    }
                    disabled={!sourceVolume}
                  >
                    <option value="">
                      {intl.formatMessage(messages.chooseDestination)}
                    </option>
                    {destinations.map((volume) => (
                      <option key={volume.id} value={volume.id}>
                        {volume.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="storage-route-threshold min-w-0">
                  <label
                    htmlFor="overflow-route-threshold"
                    className="whitespace-nowrap"
                  >
                    {intl.formatMessage(messages.routeThreshold)}
                  </label>
                  <input
                    id="overflow-route-threshold"
                    data-testid="overflow-route-threshold"
                    className="storage-route-threshold-control h-10 w-full"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={routeThresholdInput}
                    aria-invalid={
                      sourceVolume ? !routeThresholdValid : undefined
                    }
                    disabled={!sourceVolume}
                    onChange={(event) =>
                      setRouteThresholdInput(event.target.value)
                    }
                  />
                </div>
                <Button
                  buttonType="primary"
                  className="storage-route-actions h-10 justify-self-start"
                  disabled={!pendingRoute || duplicateRoute}
                  onClick={() => {
                    if (!pendingRoute) return;
                    setValues({
                      ...values,
                      routes: [...values.routes, pendingRoute],
                      defaultSeriesVolumeId:
                        values.defaultSeriesVolumeId ??
                        (sourceVolume?.locationIds.some(
                          (id) => locationById.get(id)?.provider === 'sonarr'
                        )
                          ? sourceVolume.id
                          : null),
                      expansionSeriesVolumeId:
                        values.expansionSeriesVolumeId ??
                        (selectedDestination?.locationIds.some(
                          (id) => locationById.get(id)?.provider === 'sonarr'
                        )
                          ? selectedDestination.id
                          : null),
                    });
                    setSourceVolumeId('');
                    setDestinationVolumeId('');
                    setRouteThresholdInput(
                      String(DEFAULT_OVERFLOW_THRESHOLD_GB)
                    );
                  }}
                >
                  <PlusIcon className="mr-2 h-4 w-4" aria-hidden />
                  {intl.formatMessage(messages.addRoute)}
                </Button>
              </div>
              {sourceVolume && destinations.length === 0 && (
                <p className="mt-2 text-xs text-yellow-200" role="status">
                  {intl.formatMessage(messages.noCompatibleDestinations)}
                </p>
              )}
              {sourceVolume && !routeThresholdValid && (
                <p className="mt-2 text-xs text-red-400" role="alert">
                  {intl.formatMessage(messages.routeThresholdInvalid)}
                </p>
              )}
              <div className="mt-5 space-y-3">
                {values.routes.map((route) => {
                  const key = overflowRouteKey(route);
                  const sourceName = volumeLabel(route.sourceVolumeId);
                  const destinationName = volumeLabel(
                    route.destinationVolumeId
                  );
                  const sourceCapacity = volumes.find(
                    (volume) => volume.id === route.sourceVolumeId
                  )?.totalSpace;
                  const maximumThreshold = sourceCapacity
                    ? Math.floor(sourceCapacity / BYTES_PER_OVERFLOW_GB)
                    : null;
                  const thresholdValid =
                    isOverflowThresholdGb(route.thresholdGb) &&
                    (maximumThreshold === null ||
                      route.thresholdGb <= maximumThreshold);
                  return (
                    <div
                      key={key}
                      className="storage-route-grid storage-saved-route-grid"
                      data-testid="storage-saved-route"
                    >
                      <strong className="storage-route-source min-w-0 break-words text-sm">
                        {sourceName}
                      </strong>
                      <span className="storage-route-arrow flex min-h-10 items-center justify-center">
                        <ArrowRightIcon
                          className="storage-route-arrow-icon h-4 w-4 text-gray-400"
                          aria-hidden
                        />
                      </span>
                      <strong className="storage-route-target min-w-0 break-words text-sm">
                        {destinationName}
                      </strong>
                      <input
                        className="storage-route-threshold storage-route-threshold-control h-10 w-full"
                        aria-label={`${sourceName} ${intl.formatMessage(
                          messages.routeThreshold
                        )}`}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={route.thresholdGb}
                        aria-invalid={!thresholdValid}
                        onChange={(event) => {
                          const thresholdGb = Number(event.target.value);
                          setValues({
                            ...values,
                            routes: values.routes.map((candidate) =>
                              overflowRouteKey(candidate) === key
                                ? { ...candidate, thresholdGb }
                                : candidate
                            ),
                          });
                        }}
                      />
                      <div className="storage-route-actions flex h-10 items-center gap-3 justify-self-start">
                        <SlideCheckbox
                          checked={route.enabled}
                          ariaLabel={`${sourceName} to ${destinationName}`}
                          onClick={() =>
                            setValues({
                              ...values,
                              routes: values.routes.map((candidate) =>
                                overflowRouteKey(candidate) === key
                                  ? {
                                      ...candidate,
                                      enabled: !candidate.enabled,
                                    }
                                  : candidate
                              ),
                            })
                          }
                        />
                        <Button
                          buttonType="danger"
                          className="h-10"
                          aria-label={intl.formatMessage(messages.removeRoute, {
                            source: sourceName,
                            destination: destinationName,
                          })}
                          onClick={() =>
                            setValues({
                              ...values,
                              routes: values.routes.filter(
                                (candidate) =>
                                  overflowRouteKey(candidate) !== key
                              ),
                            })
                          }
                        >
                          <TrashIcon className="h-4 w-4" aria-hidden />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {!overflowRoutingActivationValid && (
                <p
                  className="mt-3 text-sm text-red-400"
                  data-testid="overflow-route-required-error"
                  role="alert"
                >
                  {intl.formatMessage(messages.overflowRouteRequired)}
                </p>
              )}
            </div>
          </section>

          <section
            className="mt-8 border-t border-gray-700 pt-6"
            data-testid="storage-series-routing-section"
          >
            <h2 className="text-xl font-bold">
              {intl.formatMessage(messages.seriesRouting)}
            </h2>
            <p className="mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.seriesRoutingDescription)}
            </p>
            <div className="mt-5 rounded-lg bg-gray-800 p-5 text-white shadow ring-1 ring-gray-700">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-[180px_180px] md:justify-start md:gap-x-5 md:gap-y-5 xl:grid-cols-[180px_180px_125px_150px]">
                {(
                  [
                    ['defaultSeriesVolumeId', messages.defaultSeriesVolume],
                    ['expansionSeriesVolumeId', messages.expansionSeriesVolume],
                  ] as const
                ).map(([field, label]) => (
                  <div key={field} className="min-w-0">
                    <label htmlFor={field} className="whitespace-nowrap">
                      {intl.formatMessage(label)}
                    </label>
                    <select
                      id={field}
                      className="h-10 md:w-[180px]"
                      value={values[field] ?? ''}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          [field]: event.target.value || null,
                        })
                      }
                    >
                      <option value="">
                        {intl.formatMessage(messages.chooseVolume)}
                      </option>
                      {sonarrVolumes.map((volume) => (
                        <option key={volume.id} value={volume.id}>
                          {volume.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <div className="min-w-0">
                  <label
                    htmlFor="seriesSeasonThreshold"
                    className="whitespace-nowrap"
                  >
                    {intl.formatMessage(messages.seriesSeasonThreshold)}
                  </label>
                  <input
                    id="seriesSeasonThreshold"
                    className="h-10 md:w-[110px]"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={values.seriesSeasonThreshold}
                    aria-invalid={
                      !isSeriesSeasonThreshold(values.seriesSeasonThreshold)
                    }
                    onChange={(event) =>
                      setValues({
                        ...values,
                        seriesSeasonThreshold: Number(event.target.value),
                      })
                    }
                  />
                </div>
                <div className="min-w-0">
                  <label
                    htmlFor="torrentRelocationDelayHours"
                    className="whitespace-nowrap"
                  >
                    {intl.formatMessage(messages.torrentRelocationDelay)}
                  </label>
                  <input
                    id="torrentRelocationDelayHours"
                    className="h-10 md:w-[140px]"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={values.torrentRelocationDelayHours}
                    aria-invalid={
                      !isTorrentRelocationDelayHours(
                        values.torrentRelocationDelayHours
                      )
                    }
                    onChange={(event) =>
                      setValues({
                        ...values,
                        torrentRelocationDelayHours: Number(event.target.value),
                      })
                    }
                  />
                </div>
                {!automaticSeriesPlacementVolumesValid && (
                  <p
                    className="text-sm text-red-400 md:col-span-2 xl:col-span-4"
                    role="alert"
                  >
                    {intl.formatMessage(messages.seriesPreferencesInvalid)}
                  </p>
                )}
                {!seriesRelocationVolumesValid && (
                  <p
                    className="text-sm text-red-400 md:col-span-2 xl:col-span-4"
                    role="alert"
                  >
                    {intl.formatMessage(
                      messages.seriesRelocationConfigurationInvalid
                    )}
                  </p>
                )}
                {!seriesRelocationPolicyValid && (
                  <p
                    className="text-sm text-red-400 md:col-span-2 xl:col-span-4"
                    role="alert"
                  >
                    {intl.formatMessage(messages.seriesRelocationPolicyInvalid)}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section
            className="mt-8 border-t border-gray-700 pt-6"
            data-testid="storage-automation-section"
          >
            <h2 className="text-xl font-bold">
              {intl.formatMessage(messages.automation)}
            </h2>
            {(jobsError || (jobs && !seriesRelocationJob)) && (
              <p className="mt-2 text-sm text-red-400" role="alert">
                {intl.formatMessage(messages.seriesRelocationUnavailable)}
              </p>
            )}
            <div className="mt-4 space-y-4">
              <div
                className="flex min-h-12 items-center justify-between gap-4"
                data-testid="automation-overflow-routing-row"
              >
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">
                    {intl.formatMessage(messages.overflowRouting)}
                  </h3>
                  <p className="mt-0.5 text-sm text-gray-400">
                    {intl.formatMessage(messages.overflowRoutingDescription)}
                  </p>
                </div>
                <SlideCheckbox
                  checked={values.enabled}
                  ariaLabel={intl.formatMessage(messages.overflowRouting)}
                  onClick={() =>
                    setValues((current) =>
                      current
                        ? setOverflowRoutingEnabled(current, !current.enabled)
                        : current
                    )
                  }
                />
              </div>
              <div
                className="flex min-h-12 items-center justify-between gap-4"
                data-testid="automation-automatic-series-placement-row"
              >
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold">
                    {intl.formatMessage(messages.automaticSeriesPlacement)}
                  </h3>
                  <p className="mt-0.5 text-sm text-gray-400">
                    {intl.formatMessage(
                      messages.automaticSeriesPlacementDescription
                    )}
                  </p>
                </div>
                <SlideCheckbox
                  checked={values.automaticSeriesPlacement}
                  ariaLabel={intl.formatMessage(
                    messages.automaticSeriesPlacement
                  )}
                  onClick={() =>
                    setValues((current) =>
                      current
                        ? setAutomaticSeriesPlacementEnabled(
                            current,
                            !current.automaticSeriesPlacement
                          )
                        : current
                    )
                  }
                />
              </div>
              <div data-testid="automation-series-relocation-row">
                <div className="flex min-h-12 items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">
                      {intl.formatMessage(messages.seriesRelocation)}
                    </h3>
                    <p className="mt-0.5 text-sm text-gray-400">
                      {intl.formatMessage(messages.seriesRelocationDescription)}
                    </p>
                  </div>
                  <SlideCheckbox
                    checked={seriesRelocationJob?.enabled ?? false}
                    disabled={
                      !seriesRelocationJob?.configurableEnabled ||
                      savingSeriesRelocation
                    }
                    ariaLabel={intl.formatMessage(messages.seriesRelocation)}
                    onClick={() =>
                      void setSeriesRelocationEnabled(
                        !(seriesRelocationJob?.enabled ?? false)
                      )
                    }
                  />
                </div>
                <div
                  className="mt-3 border-l-2 border-gray-700 pl-3"
                  data-testid="series-relocation-next-candidate"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold">
                      {intl.formatMessage(messages.nextCandidate)}
                    </h4>
                    <Button
                      buttonSize="sm"
                      buttonType="default"
                      aria-busy={refreshingSeriesRelocationPreview}
                      aria-label={intl.formatMessage(messages.refreshCandidate)}
                      disabled={
                        refreshingSeriesRelocationPreview ||
                        seriesRelocationPreviewStale
                      }
                      onClick={() => void refreshSeriesRelocationPreview()}
                    >
                      <ArrowPathIcon
                        className={`mr-1.5 h-3.5 w-3.5 ${
                          refreshingSeriesRelocationPreview
                            ? 'animate-spin'
                            : ''
                        }`}
                        aria-hidden
                      />
                      {intl.formatMessage(messages.refreshCandidate)}
                    </Button>
                  </div>
                  {seriesRelocationPreviewStale ? (
                    <p className="mt-1.5 text-sm text-yellow-200" role="status">
                      {intl.formatMessage(messages.candidateStale)}
                    </p>
                  ) : refreshingSeriesRelocationPreview ? (
                    <p className="mt-1.5 text-sm text-gray-400" role="status">
                      {intl.formatMessage(messages.candidateLoading)}
                    </p>
                  ) : seriesRelocationPreviewError ||
                    seriesRelocationPreview?.status === 'unavailable' ? (
                    <p className="mt-1.5 text-sm text-red-400" role="alert">
                      {intl.formatMessage(messages.candidateUnavailable)}
                    </p>
                  ) : seriesRelocationPreview?.status === 'none' ? (
                    <p className="mt-1.5 text-sm text-gray-400">
                      {intl.formatMessage(messages.candidateNone)}
                    </p>
                  ) : seriesRelocationPreview?.status === 'eligible' &&
                    seriesRelocationPreview.candidate ? (
                    <div className="mt-1.5 text-sm">
                      {seriesRelocationPreview.candidate.sonarrUrl ? (
                        <a
                          href={seriesRelocationPreview.candidate.sonarrUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-white transition duration-300 hover:underline"
                        >
                          {seriesRelocationPreview.candidate.title}
                          {seriesRelocationPreview.candidate.year !== null
                            ? ` (${seriesRelocationPreview.candidate.year})`
                            : ''}
                        </a>
                      ) : (
                        <p className="font-medium text-white">
                          {seriesRelocationPreview.candidate.title}
                          {seriesRelocationPreview.candidate.year !== null
                            ? ` (${seriesRelocationPreview.candidate.year})`
                            : ''}
                        </p>
                      )}
                      <p className="text-gray-400">
                        {intl.formatMessage(messages.candidateSummary, {
                          count:
                            seriesRelocationPreview.candidate
                              .retainedSeasonCount,
                          size: formatBytes(
                            Number(seriesRelocationPreview.candidate.totalBytes)
                          ),
                        })}
                      </p>
                    </div>
                  ) : (
                    <p className="mt-1.5 text-sm text-gray-400">
                      {intl.formatMessage(messages.candidateIdle)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </section>
          <div className="actions">
            <Button
              buttonType="primary"
              disabled={
                !dirty ||
                !freeSpaceThresholdValid ||
                !routeThresholdsValid ||
                !overflowRoutingActivationValid ||
                !seriesPreferencesValid ||
                saving
              }
              onClick={() => void save()}
            >
              {intl.formatMessage(saving ? messages.saving : messages.save)}
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
};

export default SettingsStorage;
