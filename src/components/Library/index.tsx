import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import MediaTypeFilter from '@app/components/Common/MediaTypeFilter';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import useDebouncedState from '@app/hooks/useDebouncedState';
import useToasts from '@app/hooks/useToasts';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  Popover,
  PopoverButton,
  PopoverPanel,
  Transition,
} from '@headlessui/react';
import {
  ArrowPathIcon,
  BarsArrowDownIcon,
  CalendarDateRangeIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDoubleLeftIcon as ChevronsLeftIcon,
  ChevronDoubleRightIcon as ChevronsRightIcon,
  FunnelIcon,
  InformationCircleIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import type { RemovalSettings } from '@server/constants/removal';
import type {
  LibraryBulkAction,
  LibraryBulkActionEligibilityResponse,
  LibraryBulkActionResponse,
  LibraryBulkActionResult,
  LibraryBulkActionTarget,
  LibraryFilterUsersResponse,
  LibraryItem,
  LibraryPresentationStatus,
  LibraryResultsResponse,
  LibrarySelectionSizeResponse,
} from '@server/interfaces/api/libraryInterfaces';
import { Permission } from '@server/lib/permissions';
import axios from 'axios';
import { useRouter } from 'next/router';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as mutateSWR } from 'swr';
import FilterSlideover from './FilterSlideover';
import LibraryResults from './LibraryResults';
import LibrarySelectionCheckbox from './LibrarySelectionCheckbox';
import {
  getLibraryBulkActionEligibilityDisplayPresentation,
  getLibraryBulkActionEligibilityPresentation,
} from './bulkActionEligibility';
import { getLibraryBulkActionPresentation } from './bulkActionPresentation';
import {
  emptyLibraryFilterUserSnapshot,
  getLibraryFilterUsersForPresentation,
} from './filterUsers';
import { stabilizeLibraryItems } from './libraryItemIdentity';
import {
  getLibraryNearbyPages,
  getLibraryPaginationItems,
  getLibraryPaginationPresentation,
  type LibraryPaginationItem,
} from './pagination';
import {
  countActiveLibraryFilters,
  getInitialLibraryPreferenceState,
  getLibraryPreferenceKey,
  hasLibraryUserAssociationFilter,
  libraryPreferencesToQuery,
  normalizeLibraryPreferences,
  readLibraryPreferences,
  resolveLibraryPreferences,
  type LibraryPreferences,
} from './preferences';
import { formatLibrarySize } from './presentation';
import { serializeLibraryQuery } from './query';
import {
  createEmptyLibrarySelection,
  deselectLibraryPage,
  getLibraryBulkActionTargetCounts,
  getLibraryBulkActionTargets,
  getLibraryPageSelectionState,
  hasSelectableLibraryPageItems,
  reconcileLibrarySelectionAfterBulkAction,
  selectLibraryPage,
  updateLibrarySelection,
  type LibrarySelectionKey,
  type LibrarySelectionTarget,
} from './selection';
import { getLibrarySelectionSizePresentation } from './selectionSize';

const messages = defineMessages('components.Library', {
  title: 'Library',
  search: 'Search Library',
  unableToLoad: 'Unable to load Library.',
  noItems: 'No Library items match these filters.',
  sourceWarning: 'Library data may be incomplete',
  collectionMembershipUnknown:
    '{count, plural, one {# Movie awaiting collection metadata is excluded from this filter.} other {# Movies awaiting collection metadata are excluded from this filter.}}',
  incompleteSources: 'Incomplete sources',
  libraryHydration: 'Library hydration',
  currentViewing: 'Current viewing',
  historicalViewing: 'Historical viewing',
  incompleteSourcesLabel: 'Incomplete sources: {sources}',
  series: 'Series',
  filters: 'Filters',
  activeFilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  mediaType: 'Media type',
  movies: 'Movies',
  sort: 'Sort',
  sortTitleAsc: 'Title (A-Z) Ascending',
  sortTitleDesc: 'Title (Z-A) Descending',
  sortAddedDesc: 'Added Descending',
  sortAddedAsc: 'Added Ascending',
  sortLastActiveDesc: 'Last Active Descending',
  sortLastActiveAsc: 'Last Active Ascending',
  sortSizeDesc: 'Size Descending',
  sortSizeAsc: 'Size Ascending',
  sortRemovedDesc: 'Removed Descending',
  sortRemovedAsc: 'Removed Ascending',
  sortWatchedUsersDesc: 'Watched Users Descending',
  sortWatchedUsersAsc: 'Watched Users Ascending',
  loadingPage: 'Loading Library page.',
  firstPage: 'First page',
  lastPage: 'Last page',
  pageNumber: 'Page {pageNumber}',
  showingItems:
    'Showing <strong>{from}</strong> to <strong>{to}</strong> of <strong>{total}</strong> items',
  itemsPerPage: 'Items per page',
  perPage: 'Per page',
  selectionToolbar: 'Library selection',
  selectedItems: '{count, plural, one {# item} other {# items}}',
  selectedSizeUnavailable: 'Size unavailable',
  selectedSizeSomeUnknown: 'Some selected files do not report a storage size.',
  selectedSizeUpdating: 'Updating selected storage size.',
  clearAllSelections: 'Clear all selections',
  selectCurrentPage: 'Select current Library page',
  deselectCurrentPage: 'Deselect current Library page',
  scheduleEligibleCount:
    '{count, plural, one {Schedule removal for # item} other {Schedule removal for # items}}',
  cancelEligibleCount:
    '{count, plural, one {Cancel scheduled removal for # item} other {Cancel scheduled removal for # items}}',
  checkingBulkEligibility: 'Checking Schedule and Cancel availability.',
  retryBulkEligibility:
    'Unable to check Schedule and Cancel availability. Retry.',
  bulkEligibilityUnavailable: 'Schedule and Cancel unavailable: {reasons}',
  eligibilityProcessing: 'removal processing is in progress',
  eligibilitySeriesScheduled: 'all Seasons are covered by a Series schedule',
  eligibilityNotCurrent: 'media is not currently available',
  eligibilityMissing: 'media is missing',
  eligibilityAmbiguous: 'multiple current sources were found',
  eligibilityAcquisition: 'an acquisition is active',
  eligibilityIdentity: 'media identity does not match',
  eligibilityConfiguration: 'the Servarr source is not configured',
  eligibilityUnavailableReason: 'eligibility could not be confirmed',
  removeSelected: 'Remove',
  removeSelectedCount:
    '{count, plural, one {Remove # item} other {Remove # items}}',
  scheduleConfirm: 'Schedule',
  cancelConfirm: 'Confirm',
  scheduleTitle:
    '{count, plural, one {Schedule removal for # item?} other {Schedule removal for # items?}}',
  cancelTitle:
    '{count, plural, one {Cancel scheduled removal for # item?} other {Cancel scheduled removal for # items?}}',
  removeTitle:
    '{count, plural, one {Remove # item from library?} other {Remove # items from library?}}',
  removeMovieCount: '{count, plural, one {# Movie} other {# Movies}}',
  removeSeriesCount: '{count, plural, one {# Series} other {# Series}}',
  removeSeasonCount: '{count, plural, one {# Season} other {# Seasons}}',
  runningBatch: 'Processing selected items…',
  batchSummary: 'Bulk action result',
  scheduleSuccess:
    '{count, plural, one {# item scheduled for removal} other {# items scheduled for removal}} in {days} days',
  schedulePartial:
    '{completed, plural, one {# item scheduled} other {# items scheduled}} · {failed, plural, one {# failed} other {# failed}}',
  scheduleFailure:
    '{count, plural, one {Unable to schedule # item} other {Unable to schedule # items}}',
  cancelSuccess:
    '{count, plural, one {# scheduled removal cancelled} other {# scheduled removals cancelled}}',
  cancelPartial:
    '{completed, plural, one {# scheduled removal cancelled} other {# scheduled removals cancelled}} · {failed, plural, one {# failed} other {# failed}}',
  cancelFailure:
    '{count, plural, one {Unable to cancel # scheduled removal} other {Unable to cancel # scheduled removals}}',
  removeSuccess:
    '{count, plural, one {# removal request completed} other {# removal requests completed}}',
  removePartial:
    '{completed, plural, one {# removal request completed} other {# removal requests completed}} · {failed, plural, one {# failed} other {# failed}}',
  removeFailure:
    '{count, plural, one {Unable to complete # removal request} other {Unable to complete # removal requests}}',
  removeVerification:
    'Provider acknowledgment does not independently verify physical deletion.',
  viewFailures: 'View failures',
  hideFailures: 'Hide failures',
  retrySelected: 'Retry failed items',
  movieTarget: 'Movie',
  seriesTarget: 'Series',
  seasonTarget: 'Season {seasonNumber}',
  specialsTarget: 'Specials',
  failureMissing: 'Media could not be found.',
  failureNotCurrent: 'Media is no longer currently available for this action.',
  failureAmbiguous:
    'Multiple current service sources were found. Resolve the source conflict and try again.',
  failureAcquisition: 'An acquisition is active. Try again after it finishes.',
  failureInProgress:
    'A removal operation is already in progress. Try again later.',
  failureIdentity: 'Media identity no longer matches the configured service.',
  failureCrossSeason:
    'A file is shared across Seasons and cannot be removed safely.',
  failureReconciliation:
    'The provider may have completed removal, but Library reconciliation failed. Do not retry automatically.',
  failureNotAttempted:
    'This item was not attempted because the batch could not continue safely.',
  failureGeneric: 'This item could not be processed safely.',
  dismissResult: 'Dismiss result',
});

const emptyQueryParams = {};

const bulkTargetKey = (target: LibraryBulkActionTarget) =>
  `${target.targetType}:${target.canonicalMediaId}:${
    target.seasonNumber ?? ''
  }`;

const Library = () => {
  const router = useRouter();
  const intl = useIntl();
  const { addToast } = useToasts();
  const updateQuery = useBatchUpdateQueryParams(emptyQueryParams);
  const { user: currentUser, hasPermission } = useUser();
  const initialPreferenceState = getInitialLibraryPreferenceState({
    query: router.query,
    routeReady: router.isReady,
  });
  const [preferences, setPreferences] = useState<LibraryPreferences>(
    initialPreferenceState.preferences
  );
  const [preferencesReady, setPreferencesReady] = useState(
    initialPreferenceState.ready
  );
  const [showFilters, setShowFilters] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<
    ReadonlySet<LibrarySelectionKey>
  >(createEmptyLibrarySelection);
  const [bulkEligibilityRevision, setBulkEligibilityRevision] = useState(0);
  const [bulkAction, setBulkAction] = useState<LibraryBulkAction | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkResult, setBulkResult] =
    useState<LibraryBulkActionResponse | null>(null);
  const [showBulkFailures, setShowBulkFailures] = useState(false);
  const [bulkTargetOverride, setBulkTargetOverride] = useState<
    LibraryBulkActionTarget[] | null
  >(null);
  const bulkActionTrigger = useRef<HTMLButtonElement | null>(null);
  const bulkSubmissionInFlight = useRef(false);
  const bulkTargetLabels = useRef(new Map<string, string>());
  const selectionToolbar = useRef<HTMLDivElement | null>(null);
  const [filterUserSnapshot, setFilterUserSnapshot] = useState(
    emptyLibraryFilterUserSnapshot
  );
  const latestFilterUserQuery = useRef<string | null>(null);
  const queryValue = (key: string) =>
    typeof router.query[key] === 'string' ? String(router.query[key]) : '';
  const page = Math.max(1, Number(queryValue('page')) || 1);
  const pageSize = preferences.pageSize;
  const { scope, mediaType, sort, sortDirection } = preferences;
  const userSelectionEnabled = hasLibraryUserAssociationFilter(preferences);
  const querySearch = queryValue('search');
  const [search, debouncedSearch, setSearch] = useDebouncedState(
    querySearch,
    300
  );
  useEffect(() => {
    if (!router.isReady || !currentUser?.id) return;
    const key = getLibraryPreferenceKey(currentUser.id);
    const stored = readLibraryPreferences(window.localStorage.getItem(key));
    const resolved = resolveLibraryPreferences({ query: router.query, stored });
    setPreferences(resolved);
    window.localStorage.setItem(key, JSON.stringify(resolved));
    setPreferencesReady(true);
    updateQuery(libraryPreferencesToQuery(resolved));
  }, [
    currentUser?.id,
    router.asPath,
    router.isReady,
    router.query,
    updateQuery,
  ]);

  const updatePreferences = (next: LibraryPreferences) => {
    const normalized = normalizeLibraryPreferences(next);
    setPreferences(normalized);
    if (currentUser?.id) {
      window.localStorage.setItem(
        getLibraryPreferenceKey(currentUser.id),
        JSON.stringify(normalized)
      );
    }
    updateQuery({ ...libraryPreferencesToQuery(normalized), page: '1' });
  };

  const changePreferences = (change: Partial<LibraryPreferences>) =>
    updatePreferences({ ...preferences, ...change });

  useEffect(() => setSearch(querySearch), [querySearch, setSearch]);
  useEffect(() => {
    if (router.isReady && debouncedSearch !== querySearch)
      updateQuery({ search: debouncedSearch || undefined, page: '1' });
  }, [debouncedSearch, querySearch, router.isReady, updateQuery]);
  const apiUrl = useMemo(() => {
    if (!preferencesReady) return null;
    const params = new URLSearchParams({
      take: String(pageSize),
      skip: String((page - 1) * pageSize),
      scope,
      watchlist: preferences.watchlist,
      watched: preferences.watched,
      requested: preferences.requested,
      activity: preferences.activity,
      mediaType,
      collectionMembership: preferences.collectionMembership,
      animation: preferences.animation,
      sort,
      sortDirection,
      scheduled: preferences.scheduled,
    });
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    if (preferences.userIds.length)
      params.set('userIds', preferences.userIds.join(','));
    if (preferences.storageRootIds.length)
      params.set('storageRootIds', preferences.storageRootIds.join(','));
    const optional = {
      addedFrom: preferences.addedFrom,
      addedTo: preferences.addedTo,
      activityFrom: preferences.activityFrom,
      activityTo: preferences.activityTo,
      removalDueFrom: preferences.removalDueFrom,
      removalDueTo: preferences.removalDueTo,
      removedFrom: preferences.removedFrom,
      removedTo: preferences.removedTo,
      removalSources: preferences.removalSources.length
        ? preferences.removalSources.join(',')
        : undefined,
    };
    Object.entries(optional).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return `/api/v1/library?${serializeLibraryQuery(params)}`;
  }, [
    debouncedSearch,
    mediaType,
    page,
    pageSize,
    preferences,
    preferencesReady,
    scope,
    sort,
    sortDirection,
  ]);
  const availabilityApiUrl = useMemo(() => {
    if (!preferencesReady || !showFilters) return null;
    const params = new URLSearchParams({
      scope,
      watchlist: preferences.watchlist,
      watched: preferences.watched,
      requested: preferences.requested,
      activity: preferences.activity,
      mediaType,
      collectionMembership: preferences.collectionMembership,
      animation: preferences.animation,
      scheduled: preferences.scheduled,
    });
    if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
    if (preferences.userIds.length)
      params.set('userIds', preferences.userIds.join(','));
    if (preferences.storageRootIds.length)
      params.set('storageRootIds', preferences.storageRootIds.join(','));
    const optional = {
      addedFrom: preferences.addedFrom,
      addedTo: preferences.addedTo,
      activityFrom: preferences.activityFrom,
      activityTo: preferences.activityTo,
      removalDueFrom: preferences.removalDueFrom,
      removalDueTo: preferences.removalDueTo,
      removedFrom: preferences.removedFrom,
      removedTo: preferences.removedTo,
      removalSources: preferences.removalSources.length
        ? preferences.removalSources.join(',')
        : undefined,
    };
    Object.entries(optional).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    return `/api/v1/library/user-availability?${serializeLibraryQuery(params)}`;
  }, [
    debouncedSearch,
    mediaType,
    preferences,
    preferencesReady,
    scope,
    showFilters,
  ]);
  const { data, error, mutate, isLoading, isValidating } =
    useSWR<LibraryResultsResponse>(apiUrl, { keepPreviousData: true });
  const stableLibraryItemsRef = useRef<LibraryItem[]>([]);
  const stableLibraryItems = useMemo(() => {
    return stabilizeLibraryItems(
      stableLibraryItemsRef.current,
      data?.results ?? []
    );
  }, [data?.results]);
  useEffect(() => {
    stableLibraryItemsRef.current = stableLibraryItems;
  }, [stableLibraryItems]);
  useEffect(() => {
    const batchId = data?.presentation?.batchId;
    if (data?.presentation?.state !== 'pending' || !batchId) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async () => {
      if (cancelled || attempts >= 40) return;
      attempts += 1;
      try {
        const { data: status } = await axios.get<LibraryPresentationStatus>(
          `/api/v1/library/presentation-status/${batchId}`
        );
        if (cancelled) return;
        if (status.state === 'pending') {
          timeout = setTimeout(poll, Math.min(500 * attempts, 2000));
          return;
        }
        if (status.state === 'complete' || status.state === 'partial') {
          await mutate();
        }
      } catch {
        // A transient status failure must not disturb Library state. The next
        // ordinary SWR revalidation can discover completed presentation data.
      }
    };
    timeout = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [data?.presentation?.batchId, data?.presentation?.state, mutate]);
  const isAdmin = hasPermission(Permission.ADMIN);
  const { data: removalSettings } = useSWR<RemovalSettings>(
    isAdmin ? '/api/v1/settings/removal' : null
  );
  useEffect(() => {
    data?.results.forEach((item) => {
      bulkTargetLabels.current.set(
        `${item.mediaType}:${item.canonicalMediaId}:`,
        item.title
      );
      if (item.mediaType === 'series') {
        item.seasonSummaries.forEach((season) => {
          bulkTargetLabels.current.set(
            `season:${item.canonicalMediaId}:${season.seasonNumber}`,
            `${item.title} · ${
              season.seasonNumber === 0
                ? intl.formatMessage(messages.specialsTarget)
                : intl.formatMessage(messages.seasonTarget, {
                    seasonNumber: season.seasonNumber,
                  })
            }`
          );
        });
      }
    });
  }, [data?.results, intl]);
  const bulkTargets = useMemo(
    () => getLibraryBulkActionTargets(selectedKeys),
    [selectedKeys]
  );
  const bulkEligibilityKey =
    isAdmin && bulkTargets.length > 0
      ? ([
          '/api/v1/library/bulk-actions/eligibility',
          bulkTargets,
          bulkEligibilityRevision,
        ] as const)
      : null;
  const {
    data: bulkEligibilityData,
    error: bulkEligibilityError,
    isValidating: bulkEligibilityValidating,
    mutate: mutateBulkEligibility,
  } = useSWR<LibraryBulkActionEligibilityResponse>(
    bulkEligibilityKey,
    ([url, targets]) =>
      axios
        .post<LibraryBulkActionEligibilityResponse>(url, { targets })
        .then(({ data }) => data),
    { keepPreviousData: true }
  );
  const bulkEligibilityPresentation = useMemo(
    () =>
      getLibraryBulkActionEligibilityPresentation(
        bulkTargets,
        bulkEligibilityData
      ),
    [bulkEligibilityData, bulkTargets]
  );
  const bulkEligibilityDisplayPresentation = useMemo(
    () =>
      getLibraryBulkActionEligibilityDisplayPresentation(
        bulkTargets,
        bulkEligibilityData
      ),
    [bulkEligibilityData, bulkTargets]
  );
  const bulkEligibilityPending =
    bulkTargets.length > 0 &&
    (bulkEligibilityValidating ||
      Boolean(bulkEligibilityError) ||
      !bulkEligibilityPresentation.matchesSelection);
  const bulkEligibilityInitialLoading =
    bulkTargets.length > 0 &&
    !bulkEligibilityError &&
    !bulkEligibilityPresentation.matchesSelection &&
    bulkEligibilityDisplayPresentation.scheduleTargets.length === 0 &&
    bulkEligibilityDisplayPresentation.cancelTargets.length === 0;
  const selectionSizeKey =
    isAdmin && bulkTargets.length > 0
      ? ([
          '/api/v1/library/selection-size',
          bulkTargets,
          bulkEligibilityRevision,
        ] as const)
      : null;
  const {
    data: selectionSizeData,
    error: selectionSizeError,
    mutate: mutateSelectionSize,
  } = useSWR<LibrarySelectionSizeResponse>(
    selectionSizeKey,
    ([url, targets]) =>
      axios
        .post<LibrarySelectionSizeResponse>(url, { targets })
        .then(({ data }) => data),
    { keepPreviousData: true }
  );
  const selectionSizePresentation = useMemo(
    () => getLibrarySelectionSizePresentation(bulkTargets, selectionSizeData),
    [bulkTargets, selectionSizeData]
  );
  const selectedSize = useMemo(() => {
    if (selectedKeys.size === 0) return null;
    if (selectionSizePresentation.retained) {
      if (selectionSizeError || !selectionSizePresentation.sizeBytes)
        return null;
      const formatted = formatLibrarySize(selectionSizePresentation.sizeBytes);
      const partial = selectionSizePresentation.unknownFileCount > 0;
      return {
        label: `${partial ? '\u2265' : ''}${formatted}`,
        tooltip: intl.formatMessage(messages.selectedSizeUpdating),
        stale: true,
      };
    }
    if (!selectionSizePresentation.matchesSelection) return null;
    if (!selectionSizePresentation.sizeBytes) {
      return {
        label: intl.formatMessage(messages.selectedSizeUnavailable),
        tooltip: intl.formatMessage(messages.selectedSizeUnavailable),
        stale: false,
      };
    }
    const formatted = formatLibrarySize(selectionSizePresentation.sizeBytes);
    const partial = selectionSizePresentation.unknownFileCount > 0;
    return {
      label: `${partial ? '\u2265' : ''}${formatted}`,
      tooltip: partial
        ? intl.formatMessage(messages.selectedSizeSomeUnknown)
        : undefined,
      stale: false,
    };
  }, [intl, selectedKeys.size, selectionSizeError, selectionSizePresentation]);
  const bulkEligibilityUnavailableLabel = useMemo(() => {
    const reasonLabels = bulkEligibilityPresentation.unresolvedReasons.map(
      (reason) => {
        switch (reason) {
          case 'processing_lease':
          case 'execution_in_progress':
            return intl.formatMessage(messages.eligibilityProcessing);
          case 'whole_series_scheduled':
            return intl.formatMessage(messages.eligibilitySeriesScheduled);
          case 'not_current':
            return intl.formatMessage(messages.eligibilityNotCurrent);
          case 'missing':
            return intl.formatMessage(messages.eligibilityMissing);
          case 'ambiguous_source':
            return intl.formatMessage(messages.eligibilityAmbiguous);
          case 'active_acquisition':
            return intl.formatMessage(messages.eligibilityAcquisition);
          case 'identity_conflict':
            return intl.formatMessage(messages.eligibilityIdentity);
          case 'configuration':
            return intl.formatMessage(messages.eligibilityConfiguration);
          default:
            return intl.formatMessage(messages.eligibilityUnavailableReason);
        }
      }
    );
    return intl.formatMessage(messages.bulkEligibilityUnavailable, {
      reasons: reasonLabels.join(', '),
    });
  }, [bulkEligibilityPresentation.unresolvedReasons, intl]);
  const activeBulkTargets = bulkTargetOverride ?? bulkTargets;
  const bulkTargetCounts = useMemo(
    () => getLibraryBulkActionTargetCounts(activeBulkTargets),
    [activeBulkTargets]
  );
  const bulkTargetSummary = useMemo(
    () =>
      [
        bulkTargetCounts.movie > 0
          ? intl.formatMessage(messages.removeMovieCount, {
              count: bulkTargetCounts.movie,
            })
          : '',
        bulkTargetCounts.series > 0
          ? intl.formatMessage(messages.removeSeriesCount, {
              count: bulkTargetCounts.series,
            })
          : '',
        bulkTargetCounts.season > 0
          ? intl.formatMessage(messages.removeSeasonCount, {
              count: bulkTargetCounts.season,
            })
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
    [bulkTargetCounts, intl]
  );
  const formatBulkResultSummary = useCallback(
    (response: LibraryBulkActionResponse) => {
      const presentation = getLibraryBulkActionPresentation(response);
      if (response.action === 'schedule') {
        if (presentation.state === 'success')
          return intl.formatMessage(messages.scheduleSuccess, {
            count: response.requested,
            days: removalSettings?.removalDelayDays ?? 0,
          });
        if (presentation.state === 'partial')
          return intl.formatMessage(messages.schedulePartial, {
            completed: presentation.completed,
            failed: presentation.issues.length,
          });
        return intl.formatMessage(messages.scheduleFailure, {
          count: response.requested,
        });
      }
      if (response.action === 'cancel_schedule') {
        if (presentation.state === 'success')
          return intl.formatMessage(messages.cancelSuccess, {
            count: response.requested,
          });
        if (presentation.state === 'partial')
          return intl.formatMessage(messages.cancelPartial, {
            completed: presentation.completed,
            failed: presentation.issues.length,
          });
        return intl.formatMessage(messages.cancelFailure, {
          count: response.requested,
        });
      }
      if (presentation.state === 'success')
        return intl.formatMessage(messages.removeSuccess, {
          count: response.requested,
        });
      if (presentation.state === 'partial')
        return intl.formatMessage(messages.removePartial, {
          completed: presentation.completed,
          failed: presentation.issues.length,
        });
      return intl.formatMessage(messages.removeFailure, {
        count: response.requested,
      });
    },
    [intl, removalSettings?.removalDelayDays]
  );
  const formatBulkTargetLabel = useCallback(
    (target: LibraryBulkActionTarget) =>
      bulkTargetLabels.current.get(bulkTargetKey(target)) ??
      (target.targetType === 'movie'
        ? intl.formatMessage(messages.movieTarget)
        : target.targetType === 'series'
          ? intl.formatMessage(messages.seriesTarget)
          : target.seasonNumber === 0
            ? intl.formatMessage(messages.specialsTarget)
            : intl.formatMessage(messages.seasonTarget, {
                seasonNumber: target.seasonNumber,
              })),
    [intl]
  );
  const formatBulkFailure = useCallback(
    (item: LibraryBulkActionResult) => {
      switch (item.outcome) {
        case 'missing':
          return intl.formatMessage(messages.failureMissing);
        case 'not_current':
          return intl.formatMessage(messages.failureNotCurrent);
        case 'ambiguous_source':
          return intl.formatMessage(messages.failureAmbiguous);
        case 'active_acquisition':
          return intl.formatMessage(messages.failureAcquisition);
        case 'in_progress':
          return intl.formatMessage(messages.failureInProgress);
        case 'identity_conflict':
          return intl.formatMessage(messages.failureIdentity);
        case 'cross_season_file':
          return intl.formatMessage(messages.failureCrossSeason);
        case 'remote_removed_local_failed':
          return intl.formatMessage(messages.failureReconciliation);
        case 'not_attempted':
          return intl.formatMessage(messages.failureNotAttempted);
        default:
          return intl.formatMessage(messages.failureGeneric);
      }
    },
    [intl]
  );
  const handleLibraryChanged = useCallback(() => {
    void mutate();
    void mutateSelectionSize();
  }, [mutate, mutateSelectionSize]);
  const openBulkAction = useCallback(
    (
      action: LibraryBulkAction,
      event: React.MouseEvent<HTMLButtonElement>,
      targets?: LibraryBulkActionTarget[]
    ) => {
      if (bulkSubmitting) return;
      bulkActionTrigger.current = event.currentTarget;
      setBulkTargetOverride(targets ?? null);
      setBulkAction(action);
    },
    [bulkSubmitting]
  );
  const closeBulkAction = useCallback((restoreTrigger: boolean) => {
    setBulkAction(null);
    setBulkTargetOverride(null);
    window.requestAnimationFrame(() =>
      (restoreTrigger
        ? bulkActionTrigger.current
        : selectionToolbar.current
      )?.focus()
    );
  }, []);
  const submitBulkAction = useCallback(async () => {
    if (
      !bulkAction ||
      bulkSubmitting ||
      bulkSubmissionInFlight.current ||
      activeBulkTargets.length === 0
    )
      return;
    bulkSubmissionInFlight.current = true;
    setBulkSubmitting(true);
    try {
      const response = await axios.post<LibraryBulkActionResponse>(
        '/api/v1/library/bulk-actions',
        { action: bulkAction, targets: activeBulkTargets }
      );
      const presentation = getLibraryBulkActionPresentation(response.data);
      setShowBulkFailures(false);
      if (presentation.state === 'success') {
        setBulkResult(null);
        const summary = formatBulkResultSummary(response.data);
        addToast(
          presentation.hasProviderAcknowledgement ? (
            <span>
              {summary} · {intl.formatMessage(messages.removeVerification)}
            </span>
          ) : (
            summary
          ),
          { appearance: 'success', autoDismiss: true }
        );
      } else {
        setBulkResult(response.data);
      }
      setSelectedKeys((current) =>
        reconcileLibrarySelectionAfterBulkAction(current, response.data.results)
      );
      closeBulkAction(false);
      await mutate();
      await mutateBulkEligibility();
      await mutateSelectionSize();
      const affectedSeries = new Set(
        response.data.results
          .filter(({ target }) => target.targetType !== 'movie')
          .map(({ target }) => target.canonicalMediaId)
      );
      await Promise.all(
        [...affectedSeries].map((canonicalMediaId) =>
          mutateSWR(`/api/v1/library/${canonicalMediaId}/series-detail`)
        )
      );
    } catch {
      setShowBulkFailures(false);
      setBulkResult({
        action: bulkAction,
        requested: activeBulkTargets.length,
        succeeded: 0,
        unchanged: 0,
        skipped: 0,
        failed: activeBulkTargets.length,
        results: activeBulkTargets.map((target) => ({
          target,
          outcome: 'not_attempted',
          code: 'request_failed',
          retryable: true,
          message: 'The batch request could not be completed.',
          affectedSchedules: 0,
        })),
      });
      closeBulkAction(false);
    } finally {
      bulkSubmissionInFlight.current = false;
      setBulkSubmitting(false);
    }
  }, [
    activeBulkTargets,
    addToast,
    bulkAction,
    bulkSubmitting,
    closeBulkAction,
    formatBulkResultSummary,
    intl,
    mutate,
    mutateBulkEligibility,
    mutateSelectionSize,
  ]);
  const bulkResultPresentation = useMemo(
    () =>
      bulkResult ? getLibraryBulkActionPresentation(bulkResult) : undefined,
    [bulkResult]
  );
  const handleRetryBulkFailures = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!bulkResult || !bulkResultPresentation || bulkSubmitting) return;
      const targets = bulkResultPresentation.retryable.map(
        ({ target }) => target
      );
      if (targets.length === 0) return;
      bulkActionTrigger.current = event.currentTarget;
      setBulkTargetOverride(targets);
      setBulkAction(bulkResult.action);
    },
    [bulkResult, bulkResultPresentation, bulkSubmitting]
  );
  const handleSelectionChange = useCallback(
    (
      target: LibrarySelectionTarget,
      selected: boolean,
      eligibleSeasonNumbers?: readonly number[]
    ) => {
      setSelectedKeys((current) =>
        updateLibrarySelection(current, target, selected, eligibleSeasonNumbers)
      );
    },
    []
  );
  const { data: filterUserData, isValidating: filterUsersValidating } =
    useSWR<LibraryFilterUsersResponse>(availabilityApiUrl);
  useEffect(() => {
    latestFilterUserQuery.current = availabilityApiUrl;
  }, [availabilityApiUrl]);
  useEffect(() => {
    if (userSelectionEnabled) return;
    setFilterUserSnapshot((snapshot) =>
      snapshot.associationFilterActive
        ? { ...snapshot, associationFilterActive: false }
        : snapshot
    );
  }, [userSelectionEnabled]);
  useEffect(() => {
    if (
      !availabilityApiUrl ||
      filterUsersValidating ||
      !filterUserData?.users ||
      latestFilterUserQuery.current !== availabilityApiUrl
    )
      return;
    setFilterUserSnapshot({
      users: filterUserData.users,
      associationFilterActive: userSelectionEnabled,
    });
  }, [
    availabilityApiUrl,
    filterUserData?.users,
    filterUsersValidating,
    userSelectionEnabled,
  ]);
  const filterUsers = useMemo(
    () =>
      getLibraryFilterUsersForPresentation(
        filterUserSnapshot,
        userSelectionEnabled
      ),
    [filterUserSnapshot, userSelectionEnabled]
  );
  const incompleteSources = data
    ? [
        data.sourceStatus.library !== 'current'
          ? intl.formatMessage(messages.libraryHydration)
          : null,
        data.sourceStatus.currentViewing !== 'current'
          ? intl.formatMessage(messages.currentViewing)
          : null,
        data.sourceStatus.historicalImport.state !== 'accepted'
          ? intl.formatMessage(messages.historicalViewing)
          : null,
      ].filter((source): source is string => Boolean(source))
    : [];
  const sourceIncomplete = incompleteSources.length > 0;
  const paginationPresentation = getLibraryPaginationPresentation({
    requestedPage: page,
    responsePage: data?.pageInfo.page,
    isLoading,
    isValidating,
    hasError: Boolean(error),
  });
  const currentPageSelectionState = getLibraryPageSelectionState(
    selectedKeys,
    data?.results ?? []
  );
  const currentPageHasSelectableItems = hasSelectableLibraryPageItems(
    data?.results ?? []
  );
  const handleToggleCurrentPage = useCallback(() => {
    if (!data?.results.length || paginationPresentation.isPagePending) return;
    setSelectedKeys((current) =>
      currentPageSelectionState === 'selected'
        ? deselectLibraryPage(current, data.results)
        : selectLibraryPage(current, data.results)
    );
  }, [
    currentPageSelectionState,
    data?.results,
    paginationPresentation.isPagePending,
  ]);
  const handleClearAllSelections = useCallback(() => {
    setSelectedKeys(createEmptyLibrarySelection());
    setBulkTargetOverride(null);
    setBulkEligibilityRevision((revision) => revision + 1);
  }, []);
  const totalPages = Math.max(data?.pageInfo.pages ?? 1, 1);
  const paginationItems = getLibraryPaginationItems(
    paginationPresentation.displayedPage,
    totalPages
  );
  const nearbyPages = getLibraryNearbyPages(
    paginationPresentation.displayedPage,
    totalPages
  );
  const goToPage = (nextPage: number) =>
    updateQuery({ page: String(nextPage) });
  const renderPageNumber = (pageNumber: number) => (
    <Button
      buttonType={
        pageNumber === paginationPresentation.displayedPage
          ? 'primary'
          : 'default'
      }
      buttonSize="sm"
      className="h-8 min-w-[2rem] !px-2 !py-0"
      aria-label={intl.formatMessage(messages.pageNumber, { pageNumber })}
      aria-current={
        pageNumber === paginationPresentation.displayedPage ? 'page' : undefined
      }
      onClick={() => goToPage(pageNumber)}
      key={pageNumber}
    >
      {pageNumber}
    </Button>
  );
  const renderPaginationItem = (item: LibraryPaginationItem, index: number) =>
    typeof item === 'number' ? (
      renderPageNumber(item)
    ) : (
      <span
        className="inline-flex h-8 min-w-6 items-center justify-center text-gray-500"
        aria-hidden="true"
        key={`${item}-${index}`}
      >
        &hellip;
      </span>
    );

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <Transition as={Fragment} show={bulkAction !== null}>
        {bulkAction && (
          <Modal
            title={intl.formatMessage(
              bulkAction === 'schedule'
                ? messages.scheduleTitle
                : bulkAction === 'cancel_schedule'
                  ? messages.cancelTitle
                  : messages.removeTitle,
              { count: activeBulkTargets.length }
            )}
            onCancel={bulkSubmitting ? undefined : () => closeBulkAction(true)}
            onOk={() => void submitBulkAction()}
            okText={intl.formatMessage(
              bulkAction === 'schedule'
                ? messages.scheduleConfirm
                : bulkAction === 'cancel_schedule'
                  ? messages.cancelConfirm
                  : messages.removeSelected
            )}
            okButtonType={bulkAction === 'schedule' ? 'warning' : 'danger'}
            okDisabled={bulkSubmitting}
            backgroundClickable={!bulkSubmitting}
            dialogClass="!w-[calc(100%_-_2rem)] !max-w-[30rem] !rounded-lg sm:!max-w-[30rem] [&_[data-testid=modal-title]]:!overflow-visible [&_[data-testid=modal-title]]:!whitespace-normal [&_[data-testid=modal-title]]:!text-clip [&>div:last-child]:!justify-start"
          >
            <div className="-mt-2">
              <p className="text-xs leading-4 text-gray-400">
                {bulkTargetSummary}
              </p>
              {bulkSubmitting && (
                <p className="mt-2" role="status">
                  {intl.formatMessage(messages.runningBatch)}
                </p>
              )}
            </div>
          </Modal>
        )}
      </Transition>
      <div
        className="sticky top-[calc(4rem+env(safe-area-inset-top))] z-20 -mx-4 mb-5 bg-gray-900/95 px-4 pb-3 pt-1 shadow-md backdrop-blur"
        data-testid="library-sticky-header"
      >
        <div className="flex flex-col justify-between xl:flex-row xl:items-end">
          <div className="flex min-w-0 flex-wrap items-end gap-x-2">
            <Header>{intl.formatMessage(messages.title)}</Header>
            <div
              ref={selectionToolbar}
              className="mb-4 flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 whitespace-nowrap text-sm text-gray-200 md:mb-0 xl:w-auto xl:flex-shrink-0"
              role="toolbar"
              tabIndex={-1}
              aria-label={intl.formatMessage(messages.selectionToolbar)}
            >
              <div className="flex flex-none items-center gap-2">
                <span
                  className="inline-flex h-7 flex-none items-center gap-1.5 rounded-md bg-gray-700 px-2 py-1 text-xs font-medium text-slate-300 shadow-md"
                  data-testid="library-selection-summary"
                >
                  <LibrarySelectionCheckbox
                    checked={currentPageSelectionState === 'selected'}
                    indeterminate={currentPageSelectionState === 'some'}
                    disabled={
                      !currentPageHasSelectableItems ||
                      paginationPresentation.isPagePending
                    }
                    label={intl.formatMessage(
                      currentPageSelectionState === 'selected'
                        ? messages.deselectCurrentPage
                        : messages.selectCurrentPage
                    )}
                    className="library-selection-badge-checkbox"
                    onChange={handleToggleCurrentPage}
                  />
                  <span
                    className="tabular-nums"
                    data-testid="library-selection-count"
                    aria-live="polite"
                    aria-label={intl.formatMessage(messages.selectedItems, {
                      count: selectedKeys.size,
                    })}
                  >
                    {selectedKeys.size}
                  </span>
                </span>
                {selectedKeys.size > 0 &&
                  (selectedSize || selectionSizeError) && (
                    <span
                      className="inline-flex items-center gap-1 tabular-nums"
                      data-testid="library-selection-size"
                      aria-live="polite"
                      aria-busy={selectedSize?.stale || undefined}
                    >
                      <span aria-hidden="true">&middot;</span>
                      {selectedSize ? (
                        selectedSize.tooltip ? (
                          <Tooltip content={selectedSize.tooltip}>
                            <span
                              className={`rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
                                selectedSize.stale
                                  ? 'text-gray-500 opacity-60'
                                  : ''
                              }`}
                              tabIndex={0}
                              aria-label={`${selectedSize.label}. ${selectedSize.tooltip}`}
                            >
                              {selectedSize.label}
                            </span>
                          </Tooltip>
                        ) : (
                          <span>{selectedSize.label}</span>
                        )
                      ) : (
                        <Tooltip
                          content={intl.formatMessage(
                            messages.selectedSizeUnavailable
                          )}
                        >
                          <span
                            className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                            tabIndex={0}
                            aria-label={intl.formatMessage(
                              messages.selectedSizeUnavailable
                            )}
                          >
                            {intl.formatMessage(
                              messages.selectedSizeUnavailable
                            )}
                          </span>
                        </Tooltip>
                      )}
                    </span>
                  )}
                {selectedKeys.size > 0 ? (
                  <Tooltip
                    content={intl.formatMessage(messages.clearAllSelections)}
                  >
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 flex-none items-center justify-center rounded text-gray-400 outline-none transition-colors hover:bg-gray-700 hover:text-gray-100 focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                      data-testid="library-selection-clear"
                      aria-label={intl.formatMessage(
                        messages.clearAllSelections
                      )}
                      onClick={handleClearAllSelections}
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </Tooltip>
                ) : (
                  <span className="h-6 w-6 flex-none" aria-hidden="true" />
                )}
              </div>
              {isAdmin && (
                <div className="flex flex-none items-center gap-2">
                  <span
                    className={`hidden h-5 w-px flex-none bg-gray-700 sm:block ${
                      bulkTargets.length === 0 ? 'invisible' : ''
                    }`}
                    data-testid="library-selection-divider"
                    aria-hidden="true"
                  />
                  <div
                    className={`flex flex-none items-center gap-1 ${
                      bulkTargets.length === 0 ? 'invisible' : ''
                    }`}
                    data-testid="library-bulk-actions"
                    aria-hidden={bulkTargets.length === 0 ? 'true' : undefined}
                    aria-busy={bulkEligibilityPending || undefined}
                  >
                    <Tooltip
                      content={intl.formatMessage(
                        messages.removeSelectedCount,
                        {
                          count: bulkTargets.length,
                        }
                      )}
                    >
                      <Button
                        buttonType="danger"
                        buttonSize="sm"
                        className="h-7 gap-1 border-transparent bg-red-600/30 !px-2 !py-0 tabular-nums hover:bg-red-600 focus:bg-red-600/80"
                        aria-label={intl.formatMessage(
                          messages.removeSelectedCount,
                          { count: bulkTargets.length }
                        )}
                        disabled={
                          bulkSubmitting ||
                          bulkTargets.length === 0 ||
                          bulkTargets.length > 10
                        }
                        onClick={(event) => openBulkAction('remove_now', event)}
                      >
                        <TrashIcon className="h-4 w-4" />
                        <span>{bulkTargets.length}</span>
                      </Button>
                    </Tooltip>
                    {bulkEligibilityInitialLoading && (
                      <span
                        aria-label={intl.formatMessage(
                          messages.checkingBulkEligibility
                        )}
                        className="flex h-7 w-7 items-center justify-center text-gray-400"
                        role="status"
                      >
                        <ArrowPathIcon className="h-4 w-4 animate-spin" />
                      </span>
                    )}
                    {bulkEligibilityDisplayPresentation.scheduleTargets.length >
                      0 && (
                      <Tooltip
                        content={intl.formatMessage(
                          messages.scheduleEligibleCount,
                          {
                            count:
                              bulkEligibilityDisplayPresentation.scheduleTargets
                                .length,
                          }
                        )}
                      >
                        <Button
                          buttonType="warning"
                          buttonSize="sm"
                          className="h-7 gap-1 border-transparent bg-yellow-500/30 !px-2 !py-0 tabular-nums hover:bg-yellow-500 focus:bg-yellow-500/80"
                          aria-label={intl.formatMessage(
                            messages.scheduleEligibleCount,
                            {
                              count:
                                bulkEligibilityDisplayPresentation
                                  .scheduleTargets.length,
                            }
                          )}
                          disabled={
                            bulkSubmitting ||
                            bulkEligibilityPending ||
                            !removalSettings
                          }
                          onClick={(event) =>
                            openBulkAction(
                              'schedule',
                              event,
                              bulkEligibilityPresentation.scheduleTargets
                            )
                          }
                        >
                          <CalendarDateRangeIcon className="h-5 w-5" />
                          <span>
                            {
                              bulkEligibilityDisplayPresentation.scheduleTargets
                                .length
                            }
                          </span>
                        </Button>
                      </Tooltip>
                    )}
                    {bulkEligibilityDisplayPresentation.cancelTargets.length >
                      0 && (
                      <Tooltip
                        content={intl.formatMessage(
                          messages.cancelEligibleCount,
                          {
                            count:
                              bulkEligibilityDisplayPresentation.cancelTargets
                                .length,
                          }
                        )}
                      >
                        <Button
                          buttonType="default"
                          buttonSize="sm"
                          className="h-7 gap-1 border-transparent bg-blue-900/50 !px-2 !py-0 tabular-nums text-blue-200 hover:bg-blue-800/80 focus:bg-blue-800/80"
                          aria-label={intl.formatMessage(
                            messages.cancelEligibleCount,
                            {
                              count:
                                bulkEligibilityDisplayPresentation.cancelTargets
                                  .length,
                            }
                          )}
                          disabled={bulkSubmitting || bulkEligibilityPending}
                          onClick={(event) =>
                            openBulkAction(
                              'cancel_schedule',
                              event,
                              bulkEligibilityPresentation.cancelTargets
                            )
                          }
                        >
                          <CalendarIcon className="h-4 w-4" />
                          <span>
                            {
                              bulkEligibilityDisplayPresentation.cancelTargets
                                .length
                            }
                          </span>
                        </Button>
                      </Tooltip>
                    )}
                    {bulkEligibilityError && (
                      <Tooltip
                        content={intl.formatMessage(
                          messages.retryBulkEligibility
                        )}
                      >
                        <Button
                          aria-label={intl.formatMessage(
                            messages.retryBulkEligibility
                          )}
                          buttonSize="sm"
                          buttonType="default"
                          className="h-7 w-7 border-transparent bg-red-900/40 !p-0 text-red-300 hover:bg-red-800/60 focus:bg-red-800/60"
                          disabled={bulkEligibilityValidating}
                          onClick={() => void mutateBulkEligibility()}
                        >
                          <ArrowPathIcon className="h-4 w-4" />
                        </Button>
                      </Tooltip>
                    )}
                    {!bulkEligibilityError &&
                      bulkEligibilityPresentation.matchesSelection &&
                      bulkEligibilityPresentation.scheduleTargets.length ===
                        0 &&
                      bulkEligibilityPresentation.cancelTargets.length === 0 &&
                      bulkEligibilityPresentation.unresolvedCount > 0 && (
                        <Tooltip content={bulkEligibilityUnavailableLabel}>
                          <span
                            aria-label={bulkEligibilityUnavailableLabel}
                            className="flex h-7 w-7 items-center justify-center text-gray-400"
                            role="status"
                          >
                            <InformationCircleIcon className="h-4 w-4" />
                          </span>
                        </Tooltip>
                      )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="relative z-50 mt-2 flex min-w-0 flex-wrap items-center gap-2 xl:ml-1 xl:flex-1 xl:justify-end xl:gap-1 min-[1600px]:flex-nowrap min-[1600px]:gap-0.5">
            <div className="flex w-full min-w-0 sm:w-64 sm:flex-none">
              <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
                <MagnifyingGlassIcon className="h-6 w-6" />
              </span>
              <input
                type="text"
                aria-label={intl.formatMessage(messages.search)}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={intl.formatMessage(messages.search)}
                className="rounded-r-only"
              />
            </div>
            <MediaTypeFilter
              ariaLabel={intl.formatMessage(messages.mediaType)}
              value={mediaType}
              options={[
                {
                  value: 'all',
                  label: intl.formatMessage(globalMessages.all),
                },
                { value: 'movie', label: intl.formatMessage(messages.movies) },
                { value: 'series', label: intl.formatMessage(messages.series) },
              ]}
              onChange={(value) =>
                changePreferences({
                  mediaType: value as LibraryPreferences['mediaType'],
                })
              }
            />
            <div className="flex">
              <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
                <BarsArrowDownIcon className="h-6 w-6" />
                <span className="sr-only">
                  {intl.formatMessage(messages.sort)}
                </span>
              </span>
              <select
                aria-label={intl.formatMessage(messages.sort)}
                value={`${sort}.${sortDirection}`}
                onChange={(event) => {
                  const [nextSort, nextSortDirection] =
                    event.target.value.split('.') as [
                      LibraryPreferences['sort'],
                      LibraryPreferences['sortDirection'],
                    ];
                  changePreferences({
                    sort: nextSort,
                    sortDirection: nextSortDirection,
                  });
                }}
                className="rounded-r-only"
              >
                <option value="title.asc">
                  {intl.formatMessage(messages.sortTitleAsc)}
                </option>
                <option value="title.desc">
                  {intl.formatMessage(messages.sortTitleDesc)}
                </option>
                <option value="added.desc">
                  {intl.formatMessage(messages.sortAddedDesc)}
                </option>
                <option value="added.asc">
                  {intl.formatMessage(messages.sortAddedAsc)}
                </option>
                <option value="lastActive.desc">
                  {intl.formatMessage(messages.sortLastActiveDesc)}
                </option>
                <option value="lastActive.asc">
                  {intl.formatMessage(messages.sortLastActiveAsc)}
                </option>
                <option value="size.desc">
                  {intl.formatMessage(messages.sortSizeDesc)}
                </option>
                <option value="size.asc">
                  {intl.formatMessage(messages.sortSizeAsc)}
                </option>
                <option value="removed.desc">
                  {intl.formatMessage(messages.sortRemovedDesc)}
                </option>
                <option value="removed.asc">
                  {intl.formatMessage(messages.sortRemovedAsc)}
                </option>
                <option value="watchedUsers.desc">
                  {intl.formatMessage(messages.sortWatchedUsersDesc)}
                </option>
                <option value="watchedUsers.asc">
                  {intl.formatMessage(messages.sortWatchedUsersAsc)}
                </option>
              </select>
            </div>
            <div className="flex flex-grow sm:flex-grow-0">
              <Button
                buttonType="default"
                className="w-full"
                onClick={() => setShowFilters(true)}
                aria-label={intl.formatMessage(messages.filters)}
              >
                <FunnelIcon />
                <span>
                  {intl.formatMessage(messages.activeFilters, {
                    count: countActiveLibraryFilters(preferences),
                  })}
                </span>
              </Button>
            </div>
          </div>
        </div>
      </div>
      <FilterSlideover
        show={showFilters}
        onClose={() => setShowFilters(false)}
        preferences={preferences}
        onChange={updatePreferences}
        users={filterUsers}
        storageLocations={data?.storageLocations ?? []}
      />
      {preferences.collectionMembership !== 'any' &&
        Boolean(data?.collectionMembershipUnknownCount) && (
          <div className="mb-4 inline-flex items-center gap-1.5 text-sm text-gray-300">
            <InformationCircleIcon className="h-4 w-4" aria-hidden="true" />
            <span>
              {intl.formatMessage(messages.collectionMembershipUnknown, {
                count: data?.collectionMembershipUnknownCount,
              })}
            </span>
          </div>
        )}
      {sourceIncomplete && (
        <div className="mb-4 inline-flex items-center gap-1.5 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">
          <span>{intl.formatMessage(messages.sourceWarning)}</span>
          <Popover className="relative flex">
            <PopoverButton
              className="rounded-sm text-yellow-300 outline-none hover:text-yellow-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              aria-label={intl.formatMessage(messages.incompleteSourcesLabel, {
                sources: incompleteSources.join(', '),
              })}
            >
              <InformationCircleIcon className="h-4 w-4" aria-hidden="true" />
            </PopoverButton>
            <PopoverPanel className="absolute right-0 top-full z-50 mt-2 w-max max-w-64 rounded border border-gray-600 bg-gray-800 px-3 py-2 text-sm font-normal text-gray-100 shadow">
              <div>
                <div className="font-medium">
                  {intl.formatMessage(messages.incompleteSources)}
                </div>
                <ul className="list-disc pl-4">
                  {incompleteSources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              </div>
            </PopoverPanel>
          </Popover>
        </div>
      )}
      {bulkResult && bulkResultPresentation && (
        <section
          className={`mb-4 rounded-md border px-3 py-2 text-sm ${
            bulkResultPresentation.state === 'failure'
              ? 'border-red-500/40 bg-red-500/10 text-red-100'
              : 'border-yellow-500/40 bg-yellow-500/10 text-yellow-100'
          }`}
          aria-live="polite"
          aria-label={intl.formatMessage(messages.batchSummary)}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 font-medium">
              {formatBulkResultSummary(bulkResult)}
              {bulkResultPresentation.hasProviderAcknowledgement && (
                <span className="ml-1 font-normal">
                  {intl.formatMessage(messages.removeVerification)}
                </span>
              )}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <Button
                buttonType="ghost"
                buttonSize="sm"
                className="px-2 py-1"
                aria-expanded={showBulkFailures}
                onClick={() => setShowBulkFailures((current) => !current)}
              >
                {intl.formatMessage(
                  showBulkFailures
                    ? messages.hideFailures
                    : messages.viewFailures
                )}
              </Button>
              {bulkResultPresentation.retryable.length > 0 && (
                <Button
                  buttonType="default"
                  buttonSize="sm"
                  className="px-2 py-1"
                  disabled={bulkSubmitting}
                  onClick={handleRetryBulkFailures}
                >
                  <ArrowPathIcon className="mr-1 h-4 w-4" />
                  {intl.formatMessage(messages.retrySelected)}
                </Button>
              )}
              <Button
                buttonType="ghost"
                buttonSize="sm"
                className="h-7 w-7 !p-0"
                aria-label={intl.formatMessage(messages.dismissResult)}
                onClick={() => {
                  setBulkResult(null);
                  setShowBulkFailures(false);
                }}
              >
                <XMarkIcon className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {showBulkFailures && (
            <ul className="border-current/20 mt-2 max-h-48 space-y-1 overflow-y-auto border-t pt-2">
              {bulkResultPresentation.issues.map((item) => (
                <li
                  key={bulkTargetKey(item.target)}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span className="font-medium">
                    {formatBulkTargetLabel(item.target)}
                  </span>
                  <span>{formatBulkFailure(item)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {!data && !error && <LoadingSpinner />}
      {error && (
        <div className="py-24 text-center text-xl text-red-400">
          {intl.formatMessage(messages.unableToLoad)}
        </div>
      )}
      {data && data.results.length > 0 && (
        <LibraryResults
          items={stableLibraryItems}
          resetKey={apiUrl ?? ''}
          requestedPage={page}
          responsePage={data.pageInfo.page}
          pagePending={paginationPresentation.isPagePending}
          selectedKeys={selectedKeys}
          onSelectionChange={handleSelectionChange}
          onChanged={handleLibraryChanged}
        />
      )}
      {data && data.results.length === 0 && (
        <div className="py-24 text-center text-2xl text-gray-400">
          {intl.formatMessage(messages.noItems)}
        </div>
      )}
      {data && (
        <nav
          className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 -mx-4 mt-3 border-t border-gray-700 bg-gray-900/95 px-4 py-3 text-white backdrop-blur sm:bottom-0"
          aria-label="Pagination"
          data-testid="library-sticky-pagination"
        >
          <div className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm min-[1440px]:relative min-[1440px]:min-h-8 min-[1440px]:flex-nowrap min-[1440px]:justify-start">
            <div
              className="flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 min-[1440px]:w-auto min-[1440px]:flex-nowrap min-[1440px]:justify-start min-[1440px]:gap-x-2 min-[1440px]:text-xs"
              data-testid="library-pagination-summary"
            >
              <div className="whitespace-nowrap">
                {data.results.length > 0 &&
                  intl.formatMessage(messages.showingItems, {
                    from:
                      (paginationPresentation.displayedPage - 1) * pageSize + 1,
                    to:
                      (paginationPresentation.displayedPage - 1) * pageSize +
                      data.results.length,
                    total: data.pageInfo.results,
                    strong: (message: React.ReactNode) => (
                      <span key="showing-range" className="font-medium">
                        {message}
                      </span>
                    ),
                  })}
              </div>
              <span
                className="inline-flex h-4 w-4 flex-none items-center justify-center text-gray-400"
                role={
                  paginationPresentation.isPagePending ? 'status' : undefined
                }
                aria-live="polite"
                data-testid="library-page-loading"
              >
                {paginationPresentation.isPagePending && (
                  <>
                    <ArrowPathIcon
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    <span className="sr-only">
                      {intl.formatMessage(messages.loadingPage)}
                    </span>
                  </>
                )}
              </span>
            </div>
            <div
              className="flex items-center gap-1 min-[1440px]:absolute min-[1440px]:left-1/2 min-[1440px]:-translate-x-1/2"
              data-testid="library-pagination-controls"
            >
              <Button
                buttonSize="sm"
                className="h-8 w-8 !p-0"
                disabled={page <= 1}
                onClick={() => goToPage(1)}
                aria-label={intl.formatMessage(messages.firstPage)}
                title={intl.formatMessage(messages.firstPage)}
              >
                <ChevronsLeftIcon className="h-4 w-4" />
              </Button>
              <Button
                buttonSize="sm"
                className="h-8 w-8 !p-0"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
                aria-label={intl.formatMessage(globalMessages.previous)}
                title={intl.formatMessage(globalMessages.previous)}
              >
                <ChevronLeftIcon />
              </Button>
              <div className="hidden items-center gap-1 sm:flex">
                {paginationItems.map(renderPaginationItem)}
              </div>
              <div className="flex items-center gap-1 sm:hidden">
                {nearbyPages.map(renderPageNumber)}
              </div>
              <Button
                buttonSize="sm"
                className="h-8 w-8 !p-0"
                disabled={page >= totalPages}
                onClick={() => goToPage(page + 1)}
                aria-label={intl.formatMessage(globalMessages.next)}
                title={intl.formatMessage(globalMessages.next)}
              >
                <ChevronRightIcon />
              </Button>
              <Button
                buttonSize="sm"
                className="h-8 w-8 !p-0"
                disabled={page >= totalPages}
                onClick={() => goToPage(totalPages)}
                aria-label={intl.formatMessage(messages.lastPage)}
                title={intl.formatMessage(messages.lastPage)}
              >
                <ChevronsRightIcon className="h-4 w-4" />
              </Button>
            </div>
            <div
              className="flex items-center gap-2 whitespace-nowrap min-[1440px]:ml-auto min-[1440px]:gap-1 min-[1440px]:text-xs"
              data-testid="library-page-size"
            >
              <span>{intl.formatMessage(messages.perPage)}</span>
              <select
                aria-label={intl.formatMessage(messages.itemsPerPage)}
                value={pageSize}
                onChange={(event) =>
                  changePreferences({
                    pageSize: Number(event.target.value),
                  })
                }
                className="w-16 py-1 pl-2 pr-7"
              >
                {[10, 25, 50, 100].map((size) => (
                  <option value={size} key={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </nav>
      )}
    </>
  );
};

export default Library;
