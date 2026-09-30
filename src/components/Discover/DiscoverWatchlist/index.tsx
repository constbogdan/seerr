import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import MediaTypeFilter from '@app/components/Common/MediaTypeFilter';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { Permission, useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  BarsArrowDownIcon,
  CheckCircleIcon,
  UserGroupIcon,
} from '@heroicons/react/24/solid';
import type {
  WatchlistCategory,
  WatchlistSort,
  WatchlistWatchedFilter,
} from '@server/constants/watchlist';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import {
  defaultWatchlistPreferences,
  getWatchlistPreferenceKey,
  readWatchlistPreferences,
  resolveEligibleWatchlistOwner,
  resolveWatchlistPreferences,
} from './preferences';

const messages = defineMessages('components.Discover.DiscoverWatchlist', {
  discoverwatchlist: 'Your Watchlist',
  watchlist: 'Plex Watchlist',
  all: 'All',
  movies: 'Movies',
  series: 'Series',
  animation: 'Animation',
  addedNewest: 'Date Added: Newest',
  addedOldest: 'Date Added: Oldest',
  titleAscending: 'Title: A–Z',
  titleDescending: 'Title: Z–A',
  sortBy: 'Sort by',
  emptyCategory: 'There are no Watchlist items in this category.',
  classificationPending:
    'Some Watchlist items are still being classified. This category may be incomplete.',
  notWatched: 'Not Watched',
  watched: 'Watched',
  watchedFilter: 'Watch status',
  me: 'Me',
  allUsers: 'All',
  ownerFilter: 'Watchlist owner',
});

const DiscoverWatchlist = () => {
  const intl = useIntl();
  const router = useRouter();
  const dedicatedPage = router.pathname === '/discover/watchlist';
  const updateQuery = useBatchUpdateQueryParams({});
  const [preferences, setPreferences] = useState(defaultWatchlistPreferences);
  const { user } = useUser({
    id: Number(router.query.userId),
  });
  const { user: currentUser, hasPermission } = useUser();
  const canViewOthers = hasPermission(Permission.WATCHLIST_VIEW);
  const owner = preferences.owner;
  const { data: eligibleUsers } = useSWR<UserResultsResponse>(
    dedicatedPage && canViewOthers
      ? '/api/v1/user?includeInUserMetrics=true&sort=displayname&sortDirection=asc&take=100'
      : null
  );
  const ownerOptions = useMemo(() => {
    const users = eligibleUsers?.results ?? [];
    return [
      { label: intl.formatMessage(messages.allUsers), value: 'all' },
      ...(currentUser?.id
        ? [{ label: intl.formatMessage(messages.me), value: 'me' }]
        : []),
      ...users
        .filter(({ id }) => id !== currentUser?.id)
        .map(({ id, displayName }) => ({
          label: displayName,
          value: id.toString(),
        })),
    ];
  }, [currentUser?.id, eligibleUsers?.results, intl]);
  const preferenceKey = currentUser?.id
    ? getWatchlistPreferenceKey(currentUser.id)
    : undefined;

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
    mutate,
    firstResultData,
  } = useDiscover<
    WatchlistItem,
    {
      source: 'local' | 'plex';
      supportsPresentation: boolean;
      supportsWatchState: boolean;
      hasUnclassifiedItems: boolean;
    },
    {
      category?: WatchlistCategory;
      sort?: WatchlistSort;
      watched?: WatchlistWatchedFilter;
      owner?: string;
    }
  >(
    `/api/v1/${
      router.pathname.startsWith('/profile')
        ? `user/${currentUser?.id}`
        : router.query.userId
          ? `user/${router.query.userId}`
          : 'discover'
    }/watchlist`,
    dedicatedPage
      ? {
          category: preferences.category,
          sort: preferences.sort,
          watched: preferences.watched,
          ...(canViewOthers && { owner }),
        }
      : undefined,
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );

  useEffect(() => {
    if (!dedicatedPage || !router.isReady || !preferenceKey) {
      return;
    }

    const stored = readWatchlistPreferences(
      window.localStorage.getItem(preferenceKey)
    );
    const resolved = resolveWatchlistPreferences({
      queryCategory:
        typeof router.query.category === 'string'
          ? router.query.category
          : undefined,
      queryOwner:
        typeof router.query.owner === 'string' ? router.query.owner : undefined,
      querySort:
        typeof router.query.sort === 'string' ? router.query.sort : undefined,
      queryWatched:
        typeof router.query.watched === 'string'
          ? router.query.watched
          : undefined,
      stored,
    });
    setPreferences(resolved);
    window.localStorage.setItem(preferenceKey, JSON.stringify(resolved));
  }, [
    dedicatedPage,
    preferenceKey,
    router.isReady,
    router.query.category,
    router.query.owner,
    router.query.sort,
    router.query.watched,
  ]);

  const updatePreference = useCallback(
    (
      next: Partial<{
        category: WatchlistCategory;
        owner: string;
        sort: WatchlistSort;
        watched: WatchlistWatchedFilter;
      }>
    ) => {
      const updated = { ...preferences, ...next };
      setPreferences(updated);
      if (preferenceKey) {
        window.localStorage.setItem(preferenceKey, JSON.stringify(updated));
      }
      updateQuery({
        category: updated.category === 'all' ? undefined : updated.category,
        owner: updated.owner === 'me' ? undefined : updated.owner,
        sort: updated.sort === 'added_desc' ? undefined : updated.sort,
        watched:
          updated.watched === 'not_watched' ? undefined : updated.watched,
        page: undefined,
      });
    },
    [preferenceKey, preferences, updateQuery]
  );

  useEffect(() => {
    if (!canViewOthers || !eligibleUsers || ownerOptions.length === 0) return;
    if (!ownerOptions.some((option) => option.value === preferences.owner)) {
      const fallback = resolveEligibleWatchlistOwner(
        preferences.owner,
        ownerOptions.map((option) => option.value)
      );
      updatePreference({ owner: fallback });
    }
  }, [
    canViewOthers,
    eligibleUsers,
    ownerOptions,
    preferences.owner,
    updatePreference,
  ]);

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const title = intl.formatMessage(
    router.query.userId ? messages.watchlist : messages.discoverwatchlist
  );

  return (
    <>
      <PageTitle
        title={[title, router.query.userId ? user?.displayName : '']}
      />
      <div className="mb-5 mt-1">
        <div className="flex flex-col justify-between lg:flex-row lg:items-end">
          <Header
            subtext={
              router.query.userId ? (
                <Link href={`/users/${user?.id}`} className="hover:underline">
                  {user?.displayName}
                </Link>
              ) : (
                ''
              )
            }
          >
            {title}
          </Header>
          {dedicatedPage && firstResultData?.supportsPresentation && (
            <div className="relative z-50 mt-2 flex flex-wrap gap-2">
              {canViewOthers && (
                <div className="flex w-48 max-w-full">
                  <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3">
                    <UserGroupIcon className="h-6 w-6" />
                    <span className="sr-only">
                      {intl.formatMessage(messages.ownerFilter)}
                    </span>
                  </span>
                  <select
                    className="rounded-r-only min-w-0 flex-1"
                    aria-label={intl.formatMessage(messages.ownerFilter)}
                    value={owner}
                    onChange={(event) =>
                      updatePreference({ owner: event.target.value })
                    }
                  >
                    {ownerOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <MediaTypeFilter
                value={preferences.category}
                ariaLabel={intl.formatMessage(messages.discoverwatchlist)}
                options={[
                  {
                    value: 'all',
                    label: intl.formatMessage(messages.all),
                  },
                  {
                    value: 'movies',
                    label: intl.formatMessage(messages.movies),
                  },
                  {
                    value: 'series',
                    label: intl.formatMessage(messages.series),
                  },
                  {
                    value: 'animation',
                    label: intl.formatMessage(messages.animation),
                  },
                ]}
                onChange={(value) =>
                  updatePreference({
                    category: value as WatchlistCategory,
                  })
                }
              />
              {firstResultData.supportsWatchState && (
                <div className="flex">
                  <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3">
                    <CheckCircleIcon className="h-6 w-6" />
                    <span className="sr-only">
                      {intl.formatMessage(messages.watchedFilter)}
                    </span>
                  </span>
                  <select
                    className="rounded-r-only"
                    aria-label={intl.formatMessage(messages.watchedFilter)}
                    value={preferences.watched}
                    onChange={(event) =>
                      updatePreference({
                        watched: event.target.value as WatchlistWatchedFilter,
                      })
                    }
                  >
                    <option value="all">
                      {intl.formatMessage(messages.all)}
                    </option>
                    <option value="not_watched">
                      {intl.formatMessage(messages.notWatched)}
                    </option>
                    <option value="watched">
                      {intl.formatMessage(messages.watched)}
                    </option>
                  </select>
                </div>
              )}
              <div className="flex">
                <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3">
                  <BarsArrowDownIcon className="h-6 w-6" />
                  <span className="sr-only">
                    {intl.formatMessage(messages.sortBy)}
                  </span>
                </span>
                <select
                  className="rounded-r-only"
                  aria-label={intl.formatMessage(messages.sortBy)}
                  value={preferences.sort}
                  onChange={(event) =>
                    updatePreference({
                      sort: event.target.value as WatchlistSort,
                    })
                  }
                >
                  <option value="added_desc">
                    {intl.formatMessage(messages.addedNewest)}
                  </option>
                  <option value="added_asc">
                    {intl.formatMessage(messages.addedOldest)}
                  </option>
                  <option value="title_asc">
                    {intl.formatMessage(messages.titleAscending)}
                  </option>
                  <option value="title_desc">
                    {intl.formatMessage(messages.titleDescending)}
                  </option>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>
      {dedicatedPage &&
      firstResultData?.supportsPresentation &&
      isEmpty &&
      preferences.category !== 'all' ? (
        <div className="mt-64 w-full text-center text-2xl text-gray-400">
          {intl.formatMessage(
            firstResultData.hasUnclassifiedItems
              ? messages.classificationPending
              : messages.emptyCategory
          )}
        </div>
      ) : (
        <ListView
          plexItems={titles}
          isEmpty={isEmpty}
          isLoading={
            isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
          }
          isReachingEnd={isReachingEnd}
          onScrollBottom={fetchMore}
          mutateParent={mutate}
          showWatchlistOwner={owner === 'all'}
        />
      )}
    </>
  );
};

export default DiscoverWatchlist;
