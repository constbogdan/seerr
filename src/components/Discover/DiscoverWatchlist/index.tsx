import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { BarsArrowDownIcon } from '@heroicons/react/24/solid';
import type {
  WatchlistCategory,
  WatchlistSort,
} from '@server/constants/watchlist';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import {
  defaultWatchlistPreferences,
  getWatchlistPreferenceKey,
  readWatchlistPreferences,
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
  const { user: currentUser } = useUser();
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
      hasUnclassifiedItems: boolean;
    },
    { category?: WatchlistCategory; sort?: WatchlistSort }
  >(
    `/api/v1/${
      router.pathname.startsWith('/profile')
        ? `user/${currentUser?.id}`
        : router.query.userId
          ? `user/${router.query.userId}`
          : 'discover'
    }/watchlist`,
    dedicatedPage
      ? { category: preferences.category, sort: preferences.sort }
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
      querySort:
        typeof router.query.sort === 'string' ? router.query.sort : undefined,
      stored,
    });
    setPreferences(resolved);
    window.localStorage.setItem(preferenceKey, JSON.stringify(resolved));
  }, [
    dedicatedPage,
    preferenceKey,
    router.isReady,
    router.query.category,
    router.query.sort,
  ]);

  const updatePreference = (
    next: Partial<{
      category: WatchlistCategory;
      sort: WatchlistSort;
    }>
  ) => {
    const updated = { ...preferences, ...next };
    setPreferences(updated);
    if (preferenceKey) {
      window.localStorage.setItem(preferenceKey, JSON.stringify(updated));
    }
    updateQuery({
      category: updated.category === 'all' ? undefined : updated.category,
      sort: updated.sort === 'added_desc' ? undefined : updated.sort,
      page: undefined,
    });
  };

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
            <div className="mt-2 flex flex-wrap gap-2">
              <select
                aria-label={intl.formatMessage(messages.discoverwatchlist)}
                value={preferences.category}
                onChange={(event) =>
                  updatePreference({
                    category: event.target.value as WatchlistCategory,
                  })
                }
              >
                <option value="all">{intl.formatMessage(messages.all)}</option>
                <option value="movies">
                  {intl.formatMessage(messages.movies)}
                </option>
                <option value="series">
                  {intl.formatMessage(messages.series)}
                </option>
                <option value="animation">
                  {intl.formatMessage(messages.animation)}
                </option>
              </select>
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
        />
      )}
    </>
  );
};

export default DiscoverWatchlist;
