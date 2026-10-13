import Spinner from '@app/assets/spinner.svg';
import BlocklistModal from '@app/components/BlocklistModal';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import RequestIconButton from '@app/components/Common/RequestIconButton';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import Tooltip from '@app/components/Common/Tooltip';
import { UserAvatar } from '@app/components/Library/LibraryEngagement';
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
import { EyeIcon, NoSymbolIcon, StarIcon } from '@heroicons/react/24/outline';
import { StarIcon as StarIconSolid } from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import type { Watchlist } from '@server/entity/Watchlist';
import type { LibraryUser } from '@server/interfaces/api/libraryInterfaces';
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
  watchlistOwner?: LibraryUser;
  persistentMetadata?: React.ReactNode;
  navigationHref?: string | null;
  actionsDisabled?: boolean;
  cornerAction?: React.ReactNode;
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
  viewTitle: 'View {title}',
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
  watchlistOwner,
  persistentMetadata,
  navigationHref,
  actionsDisabled = false,
  cornerAction,
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
  const mountedRef = useRef(true);
  const watchlistMutationRef = useRef(false);
  const targetIdentityRef = useRef(`${mediaType}:${id}`);
  const confirmedWatchlistStateRef = useRef<boolean | null>(null);

  // Just to get the year from the date
  if (year) {
    year = year.slice(0, 4);
  }

  useEffect(() => {
    setCurrentStatus(status);
  }, [status]);

  useEffect(() => {
    const nextTargetIdentity = `${mediaType}:${id}`;
    if (targetIdentityRef.current !== nextTargetIdentity) {
      confirmedWatchlistStateRef.current = null;
      watchlistMutationRef.current = false;
      setIsUpdating(false);
    }
    targetIdentityRef.current = nextTargetIdentity;
    const authoritativeMembership = Boolean(isAddedToWatchlist);
    if (watchlistMutationRef.current) return;
    if (confirmedWatchlistStateRef.current !== null) {
      if (confirmedWatchlistStateRef.current !== authoritativeMembership) {
        return;
      }
      confirmedWatchlistStateRef.current = null;
    }
    setToggleWatchlist(!authoritativeMembership);
  }, [id, isAddedToWatchlist, mediaType]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      watchlistMutationRef.current = false;
    };
  }, []);

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
    if (watchlistMutationRef.current) return;
    const targetIdentity = `${mediaType}:${id}`;
    watchlistMutationRef.current = true;
    setIsUpdating(true);
    try {
      const response = await axios.post<Watchlist>('/api/v1/watchlist', {
        tmdbId: id,
        mediaType,
        title,
      });
      if (
        response.data &&
        mountedRef.current &&
        targetIdentityRef.current === targetIdentity
      ) {
        confirmedWatchlistStateRef.current = true;
        setToggleWatchlist(false);
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
        void mutate('/api/v1/discover/watchlist');
        mutateParent?.();
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      watchlistMutationRef.current = false;
      if (mountedRef.current && targetIdentityRef.current === targetIdentity) {
        setIsUpdating(false);
      }
    }
  };

  const onClickDeleteWatchlistBtn = async (): Promise<void> => {
    if (watchlistMutationRef.current) return;
    const targetIdentity = `${mediaType}:${id}`;
    watchlistMutationRef.current = true;
    setIsUpdating(true);
    try {
      const response = await axios.delete<Watchlist>(
        `/api/v1/watchlist/${id}?mediaType=${mediaType}`
      );

      if (response.status === 204) {
        if (
          !mountedRef.current ||
          targetIdentityRef.current !== targetIdentity
        ) {
          return;
        }
        confirmedWatchlistStateRef.current = false;
        setToggleWatchlist(true);
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistDeleted, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'info', autoDismiss: true }
        );
        void mutate('/api/v1/discover/watchlist');
        mutateParent?.();
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      watchlistMutationRef.current = false;
      if (mountedRef.current && targetIdentityRef.current === targetIdentity) {
        setIsUpdating(false);
      }
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
  const rightSideActions = [
    ...(cornerAction
      ? [
          {
            id: 'custom-corner-action',
            content: cornerAction,
          },
        ]
      : []),
    ...(showDetail && !actionsDisabled
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
                        disabled={isUpdating}
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
      : []),
  ];
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
    !actionsDisabled &&
    showRequestButton &&
    (!currentStatus ||
      currentStatus === MediaStatus.UNKNOWN ||
      currentStatus === MediaStatus.DELETED);
  const cardHref =
    navigationHref === undefined
      ? mediaType === 'movie'
        ? `/movie/${id}`
        : mediaType === 'collection'
          ? `/collection/${id}`
          : `/tv/${id}`
      : navigationHref;
  const renderDetails = () => (
    <div
      className={
        persistentMetadata
          ? 'grid h-full w-full grid-rows-[1fr_auto] p-2'
          : 'flex h-full w-full items-end'
      }
    >
      <div
        className={`text-white ${
          persistentMetadata
            ? 'self-end'
            : `px-2 ${canRequestTitle ? 'pb-11' : 'pb-2'}`
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
      {persistentMetadata && (
        <div
          aria-hidden="true"
          className="invisible mb-1 mt-2 max-w-full justify-self-center break-words rounded-md px-2 py-1 text-center text-xs font-medium"
        >
          {persistentMetadata}
        </div>
      )}
    </div>
  );

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
        onMouseLeave={() => {
          if (!cardRef.current?.contains(document.activeElement)) {
            setShowDetail(false);
          }
        }}
        onTouchStart={() => {
          if (!cardHref) setShowDetail(true);
        }}
        onFocusCapture={() => setShowDetail(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setShowDetail(false);
          }
        }}
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
          {cardHref && (
            <Link
              href={cardHref}
              aria-label={intl.formatMessage(messages.viewTitle, { title })}
              className="absolute inset-0 z-20 h-full w-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
              onClick={(event) => {
                if (isTouch && !showDetail) {
                  event.preventDefault();
                  setShowDetail(true);
                }
              }}
            >
              <span className="sr-only">{title}</span>
            </Link>
          )}
          <div
            className="pointer-events-none absolute inset-0 z-30 p-2"
            data-testid="title-card-corner-frame"
          >
            <div className="grid h-full grid-cols-[minmax(0,1fr)_auto] grid-rows-[auto_1fr_auto] gap-x-2">
              <div
                className="col-start-1 row-start-1 flex min-w-0 self-start justify-self-start"
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
              {watchlistOwner && (
                <div
                  className="pointer-events-auto col-start-1 row-start-3 flex min-w-0 items-center self-end justify-self-start leading-none"
                  data-testid="title-card-owner-region"
                >
                  <UserAvatar user={watchlistOwner} />
                </div>
              )}
              {persistentMetadata && (
                <div
                  className="col-span-2 col-start-1 row-start-3 mb-1 max-w-full self-end justify-self-center break-words rounded-md bg-gray-900/90 px-2 py-1 text-center text-xs font-medium text-yellow-200 shadow-md"
                  data-testid="title-card-persistent-metadata"
                >
                  {persistentMetadata}
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
                      <RequestIconButton
                        aria-label={intl.formatMessage(globalMessages.request)}
                        onClick={(e) => {
                          e.preventDefault();
                          setShowRequestModal(true);
                        }}
                        className="z-40 !h-8 !w-8 !p-1.5"
                      />
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
            <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-xl">
              <div
                className="absolute inset-0 h-full w-full overflow-hidden text-left"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(45, 55, 72, 0.4) 0%, rgba(45, 55, 72, 0.9) 100%)',
                }}
              >
                {renderDetails()}
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  );
};

export default withProperties(TitleCard, { Placeholder, ErrorCard });
