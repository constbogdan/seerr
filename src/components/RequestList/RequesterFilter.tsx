import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { UserGroupIcon } from '@heroicons/react/24/solid';
import type { UserResultsResponse } from '@server/interfaces/api/userInterfaces';
import { useIntl } from 'react-intl';
import useSWRInfinite from 'swr/infinite';

const messages = defineMessages('components.RequestList.RequesterFilter', {
  requestedBy: 'Requested By',
  me: 'Me',
  more: 'Load more users…',
  loading: 'Loading users…',
  retry: 'Unable to load users. Retry…',
});

// Same native select, icon and sizing as Watchlist. Unlike Watchlist, request
// owners include retained/metrics-excluded accounts. More pages are explicit:
// one bounded page per action, not an automatic sweep of the user directory.
const RequesterFilter = ({
  value,
  onChange,
}: {
  value?: string;
  onChange: (value?: string) => void;
}) => {
  const intl = useIntl();
  const { user: currentUser } = useUser();
  const { user: selectedUser } = useUser({ id: Number(value) });
  const { data, size, setSize, isValidating, error, mutate } =
    useSWRInfinite<UserResultsResponse>(
      (page, previous: UserResultsResponse | null) =>
        previous &&
        (page >= previous.pageInfo.pages || !previous.results.length)
          ? null
          : `/api/v1/user?sort=displayname&sortDirection=asc&take=100&skip=${page * 100}`,
      {
        revalidateFirstPage: false,
        revalidateOnFocus: false,
        shouldRetryOnError: false,
      }
    );
  const users = new Map<number, { id: number; displayName: string }>(
    (data ?? []).flatMap((page) =>
      page.results.map((user) => [user.id, user] as const)
    )
  );
  if (value && selectedUser) users.set(selectedUser.id, selectedUser);
  const more = !data || size < data[0].pageInfo.pages;

  return (
    <div className="flex w-48 max-w-full">
      <span className="inline-flex items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3">
        <UserGroupIcon className="h-6 w-6" />
        <span className="sr-only">
          {intl.formatMessage(messages.requestedBy)}
        </span>
      </span>
      <select
        className="rounded-r-only min-w-0 flex-1"
        aria-label={intl.formatMessage(messages.requestedBy)}
        value={value ?? 'all'}
        onChange={(event) => {
          if (event.target.value === 'more') {
            if (!isValidating) void setSize(size + 1).catch(() => undefined);
          } else if (event.target.value === 'retry') {
            if (!isValidating)
              void mutate(undefined, { revalidate: (page) => !page }).catch(
                () => undefined
              );
          } else
            onChange(
              event.target.value === 'all' ? undefined : event.target.value
            );
        }}
      >
        <option value="all">{intl.formatMessage(globalMessages.all)}</option>
        {currentUser && (
          <option value={currentUser.id}>
            {intl.formatMessage(messages.me)}
          </option>
        )}
        {value &&
          !users.has(Number(value)) &&
          Number(value) !== currentUser?.id && (
            <option value={value}>{value}</option>
          )}
        {[...users.values()]
          .filter((user) => user.id !== currentUser?.id)
          .map((user) => (
            <option key={user.id} value={user.id}>
              {user.displayName}
            </option>
          ))}
        {(more || error) && (
          <option value={error ? 'retry' : 'more'} disabled={isValidating}>
            {intl.formatMessage(
              isValidating
                ? messages.loading
                : error
                  ? messages.retry
                  : messages.more
            )}
          </option>
        )}
      </select>
    </div>
  );
};

export default RequesterFilter;
