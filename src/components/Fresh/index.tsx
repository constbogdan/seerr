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
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Fresh', {
  fresh: 'Fresh',
  all: 'All',
  movies: 'Movies',
  series: 'Series',
  freshest: 'Freshest / First Seen',
  oldest: 'Oldest First Seen',
  title: 'Title',
  year: 'Year',
  tmdbRatingAsc: 'TMDB Rating Ascending',
  tmdbRatingDesc: 'TMDB Rating Descending',
  disabled: 'Fresh is not enabled.',
  configure: 'Configure Fresh',
  preparing: 'Fresh is preparing its first synchronization.',
  unavailable: 'Fresh is temporarily unavailable.',
  stale: 'Showing the last successful Fresh projection.',
  refreshing: 'Synchronizing Fresh media…',
});

const allowedSorts = new Set<FreshSort>([
  'freshest',
  'oldest',
  'title',
  'year',
  'vote_average.asc',
  'vote_average.desc',
]);

const Fresh = () => {
  const intl = useIntl();
  const router = useRouter();
  const { hasPermission } = useUser();
  const updateQuery = useUpdateQueryParams({});
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
  const status = discover.firstResultData?.status;
  const set = (key: string, value?: string) => updateQuery(key, value);

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.fresh)} />
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header>{intl.formatMessage(messages.fresh)}</Header>
        <div className="mt-2 flex flex-wrap gap-2">
          <MediaTypeFilter
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
          <div className="flex">
            <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3">
              <BarsArrowDownIcon className="h-6 w-6" />
            </span>
            <select
              className="rounded-r-only"
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
              <option value="title">
                {intl.formatMessage(messages.title)}
              </option>
              <option value="year">{intl.formatMessage(messages.year)}</option>
              <option value="vote_average.desc">
                {intl.formatMessage(messages.tmdbRatingDesc)}
              </option>
              <option value="vote_average.asc">
                {intl.formatMessage(messages.tmdbRatingAsc)}
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
      ) : status?.status === 'preparing' ? (
        <div className="mt-32 text-center text-2xl text-gray-400">
          {intl.formatMessage(messages.preparing)}
        </div>
      ) : discover.error || status?.status === 'unavailable' ? (
        <div className="mt-32 text-center text-2xl text-gray-400">
          {intl.formatMessage(messages.unavailable)}
        </div>
      ) : (
        <>
          {(status?.status === 'stale' || status?.refreshing) && (
            <div className="mb-4 flex items-center rounded-md bg-gray-800 p-3 text-gray-300">
              <ArrowPathIcon
                className={`mr-2 h-5 w-5 ${
                  status.refreshing ? 'animate-spin' : ''
                }`}
              />
              {intl.formatMessage(
                status.refreshing ? messages.refreshing : messages.stale
              )}
            </div>
          )}
          <ListView
            items={discover.titles}
            isEmpty={discover.isEmpty}
            isLoading={discover.isLoadingInitialData || discover.isLoadingMore}
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
