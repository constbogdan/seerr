import Spinner from '@app/assets/spinner.svg';
import BlocklistModal from '@app/components/BlocklistModal';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import Tooltip from '@app/components/Common/Tooltip';
import RequestModal from '@app/components/RequestModal';
import ActionStateGrid from '@app/components/TitleCard/ActionStateGrid';
import TitleCardCornerBadge from '@app/components/TitleCard/CornerBadge';
import ErrorCard from '@app/components/TitleCard/ErrorCard';
import Placeholder from '@app/components/TitleCard/Placeholder';
import { buildTitleCardStateIndicators } from '@app/components/TitleCard/stateIndicators';
import { useIsTouch } from '@app/hooks/useIsTouch';
import useToasts from '@app/hooks/useToasts';
import { Permission, UserType, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { withProperties } from '@app/utils/typeHelpers';
import { Transition } from '@headlessui/react';
import {
  ArrowDownTrayIcon,
  EyeIcon,
  NoSymbolIcon,
  StarIcon,
} from '@heroicons/react/24/outline';
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import type { Watchlist } from '@server/entity/Watchlist';
import type { MediaType } from '@server/models/Search';
import axios from 'axios';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';

interface TitleCardProps {
  id: number;
  image?: string;
  summary?: string;
  year?: string;
  title: string;
  userScore?: number;
  mediaType: MediaType;
  status?: MediaStatus;
  canExpand?: boolean;
  inProgress?: boolean;
  isAddedToWatchlist?: number | boolean;
  mutateParent?: () => void;
  watchState?: 'watched' | 'not_watched' | 'unknown';
  watchlistOwnerName?: string;
}

const messages = defineMessages('components.TitleCard', {
  addToWatchList: 'Add to watchlist',
  removeFromWatchList: 'Remove from watchlist',
  watchlistSuccess:
    '<strong>{title}</strong> added to watchlist  successfully!',
  watchlistDeleted:
    '<strong>{title}</strong> Removed from watchlist  successfully!',
  watchlistCancel: 'watchlist for <strong>{title}</strong> canceled.',
  watchlistError: 'Something went wrong. Please try again.',
  watched: 'Watched',
});

const watchlistIconClassName = '!h-[1.4375rem] !w-[1.4375rem] text-amber-300';

const TitleCard = ({
  id,
  image,
  summary,
  year,
  title,
  status,
  mediaType,
  isAddedToWatchlist = false,
  inProgress = false,
  canExpand = false,
  mutateParent,
  watchState,
  watchlistOwnerName,
}: TitleCardProps) => {
  const isTouch = useIsTouch();
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const [isUpdating, setIsUpdating] = useState(false);
  const [currentStatus, setCurrentStatus] = useState(status);
  const [showDetail, setShowDetail] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const { addToast } = useToasts();
  const [toggleWatchlist, setToggleWatchlist] =
    useState<boolean>(!isAddedToWatchlist);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Just to get the year from the date
  if (year) {
    year = year.slice(0, 4);
  }

  useEffect(() => {
    setCurrentStatus(status);
  }, [status]);

  const requestComplete = useCallback((newStatus: MediaStatus) => {
    setCurrentStatus(newStatus);
    setShowRequestModal(false);
  }, []);

  const requestUpdating = useCallback(
    (status: boolean) => setIsUpdating(status),
    []
  );

  const closeBlocklistModal = useCallback(
    () => setShowBlocklistModal(false),
    []
  );

  const onClickWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    try {
      const response = await axios.post<Watchlist>('/api/v1/watchlist', {
        tmdbId: id,
        mediaType,
        title,
      });
      mutate('/api/v1/discover/watchlist');
      if (response.data) {
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
      setToggleWatchlist((prevState) => !prevState);
    }
  };

  const onClickDeleteWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    try {
      const response = await axios.delete<Watchlist>(
        `/api/v1/watchlist/${id}?mediaType=${mediaType}`
      );

      if (response.status === 204) {
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistDeleted, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'info', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
      mutate('/api/v1/discover/watchlist');
      if (mutateParent) {
        mutateParent();
      }
      setToggleWatchlist((prevState) => !prevState);
    }
  };

  const onClickHideItemBtn = async (): Promise<void> => {
    setIsUpdating(true);
    const topNode = cardRef.current;

    if (topNode) {
      try {
        if (mediaType === 'collection') {
          await axios.post(`/api/v1/blocklist/collection/${id}`);
        } else {
          await axios.post('/api/v1/blocklist', {
            tmdbId: id,
            mediaType,
            title,
            user: user?.id,
          });
        }
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
        setCurrentStatus(MediaStatus.BLOCKLISTED);
        if (mutateParent) {
          mutateParent();
        }
      } catch (e) {
        if (e?.response?.status === 412) {
          addToast(
            <span>
              {intl.formatMessage(globalMessages.blocklistDuplicateError, {
                title,
                strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
              })}
            </span>,
            { appearance: 'info', autoDismiss: true }
          );
        } else {
          addToast(intl.formatMessage(globalMessages.blocklistError), {
            appearance: 'error',
            autoDismiss: true,
          });
        }
      }

      setIsUpdating(false);
      closeBlocklistModal();
    } else {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const onClickShowBlocklistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    const topNode = cardRef.current;

    if (topNode) {
      try {
        if (mediaType === 'collection') {
          const res = await axios.delete(`/api/v1/blocklist/collection/${id}`);

          if (res.status === 204) {
            addToast(
              <span>
                {intl.formatMessage(globalMessages.removeFromBlocklistSuccess, {
                  title,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                })}
              </span>,
              { appearance: 'success', autoDismiss: true }
            );
            setCurrentStatus(MediaStatus.UNKNOWN);
            if (mutateParent) {
              mutateParent();
            }
          } else {
            addToast(intl.formatMessage(globalMessages.blocklistError), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        } else {
          const res = await axios.delete(
            `/api/v1/blocklist/${id}?mediaType=${mediaType}`
          );

          if (res.status === 204) {
            addToast(
              <span>
                {intl.formatMessage(globalMessages.removeFromBlocklistSuccess, {
                  title,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                })}
              </span>,
              { appearance: 'success', autoDismiss: true }
            );
            setCurrentStatus(MediaStatus.UNKNOWN);
            if (mutateParent) {
              mutateParent();
            }
          } else {
            addToast(intl.formatMessage(globalMessages.blocklistError), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }
      } catch {
        addToast(intl.formatMessage(globalMessages.blocklistError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } else {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    setIsUpdating(false);
  };

  const closeModal = useCallback(() => setShowRequestModal(false), []);

  const showRequestButton = hasPermission(
    [
      Permission.REQUEST,
      mediaType === 'movie' || mediaType === 'collection'
        ? Permission.REQUEST_MOVIE
        : Permission.REQUEST_TV,
    ],
    { type: 'or' }
  );

  const showHideButton = hasPermission([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  });

  const stateIndicators = buildTitleCardStateIndicators({
    currentStatus,
    watchState,
    inProgress,
  });

  const watchlistAction = toggleWatchlist
    ? {
        label: intl.formatMessage(messages.addToWatchList),
        onClick: onClickWatchlistBtn,
        icon: <StarIcon className={watchlistIconClassName} />,
      }
    : {
        label: intl.formatMessage(messages.removeFromWatchList),
        onClick: onClickDeleteWatchlistBtn,
        icon: <StarIconSolid className={watchlistIconClassName} />,
      };
  const canAddToBlocklist =
    currentStatus !== MediaStatus.PROCESSING &&
    currentStatus !== MediaStatus.AVAILABLE &&
    currentStatus !== MediaStatus.PARTIALLY_AVAILABLE &&
    currentStatus !== MediaStatus.PENDING;
  const blocklistAction =
    currentStatus === MediaStatus.BLOCKLISTED
      ? {
          label: intl.formatMessage(globalMessages.removefromBlocklist),
          onClick: onClickShowBlocklistBtn,
          icon: <EyeIcon className="h-4 w-4 sm:h-5 sm:w-5" />,
        }
      : canAddToBlocklist
        ? {
            label: intl.formatMessage(globalMessages.addToBlocklist),
            onClick: () => setShowBlocklistModal(true),
            icon: <NoSymbolIcon className="h-4 w-4 sm:h-5 sm:w-5" />,
          }
        : undefined;
  const rightSideActions = showDetail
    ? [
        ...(currentStatus !== MediaStatus.BLOCKLISTED &&
        user?.userType !== UserType.PLEX
          ? [
              {
                id: 'watchlist',
                content: (
                  <Tooltip content={watchlistAction.label}>
                    <Button
                      buttonType="ghost"
                      className="z-40 !h-7 !w-7 !rounded-full !border-0 !bg-transparent !p-0 opacity-80 !shadow-none hover:!border-0 hover:!bg-transparent hover:opacity-100 hover:!shadow-none focus:!border-0 focus-visible:!ring-2 focus-visible:!ring-indigo-400"
                      buttonSize="sm"
                      aria-label={watchlistAction.label}
                      onClick={watchlistAction.onClick}
                    >
                      {watchlistAction.icon}
                    </Button>
                  </Tooltip>
                ),
              },
            ]
          : []),
        ...(showHideButton && blocklistAction
          ? [
              {
                id: 'blocklist',
                content: (
                  <Tooltip content={blocklistAction.label}>
                    <Button
                      buttonType="ghost"
                      className="z-40 !h-7 !w-7 !rounded-full !border-0 !bg-transparent !p-0 opacity-80 !shadow-none hover:!border-0 hover:!bg-transparent hover:opacity-100 hover:!shadow-none focus:!border-0 focus-visible:!ring-2 focus-visible:!ring-indigo-400"
                      buttonSize="sm"
                      aria-label={blocklistAction.label}
                      onClick={blocklistAction.onClick}
                    >
                      {blocklistAction.icon}
                    </Button>
                  </Tooltip>
                ),
              },
            ]
          : []),
      ]
    : [];
  const rightSideStates = stateIndicators.map((indicator) => ({
    id: indicator.id,
    content: (
      <div
        className={`z-40 flex ${
          indicator.id === 'availability' ? 'pointer-events-none' : ''
        }`}
      >
        <StatusBadgeMini
          status={indicator.status}
          inProgress={indicator.inProgress}
          label={
            indicator.id === 'watched'
              ? intl.formatMessage(messages.watched)
              : undefined
          }
          shrink
        />
      </div>
    ),
  }));
  const canRequestTitle =
    showRequestButton &&
    (!currentStatus ||
      currentStatus === MediaStatus.UNKNOWN ||
      currentStatus === MediaStatus.DELETED);

  return (
    <div
      className={canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'}
      data-testid="title-card"
      ref={cardRef}
    >
      <RequestModal
        tmdbId={id}
        show={showRequestModal}
        type={
          mediaType === 'movie'
            ? 'movie'
            : mediaType === 'collection'
              ? 'collection'
              : 'tv'
        }
        onComplete={requestComplete}
        onUpdating={requestUpdating}
        onCancel={closeModal}
      />
      <BlocklistModal
        tmdbId={id}
        type={
          mediaType === 'movie'
            ? 'movie'
            : mediaType === 'collection'
              ? 'collection'
              : 'tv'
        }
        show={showBlocklistModal}
        onCancel={closeBlocklistModal}
        onComplete={onClickHideItemBtn}
        isUpdating={isUpdating}
      />
      <div
        className={`relative transform-gpu cursor-default overflow-hidden rounded-xl bg-gray-800 bg-cover outline-none ring-1 transition duration-300 ${
          showDetail
            ? 'scale-105 shadow-lg ring-gray-500'
            : 'scale-100 shadow ring-gray-700'
        }`}
        style={{
          paddingBottom: '150%',
        }}
        onMouseEnter={() => {
          if (!isTouch) {
            setShowDetail(true);
          }
        }}
        onMouseLeave={() => setShowDetail(false)}
        onClick={() => setShowDetail(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setShowDetail(true);
          }
        }}
        role="link"
        tabIndex={0}
      >
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          <CachedImage
            type="tmdb"
            className="absolute inset-0 h-full w-full"
            alt=""
            src={
              image
                ? `https://image.tmdb.org/t/p/w300_and_h450_face${image}`
                : `/images/seerr_poster_not_found_logo_top.png`
            }
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
          />
          <div
            className="pointer-events-none absolute inset-0 z-30 p-2"
            data-testid="title-card-corner-frame"
          >
            <div className="grid h-full grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] gap-x-2">
              <div
                className="col-start-1 row-start-1 min-w-0 self-start justify-self-start"
                data-testid="title-card-classification-state"
              >
                <TitleCardCornerBadge
                  tone={
                    mediaType === 'movie' || mediaType === 'collection'
                      ? 'movie'
                      : 'series'
                  }
                >
                  {mediaType === 'movie'
                    ? intl.formatMessage(globalMessages.movie)
                    : mediaType === 'collection'
                      ? intl.formatMessage(globalMessages.collection)
                      : intl.formatMessage(globalMessages.tvshow)}
                </TitleCardCornerBadge>
              </div>
              <div
                className="col-start-2 row-start-1 self-start justify-self-end"
                data-testid="title-card-action-state-region"
              >
                <ActionStateGrid
                  actions={rightSideActions}
                  states={rightSideStates}
                />
              </div>
              {watchlistOwnerName && (
                <div
                  className="col-start-1 row-start-3 min-w-0 self-end justify-self-start"
                  data-testid="title-card-owner-region"
                >
                  <TitleCardCornerBadge className="max-w-full" tone="owner">
                    {watchlistOwnerName}
                  </TitleCardCornerBadge>
                </div>
              )}
              {canRequestTitle && (
                <Transition
                  as={Fragment}
                  show={!image || showDetail || showRequestModal}
                  enter="transition-opacity"
                  enterFrom="opacity-0"
                  enterTo="opacity-100"
                  leave="transition-opacity"
                  leaveFrom="opacity-100"
                  leaveTo="opacity-0"
                >
                  <div
                    className="pointer-events-auto col-start-2 row-start-3 self-end justify-self-end"
                    data-testid="title-card-request-region"
                  >
                    <Tooltip
                      content={intl.formatMessage(globalMessages.request)}
                    >
                      <Button
                        buttonType="primary"
                        buttonSize="sm"
                        aria-label={intl.formatMessage(globalMessages.request)}
                        onClick={(e) => {
                          e.preventDefault();
                          setShowRequestModal(true);
                        }}
                        className="z-40 !h-8 !w-8 !rounded-md !border-transparent !bg-orange-500/90 !p-1.5 !text-white shadow-md hover:!border-transparent hover:!bg-orange-400 focus:!border-transparent focus:!ring-orange-300 active:!bg-orange-600"
                      >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                      </Button>
                    </Tooltip>
                  </div>
                </Transition>
              )}
            </div>
          </div>
          <Transition
            as={Fragment}
            show={isUpdating}
            enter="transition-opacity ease-in-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity ease-in-out duration-300"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="absolute inset-0 z-40 flex items-center justify-center rounded-xl bg-gray-800/75 text-white">
              <Spinner className="h-10 w-10" />
            </div>
          </Transition>

          <Transition
            as={Fragment}
            show={!image || showDetail || showRequestModal}
            enter="transition-opacity"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="absolute inset-0 overflow-hidden rounded-xl">
              <Link
                href={
                  mediaType === 'movie'
                    ? `/movie/${id}`
                    : mediaType === 'collection'
                      ? `/collection/${id}`
                      : `/tv/${id}`
                }
                className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden text-left"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(45, 55, 72, 0.4) 0%, rgba(45, 55, 72, 0.9) 100%)',
                }}
              >
                <div className="flex h-full w-full items-end">
                  <div
                    className={`px-2 text-white ${
                      canRequestTitle ? 'pb-11' : 'pb-2'
                    }`}
                  >
                    {year && <div className="text-sm font-medium">{year}</div>}

                    <h1
                      className="whitespace-normal text-xl font-bold leading-tight"
                      style={{
                        WebkitLineClamp: 3,
                        display: '-webkit-box',
                        overflow: 'hidden',
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                      }}
                      data-testid="title-card-title"
                    >
                      {title}
                    </h1>
                    <div
                      className="whitespace-normal text-xs"
                      style={{
                        WebkitLineClamp: canRequestTitle ? 3 : 5,
                        display: '-webkit-box',
                        overflow: 'hidden',
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                      }}
                    >
                      {summary}
                    </div>
                  </div>
                </div>
              </Link>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  );
};

export default withProperties(TitleCard, { Placeholder, ErrorCard });
