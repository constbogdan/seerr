import CachedImage from '@app/components/Common/CachedImage';
import Tooltip from '@app/components/Common/Tooltip';
import {
  libraryLastActiveTooltip,
  libraryWatchedLabel,
  libraryWatchedTooltip,
  sortLibraryWatchedUsersForPresentation,
} from '@app/components/Library/presentation';
import { getLibraryRequesterDetailRows } from '@app/components/Library/requesterPresentation';
import defineMessages from '@app/utils/defineMessages';
import { parseFactualDate } from '@app/utils/factualDate';
import { UserCircleIcon } from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type {
  LibraryLastActiveUser,
  LibraryRequester,
  LibraryUser,
  LibraryWatchedUser,
} from '@server/interfaces/api/libraryInterfaces';
import { useId } from 'react';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.Engagement', {
  request: 'Request',
  request4k: '4K request',
  automatic: 'Automatic',
  pending: 'Pending',
  approved: 'Approved',
  declined: 'Declined',
  failed: 'Failed',
  completed: 'Completed',
  season: 'Season {number}',
  specials: 'Specials',
  partialActivity: 'Partial',
  watchedActivity: 'Watched',
});

export const UserAvatar = ({
  user,
  showTooltip = true,
}: {
  user: LibraryUser;
  showTooltip?: boolean;
}) => {
  const avatar = (
    <span
      className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-gray-700 ring-1 ring-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      aria-label={showTooltip ? user.displayName : undefined}
      tabIndex={showTooltip ? 0 : undefined}
    >
      {user.avatar ? (
        <CachedImage
          type="avatar"
          src={user.avatar}
          alt=""
          width={28}
          height={28}
          className="h-7 w-7 object-cover"
        />
      ) : (
        <UserCircleIcon className="h-7 w-7 text-gray-300" />
      )}
    </span>
  );

  return showTooltip ? (
    <Tooltip
      content={user.displayName}
      tooltipConfig={{ trigger: ['hover', 'focus'] }}
    >
      {avatar}
    </Tooltip>
  ) : (
    avatar
  );
};

export const AvatarStack = ({
  users,
  ariaLabel = 'Watchlist users',
}: {
  users: LibraryUser[];
  ariaLabel?: string;
}) => {
  const visible = users.slice(0, 5);
  const overflow = users.length - visible.length;
  return (
    <div className="flex -space-x-1" aria-label={ariaLabel}>
      {visible.map((user) => (
        <UserAvatar user={user} key={user.id} />
      ))}
      {overflow > 0 && (
        <Tooltip
          content={users
            .slice(5)
            .map((user) => user.displayName)
            .join(', ')}
        >
          <span
            className="inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-full bg-gray-700 px-1 text-xs font-medium text-gray-200 ring-1 ring-gray-500"
            tabIndex={0}
          >
            +{overflow}
          </span>
        </Tooltip>
      )}
    </div>
  );
};

export const LastActiveAvatarStack = ({
  users,
  lastActiveAt,
  ariaLabel,
}: {
  users: LibraryLastActiveUser[];
  lastActiveAt: string | null;
  ariaLabel: string;
}) => {
  const intl = useIntl();
  const formattedLastActiveAt = lastActiveAt
    ? intl.formatDate(parseFactualDate(lastActiveAt), {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : undefined;
  const tooltip = (user: LibraryLastActiveUser) =>
    libraryLastActiveTooltip(
      user.displayName,
      formattedLastActiveAt,
      user.episode,
      user.episode?.classification
        ? intl.formatMessage(
            user.episode.classification === 'partial'
              ? messages.partialActivity
              : messages.watchedActivity
          )
        : undefined
    );
  const visible = users.slice(0, 5);
  const overflow = users.length - visible.length;

  return (
    <div className="flex -space-x-1" aria-label={ariaLabel}>
      {visible.map((user) => {
        const content = tooltip(user);
        return (
          <Tooltip
            content={content}
            key={user.id}
            tooltipConfig={{ trigger: ['hover', 'focus'] }}
          >
            <span className="inline-flex h-7" tabIndex={0} aria-label={content}>
              <UserAvatar user={user} showTooltip={false} />
            </span>
          </Tooltip>
        );
      })}
      {overflow > 0 && (
        <Tooltip
          content={
            <div className="space-y-1">
              {users.slice(5).map((user) => (
                <div key={user.id}>{tooltip(user)}</div>
              ))}
            </div>
          }
          tooltipConfig={{ trigger: ['hover', 'focus'] }}
        >
          <span
            className="inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-full bg-gray-700 px-1 text-xs font-medium text-gray-200 ring-1 ring-gray-500"
            tabIndex={0}
          >
            +{overflow}
          </span>
        </Tooltip>
      )}
    </div>
  );
};

const requesterStatus = (intl: IntlShape, value: MediaRequestStatus) =>
  intl.formatMessage(
    value === MediaRequestStatus.PENDING
      ? messages.pending
      : value === MediaRequestStatus.APPROVED
        ? messages.approved
        : value === MediaRequestStatus.DECLINED
          ? messages.declined
          : value === MediaRequestStatus.FAILED
            ? messages.failed
            : messages.completed
  );

const requesterDate = (intl: IntlShape, value: string) =>
  intl.formatDate(value, { dateStyle: 'medium', timeStyle: 'short' });

const requesterDetailText = (
  intl: IntlShape,
  requester: LibraryRequester
): string[] =>
  getLibraryRequesterDetailRows(requester).map((row) => {
    if (row.kind === 'request') {
      const requestType = intl.formatMessage(
        row.request.is4k ? messages.request4k : messages.request
      );
      const automatic = row.request.isAutoRequest
        ? ` · ${intl.formatMessage(messages.automatic)}`
        : '';
      return `${requestType}${automatic} · ${requesterStatus(
        intl,
        row.request.status
      )} · ${requesterDate(intl, row.request.createdAt)}`;
    }

    const season =
      row.season.seasonNumber === 0
        ? intl.formatMessage(messages.specials)
        : intl.formatMessage(messages.season, {
            number: row.season.seasonNumber,
          });
    return `${season} · ${requesterStatus(
      intl,
      row.season.status
    )} · ${requesterDate(intl, row.season.createdAt)}`;
  });

const RequesterDetails = ({ requester }: { requester: LibraryRequester }) => {
  const intl = useIntl();
  const rows = requesterDetailText(intl, requester);

  return (
    <div className="space-y-1">
      <div className="font-medium">{requester.displayName}</div>
      {getLibraryRequesterDetailRows(requester).map((row, index) =>
        row.kind === 'request' ? (
          <div key={`request:${row.request.id}`}>{rows[index]}</div>
        ) : (
          <div
            className="pl-2 text-gray-300"
            key={`season:${row.request.id}:${row.season.id}`}
          >
            {rows[index]}
          </div>
        )
      )}
    </div>
  );
};

const RequesterAvatar = ({ requester }: { requester: LibraryRequester }) => {
  const intl = useIntl();
  const descriptionId = `library-requester-${useId().replaceAll(':', '')}`;
  const description = requesterDetailText(intl, requester).join('. ');

  return (
    <>
      <Tooltip content={<RequesterDetails requester={requester} />}>
        <span
          className="inline-flex h-7"
          tabIndex={0}
          aria-label={requester.displayName}
          aria-describedby={descriptionId}
        >
          <UserAvatar user={requester} showTooltip={false} />
        </span>
      </Tooltip>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </>
  );
};

export const RequesterAvatarStack = ({
  requesters,
  ariaLabel,
}: {
  requesters: LibraryRequester[];
  ariaLabel: string;
}) => {
  const visible = requesters.slice(0, 5);
  const overflow = requesters.length - visible.length;
  return (
    <div className="flex -space-x-1" aria-label={ariaLabel}>
      {visible.map((requester) => (
        <RequesterAvatar requester={requester} key={requester.id} />
      ))}
      {overflow > 0 && (
        <Tooltip
          content={requesters
            .slice(5)
            .map((requester) => requester.displayName)
            .join(', ')}
        >
          <span
            className="inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-full bg-gray-700 px-1 text-xs font-medium text-gray-200 ring-1 ring-gray-500"
            tabIndex={0}
          >
            +{overflow}
          </span>
        </Tooltip>
      )}
    </div>
  );
};

export const WatchedChip = ({ viewer }: { viewer: LibraryWatchedUser }) => {
  const intl = useIntl();
  const showPercentage = viewer.watchedPercentage < 100;
  const tooltip = libraryWatchedTooltip(
    viewer,
    viewer.lastViewedAt
      ? intl.formatDate(viewer.lastViewedAt, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
      : undefined
  );
  const avatar = (
    <UserAvatar
      showTooltip={false}
      user={{
        id: viewer.userId ?? 0,
        displayName: viewer.displayName,
        avatar: viewer.avatar,
      }}
    />
  );
  if (!showPercentage) {
    return (
      <Tooltip content={tooltip}>
        <span className="inline-flex" tabIndex={0} aria-label={tooltip}>
          {avatar}
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip content={tooltip}>
      <span
        className="relative inline-flex h-7 items-center"
        tabIndex={0}
        aria-label={tooltip}
      >
        <span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-gray-700 ring-1 ring-gray-600"
        />
        <span className="relative z-10 inline-flex h-7 w-7 flex-shrink-0">
          {avatar}
        </span>
        <span className="relative z-10 inline-flex h-7 items-center justify-center px-2 text-[11px] font-medium leading-none text-gray-200">
          {libraryWatchedLabel(viewer)}
        </span>
      </span>
    </Tooltip>
  );
};

export const WatchedChipGroup = ({
  users,
}: {
  users: LibraryWatchedUser[];
}) => {
  const orderedUsers = sortLibraryWatchedUsersForPresentation(users);
  const completedUsers = orderedUsers.filter(
    (viewer) => viewer.watchedPercentage === 100
  );
  const partialUsers = orderedUsers.filter(
    (viewer) => viewer.watchedPercentage < 100
  );

  return (
    <div className="flex h-7 min-w-0 flex-nowrap items-center gap-1.5">
      {completedUsers.length > 0 && (
        <div className="flex -space-x-1">
          {completedUsers.map((viewer) => (
            <WatchedChip viewer={viewer} key={viewer.key} />
          ))}
        </div>
      )}
      {partialUsers.map((viewer) => (
        <WatchedChip viewer={viewer} key={viewer.key} />
      ))}
    </div>
  );
};
