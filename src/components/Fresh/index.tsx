import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import MediaTypeFilter from '@app/components/Common/MediaTypeFilter';
import PageTitle from '@app/components/Common/PageTitle';
import {
  FRESH_API_PATH,
  type FreshMediaResult,
  type FreshStatus,
} from '@app/components/Fresh/api';
import useDiscover from '@app/hooks/useDiscover';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { ArrowPathIcon, BarsArrowDownIcon } from '@heroicons/react/24/solid';
import type { FreshSort } from '@server/lib/fresh';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Fresh', {
  fresh: 'Fresh',
  all: 'All',
  movies: 'Movies',
  series: 'Series',
  freshest: 'Freshest / First Seen',
  oldest: 'Oldest First Seen',
  highestRating: 'TMDB Rating — Highest First',
  mostVotes: 'TMDB Votes — Most First',
  disabled: 'Fresh is not enabled.',
  configure: 'Configure Fresh',
  preparing: 'Fresh is processing the available release history.',
  unavailable: 'Fresh is temporarily unavailable.',
  stale: 'Showing saved Fresh discoveries while synchronization recovers.',
  retry: 'Retry',
  mediaType: 'Media type',
  sort: 'Sort Fresh media',
  refreshing: 'Synchronizing Fresh media…',
});

const allowedSorts = new Set<FreshSort>([
  'freshest',
  'oldest',
  'vote_average',
  'vote_count',
]);

export const resetFreshSortPages = (
  previous: FreshSort,
  next: FreshSort,
  setPageCount: (count: number) => void
): FreshSort => {
  if (previous !== next) setPageCount(1);
  return next;
};

const Fresh = () => {
  const intl = useIntl();
  const router = useRouter();
  const { hasPermission } = useUser();
  const updateQuery = useUpdateQueryParams({ page: undefined });
  const mediaType = ['movie', 'tv'].includes(String(router.query.mediaType))
    ? String(router.query.mediaType)
    : 'all';
  const requestedSort = String(router.query.sort || 'freshest') as FreshSort;
  const sort = allowedSorts.has(requestedSort) ? requestedSort : 'freshest';
  const discover = useDiscover<
    FreshMediaResult,
    { status: FreshStatus },
    { mediaType: string; sort: FreshSort }
  >(FRESH_API_PATH, { mediaType, sort });
  const previousSort = useRef(sort);
  const { setPageCount } = discover;
  useEffect(() => {
    // Reset only query changes, not an ordinary remount/Details → Back.
    previousSort.current = resetFreshSortPages(
      previousSort.current,
      sort,
      setPageCount
    );
  }, [sort, setPageCount]);
  const status = discover.firstResultData?.status;
  const set = (key: string, value?: string) => updateQuery(key, value);

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.fresh)} />
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header>{intl.formatMessage(messages.fresh)}</Header>
        <div className="mt-2 flex min-w-0 flex-wrap gap-2">
          <MediaTypeFilter
            ariaLabel={intl.formatMessage(messages.mediaType)}
            value={mediaType}
            options={[
              { value: 'all', label: intl.formatMessage(messages.all) },
              { value: 'movie', label: intl.formatMessage(messages.movies) },
              { value: 'tv', label: intl.formatMessage(messages.series) },
            ]}
            onChange={(value) =>
              set('mediaType', value === 'all' ? undefined : value)
            }
          />
          <div className="flex min-w-0 max-w-full">
            <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3">
              <BarsArrowDownIcon className="h-6 w-6" />
            </span>
            <select
              aria-label={intl.formatMessage(messages.sort)}
              className="rounded-r-only min-w-0 flex-1"
              value={sort}
              onChange={(event) =>
                set(
                  'sort',
                  event.target.value === 'freshest'
                    ? undefined
                    : event.target.value
                )
              }
            >
              <option value="freshest">
                {intl.formatMessage(messages.freshest)}
              </option>
              <option value="oldest">
                {intl.formatMessage(messages.oldest)}
              </option>
              <option value="vote_average">
                {intl.formatMessage(messages.highestRating)}
              </option>
              <option value="vote_count">
                {intl.formatMessage(messages.mostVotes)}
              </option>
            </select>
          </div>
        </div>
      </div>
      {status?.status === 'disabled' ? (
        <div className="mt-32 text-center text-gray-400">
          <p className="text-2xl">{intl.formatMessage(messages.disabled)}</p>
          {hasPermission(Permission.ADMIN) && (
            <Link
              className="mt-4 inline-block text-indigo-400 hover:underline"
              href="/settings/discovery-sources/fresh"
            >
              {intl.formatMessage(messages.configure)}
            </Link>
          )}
        </div>
      ) : (discover.error || status?.status === 'unavailable') &&
        !discover.titles.length ? (
        <div className="mt-32 text-center text-gray-400" role="alert">
          <p className="text-2xl">{intl.formatMessage(messages.unavailable)}</p>
          <Button className="mt-4" onClick={() => discover.mutate?.()}>
            {intl.formatMessage(messages.retry)}
          </Button>
        </div>
      ) : (
        <>
          {(status?.status === 'stale' ||
            status?.status === 'preparing' ||
            status?.refreshing) && (
            <div
              className="mb-4 flex items-center rounded-md bg-gray-800 p-3 text-gray-300"
              role="status"
              aria-live="polite"
            >
              <ArrowPathIcon
                className={`mr-2 h-5 w-5 ${
                  status.refreshing
                    ? 'animate-spin motion-reduce:animate-none'
                    : ''
                }`}
              />
              {intl.formatMessage(
                status.status === 'preparing'
                  ? messages.preparing
                  : status.refreshing
                    ? messages.refreshing
                    : messages.stale
              )}
            </div>
          )}
          <ListView
            showRatings
            items={discover.titles}
            isEmpty={discover.isEmpty && status?.status !== 'preparing'}
            isLoading={
              discover.isLoadingInitialData ||
              discover.isLoadingMore ||
              (status?.status === 'preparing' && !discover.titles.length)
            }
            isReachingEnd={discover.isReachingEnd}
            onScrollBottom={discover.fetchMore}
            mutateParent={discover.mutate}
          />
        </>
      )}
    </>
  );
};

export default Fresh;
