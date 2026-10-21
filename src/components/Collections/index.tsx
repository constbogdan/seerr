import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import TitleCard from '@app/components/TitleCard';
import TitleCardCornerBadge from '@app/components/TitleCard/CornerBadge';
import useVerticalScroll from '@app/hooks/useVerticalScroll';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import {
  ArrowsUpDownIcon,
  BarsArrowDownIcon,
  FunnelIcon,
  Squares2X2Icon,
  SquaresPlusIcon,
} from '@heroicons/react/24/solid';
import type { LibraryCollectionsResponse } from '@server/interfaces/api/libraryInterfaces';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useIntl } from 'react-intl';
import useSWRInfinite from 'swr/infinite';
import { getCollectionCardActionPresentation } from './cardAction';
import {
  COLLECTIONS_PAGE_SIZE,
  collectionsPageUrl,
  collectionsQueryIdentity,
  isLastCollectionsPage,
  mergeCollectionPages,
} from './pagination';
import {
  collectionsQueryToUrl,
  parseCollectionsQuery,
  type CollectionsQueryState,
} from './query';

const retainedCollectionPageCounts = new Map<string, number>();

const messages = defineMessages('components.Collections', {
  title: 'Collections',
  completeness: 'Completeness',
  all: 'All',
  complete: 'Complete',
  incomplete: 'Incomplete',
  sort: 'Sort',
  sortName: 'Name',
  sortCompleteness: 'Completeness',
  sortAvailable: 'Available Movies',
  direction: 'Direction',
  ascending: 'Ascending',
  descending: 'Descending',
  loading: 'Loading Library collections…',
  refreshing: 'Refreshing collection metadata…',
  partial:
    'Some collection metadata could not be refreshed. Last known results remain visible.',
  unavailable: 'Collection metadata is temporarily unavailable.',
  empty: 'No collections match these filters.',
  availability: '{available}/{total}',
  availabilityUnknown: 'Availability unknown',
});

const Collections = () => {
  const router = useRouter();
  const intl = useIntl();
  const state = useMemo(
    () => parseCollectionsQuery(router.query),
    [router.query]
  );
  const queryIdentity = useMemo(() => collectionsQueryIdentity(state), [state]);
  const sizeIdentityRef = useRef(queryIdentity);
  const { data, error, isValidating, setSize, size } =
    useSWRInfinite<LibraryCollectionsResponse>(
      (pageIndex, previousPage) =>
        router.isReady
          ? collectionsPageUrl(state, pageIndex, previousPage)
          : null,
      {
        initialSize: retainedCollectionPageCounts.get(queryIdentity) ?? 1,
        persistSize: false,
        revalidateAll: true,
        refreshInterval: (latest: LibraryCollectionsResponse[] | undefined) =>
          latest?.some((page) => page.status === 'pending') ? 1000 : 0,
      }
    );
  const collections = useMemo(() => mergeCollectionPages(data), [data]);
  const currentStatus = data?.[0]?.status;
  const loadingNextPage =
    Boolean(data) && size > 0 && data?.[size - 1] === undefined && isValidating;
  const reachedEnd = isLastCollectionsPage(data);

  const navigate = useCallback(
    (next: CollectionsQueryState) =>
      void router.push({
        pathname: '/collections',
        query: collectionsQueryToUrl(next),
      }),
    [router]
  );
  const change = (next: Partial<CollectionsQueryState>) => {
    const nextState = { ...state, ...next };
    retainedCollectionPageCounts.delete(collectionsQueryIdentity(nextState));
    navigate(nextState);
  };

  useEffect(() => {
    if (sizeIdentityRef.current !== queryIdentity) {
      sizeIdentityRef.current = queryIdentity;
      return;
    }
    retainedCollectionPageCounts.set(queryIdentity, size);
  }, [queryIdentity, size]);

  const fetchMore = useCallback(() => {
    void setSize((currentSize) => currentSize + 1);
  }, [setSize]);
  useVerticalScroll(
    fetchMore,
    Boolean(
      data && !loadingNextPage && !reachedEnd && currentStatus !== 'unavailable'
    )
  );

  const initialLoading = !data && !error;
  const unavailable = Boolean(error) || currentStatus === 'unavailable';
  const pendingWithoutCards =
    currentStatus === 'pending' && collections.length === 0;
  const showSkeletons =
    initialLoading || pendingWithoutCards || loadingNextPage;

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div className="mb-5 mt-1">
        <div className="flex flex-col justify-between lg:flex-row lg:items-end">
          <Header>{intl.formatMessage(messages.title)}</Header>
          <div className="relative z-50 mt-2 flex flex-wrap gap-2">
            <div className="flex min-w-0 max-w-full">
              <span className="inline-flex shrink-0 cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
                <FunnelIcon className="h-6 w-6" />
                <span className="sr-only">
                  {intl.formatMessage(messages.completeness)}
                </span>
              </span>
              <select
                className="rounded-r-only min-w-0"
                aria-label={intl.formatMessage(messages.completeness)}
                value={state.completeness}
                onChange={(event) =>
                  change({
                    completeness: event.target
                      .value as CollectionsQueryState['completeness'],
                  })
                }
              >
                <option value="all">{intl.formatMessage(messages.all)}</option>
                <option value="complete">
                  {intl.formatMessage(messages.complete)}
                </option>
                <option value="incomplete">
                  {intl.formatMessage(messages.incomplete)}
                </option>
              </select>
            </div>
            <div className="flex min-w-0 max-w-full">
              <span className="inline-flex shrink-0 cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
                <BarsArrowDownIcon className="h-6 w-6" />
                <span className="sr-only">
                  {intl.formatMessage(messages.sort)}
                </span>
              </span>
              <select
                className="rounded-r-only min-w-0"
                aria-label={intl.formatMessage(messages.sort)}
                value={state.sort}
                onChange={(event) =>
                  change({
                    sort: event.target.value as CollectionsQueryState['sort'],
                  })
                }
              >
                <option value="name">
                  {intl.formatMessage(messages.sortName)}
                </option>
                <option value="completeness">
                  {intl.formatMessage(messages.sortCompleteness)}
                </option>
                <option value="available">
                  {intl.formatMessage(messages.sortAvailable)}
                </option>
              </select>
            </div>
            <div className="flex min-w-0 max-w-full">
              <span className="inline-flex shrink-0 cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
                <ArrowsUpDownIcon className="h-6 w-6" />
                <span className="sr-only">
                  {intl.formatMessage(messages.direction)}
                </span>
              </span>
              <select
                className="rounded-r-only min-w-0"
                aria-label={intl.formatMessage(messages.direction)}
                value={state.sortDirection}
                onChange={(event) =>
                  change({
                    sortDirection: event.target
                      .value as CollectionsQueryState['sortDirection'],
                  })
                }
              >
                <option value="asc">
                  {intl.formatMessage(messages.ascending)}
                </option>
                <option value="desc">
                  {intl.formatMessage(messages.descending)}
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {currentStatus === 'pending' && collections.length > 0 && (
        <div className="service-error-banner border-indigo-400 bg-indigo-500/10 text-indigo-100">
          <InformationCircleIcon className="h-5 w-5 shrink-0" />
          {intl.formatMessage(messages.refreshing)}
        </div>
      )}
      {currentStatus === 'partial' && (
        <div className="service-error-banner">
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
          {intl.formatMessage(messages.partial)}
        </div>
      )}
      {unavailable && (
        <div className="service-error-banner">
          <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
          {intl.formatMessage(messages.unavailable)}
        </div>
      )}

      {data &&
        currentStatus !== 'pending' &&
        currentStatus !== 'unavailable' &&
        collections.length === 0 && (
          <div className="py-24 text-center text-2xl text-gray-400">
            {intl.formatMessage(messages.empty)}
          </div>
        )}

      {(collections.length > 0 || showSkeletons) && (
        <ul
          className="cards-vertical"
          data-testid="collections-grid"
          aria-busy={showSkeletons || isValidating}
        >
          {collections.map((collection) => {
            const availability =
              collection.availableMovies === null ||
              collection.totalMovies === null
                ? intl.formatMessage(messages.availabilityUnknown)
                : intl.formatMessage(messages.availability, {
                    available: collection.availableMovies,
                    total: collection.totalMovies,
                  });
            const availabilityClassName =
              collection.completeness === 'complete'
                ? 'complete'
                : collection.completeness === 'incomplete'
                  ? 'incomplete'
                  : 'neutral';
            const requestAction = getCollectionCardActionPresentation(
              collection.completeness
            );
            const requestActionLabel = intl.formatMessage(
              requestAction.label === 'request'
                ? globalMessages.request
                : globalMessages.view
            );
            const RequestActionIcon =
              requestAction.icon === 'SquaresPlusIcon'
                ? SquaresPlusIcon
                : Squares2X2Icon;
            return (
              <li key={collection.id}>
                <TitleCard
                  id={collection.id}
                  image={collection.posterPath ?? undefined}
                  summary={collection.overview ?? undefined}
                  title={collection.name}
                  mediaType="collection"
                  canExpand
                  actionsDisabled
                  requestActionEnabled
                  requestActionLabel={requestActionLabel}
                  requestActionClassName={requestAction.className}
                  requestActionIcon={
                    <RequestActionIcon
                      className="h-4 w-4"
                      aria-hidden="true"
                      data-collection-action-icon={requestAction.icon}
                    />
                  }
                  classificationBadge={
                    <TitleCardCornerBadge tone={availabilityClassName}>
                      {availability}
                    </TitleCardCornerBadge>
                  }
                />
              </li>
            );
          })}
          {showSkeletons &&
            [...Array(COLLECTIONS_PAGE_SIZE)].map((_item, index) => (
              <li key={`collection-placeholder-${index}`}>
                <TitleCard.Placeholder canExpand />
              </li>
            ))}
        </ul>
      )}
      {showSkeletons && (
        <span className="sr-only" aria-live="polite">
          {intl.formatMessage(messages.loading)}
        </span>
      )}
    </>
  );
};

export default Collections;
