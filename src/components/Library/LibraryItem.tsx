import RadarrLogo from '@app/assets/services/radarr.svg';
import SonarrLogo from '@app/assets/services/sonarr.svg';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import CancelScheduledRemovalButton from '@app/components/Common/CancelScheduledRemovalButton';
import JellyfinLogo from '@app/components/Common/JellyfinIcon';
import RequestIconButton from '@app/components/Common/RequestIconButton';
import Tooltip from '@app/components/Common/Tooltip';
import {
  AvatarStack,
  LastActiveAvatarStack,
  RequesterAvatarStack,
  WatchedChipGroup,
} from '@app/components/Library/LibraryEngagement';
import LibraryResolutionBadge from '@app/components/Library/LibraryResolutionBadge';
import LibrarySelectionCheckbox from '@app/components/Library/LibrarySelectionCheckbox';
import SeriesDetail from '@app/components/Library/SeriesDetail';
import {
  formatCollectionAvailability,
  getCollectionAvailability,
} from '@app/components/Library/collectionAvailability';
import {
  classifyLibrarySeasonAvailability,
  formatLibraryResolution,
  formatLibrarySize,
  librarySeasonStateClass,
} from '@app/components/Library/presentation';
import {
  getEligibleLibrarySeasonNumbers,
  type LibraryItemSelectionState,
  type LibrarySelectionKey,
  type LibrarySelectionTarget,
} from '@app/components/Library/selection';
import useLibraryIndividualActions from '@app/components/Library/useLibraryIndividualActions';
import RequestModal from '@app/components/RequestModal';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { factualDaysAgo, parseFactualDate } from '@app/utils/factualDate';
import {
  ArrowRightStartOnRectangleIcon,
  BookmarkIcon,
  CalendarDateRangeIcon,
  CalendarDaysIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  FireIcon,
  FolderArrowDownIcon,
  PlayIcon,
  ServerIcon,
  ServerStackIcon,
  StarIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import type {
  LibraryCollectionSummary,
  LibraryExternalLink,
  LibraryItem as LibraryItemType,
  LibrarySeasonSummary,
} from '@server/interfaces/api/libraryInterfaces';
import type { Collection } from '@server/models/Collection';
import axios from 'axios';
import Link from 'next/link';
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Library.Item', {
  added: 'Added',
  lastActive: 'Last active',
  removed: 'Removed',
  size: 'Size',
  storage: 'Storage',
  watchlist: 'Watchlist',
  watched: 'Watched',
  requesters: 'Requesters',
  fresh: 'Fresh',
  tmdbRating: 'TMDB rating · {votes} votes',
  season: 'Season {number}',
  specials: 'Specials',
  availableEpisodes:
    '{count, plural, =0 {No episodes available} one {# episode available} other {# episodes available}}',
  seasonEpisodeRatio: '{available}/{known} episodes',
  seasonArchive: 'Archived',
  seasonKnownMissing: 'Missing',
  requestSeason: 'Request {season}',
  showSeriesDetail: 'Show Series watched detail',
  hideSeriesDetail: 'Hide Series watched detail',
  scheduled: 'Leaves {date}',
  scheduleCount:
    '{count, plural, one {# removal schedule} other {# removal schedules}}',
  manual: 'Manual',
  scheduledSource: 'Scheduled',
  external: 'External',
  unknown: 'Unknown',
  cancelScheduledRemoval: 'Cancel scheduled removal',
  scheduleRemoval: 'Schedule removal',
  removeNow: 'Remove',
  selectItem: 'Select {title}',
  confirmRemoval:
    'Permanently remove this item and its files from the configured service?',
  requestCollection: 'Request collection',
  viewCollection: 'View {collectionName}',
});

const metadataColumnClassName =
  'grid min-w-0 grid-rows-[1.25rem_1.25rem] content-center gap-y-1.5';
const metadataRowClassName = 'flex h-5 min-w-0 items-center gap-x-1.5';
const metadataIconSlotClassName =
  'inline-flex h-4 w-4 flex-none items-center justify-center';

const AbsoluteDate = ({
  value,
  label,
  Icon,
  includeTime = false,
}: {
  value: string | null;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  includeTime?: boolean;
}) => {
  const intl = useIntl();
  if (!value)
    return (
      <span className={`${metadataRowClassName} text-gray-500`}>
        <span className={metadataIconSlotClassName}>
          <Icon className="h-4 w-4 text-slate-300" aria-hidden="true" />
        </span>
        <span>—</span>
      </span>
    );
  const date = parseFactualDate(value);
  const absolute = includeTime
    ? intl.formatDate(date, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : intl.formatDate(date, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
  return (
    <Tooltip content={`${label}: ${absolute}`}>
      <span
        className={`${metadataRowClassName} w-fit max-w-full justify-self-start whitespace-nowrap text-gray-200`}
        tabIndex={0}
        aria-label={`${label}: ${absolute}`}
      >
        <span className={metadataIconSlotClassName}>
          <Icon className="h-4 w-4 text-slate-300" aria-hidden="true" />
        </span>
        <span>{factualDaysAgo(date)}</span>
      </span>
    </Tooltip>
  );
};

const SeasonPill = ({
  season,
  onRequest,
}: {
  season: LibrarySeasonSummary;
  onRequest?: (seasonNumber: number) => void;
}) => {
  const intl = useIntl();
  const title = season.isSpecial
    ? intl.formatMessage(messages.specials)
    : intl.formatMessage(messages.season, { number: season.seasonNumber });
  const availability = classifyLibrarySeasonAvailability(season);
  const description =
    availability === 'available' || availability === 'partial'
      ? intl.formatMessage(messages.seasonEpisodeRatio, {
          available: season.availableEpisodeCount,
          known: season.knownEpisodeCount,
        })
      : availability === 'archive'
        ? intl.formatMessage(messages.seasonArchive)
        : availability === 'missing'
          ? intl.formatMessage(messages.seasonKnownMissing)
          : intl.formatMessage(messages.availableEpisodes, {
              count: season.availableEpisodeCount,
            });
  const stateClass = librarySeasonStateClass(season, availability);
  const requestLabel = intl.formatMessage(messages.requestSeason, {
    season: title,
  });
  const requestText = intl.formatMessage(globalMessages.request);
  const content =
    season.requestable && onRequest
      ? availability === 'partial'
        ? `${title} · ${description} · ${requestText}`
        : `${title} · ${requestText}`
      : `${title} · ${description}`;
  const className = `inline-flex h-6 min-w-6 items-center justify-center rounded border px-1 text-[0.6875rem] font-semibold ${stateClass}`;
  return (
    <Tooltip content={content}>
      {season.requestable && onRequest ? (
        <button
          id={season.key}
          type="button"
          aria-label={requestLabel}
          className={`${className} cursor-pointer hover:border-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRequest(season.seasonNumber);
          }}
        >
          {season.isSpecial ? 'S' : season.seasonNumber}
        </button>
      ) : (
        <span id={season.key} className={className} tabIndex={0}>
          {season.isSpecial ? 'S' : season.seasonNumber}
        </span>
      )}
    </Tooltip>
  );
};

const ExternalServiceLink = ({ link }: { link: LibraryExternalLink }) => {
  const Icon =
    link.service === 'radarr'
      ? RadarrLogo
      : link.service === 'sonarr'
        ? SonarrLogo
        : JellyfinLogo;
  const iconClassName = link.service === 'jellyfin' ? 'h-6 w-6' : 'h-5 w-5';
  return (
    <Tooltip content={link.label}>
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={link.label}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gray-900/80 text-gray-200 transition hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-300"
      >
        <Icon className={iconClassName} />
      </a>
    </Tooltip>
  );
};

interface LibraryCollectionBannerProps {
  collection: LibraryCollectionSummary;
  canRequest: boolean;
  onRequest: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

const LibraryCollectionBanner = ({
  collection,
  canRequest,
  onRequest,
}: LibraryCollectionBannerProps) => {
  const intl = useIntl();
  const artwork = collection.backdropPath ?? collection.posterPath;
  const { ref, inView } = useInView({
    triggerOnce: true,
    rootMargin: '160px 0px',
  });
  const { data: collectionDetails, error: collectionError } =
    useSWR<Collection>(inView ? `/api/v1/collection/${collection.id}` : null, {
      dedupingInterval: 300_000,
      revalidateIfStale: false,
      revalidateOnFocus: false,
    });
  const availability =
    collectionDetails && !collectionError
      ? getCollectionAvailability(collectionDetails)
      : undefined;
  const availabilityLabel = formatCollectionAvailability(availability);
  return (
    <div
      ref={ref}
      className="group relative h-16 w-full min-w-0 max-w-80 overflow-hidden rounded-md bg-gray-800 shadow-md transition"
      data-testid="library-collection-banner"
    >
      {artwork && (
        <div className="absolute inset-0">
          <CachedImage
            type="tmdb"
            src={`https://image.tmdb.org/t/p/w500${artwork}`}
            alt=""
            fill
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                'linear-gradient(180deg, rgba(31, 41, 55, 0.47) 0%, rgba(31, 41, 55, 0.9) 100%)',
            }}
          />
        </div>
      )}
      <Link
        href={`/collection/${collection.id}`}
        className="absolute inset-0 z-10 rounded-md bg-white/0 transition-colors hover:bg-white/5 focus:outline-none focus-visible:bg-white/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-300"
        aria-label={intl.formatMessage(messages.viewCollection, {
          collectionName: collection.name,
        })}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="sr-only">
          {intl.formatMessage(messages.viewCollection, {
            collectionName: collection.name,
          })}
        </span>
      </Link>
      <div className="pointer-events-none relative z-20 flex h-full min-w-0 items-center gap-2 px-2 py-1.5">
        <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight text-gray-100">
          <span
            className="min-w-0 truncate text-xs font-semibold"
            title={collection.name}
          >
            {collection.name}
          </span>
          <span
            className="min-h-4 whitespace-nowrap text-[0.6875rem] font-medium tabular-nums text-gray-300"
            aria-live="polite"
            data-testid="library-collection-availability"
          >
            {availabilityLabel ?? '\u00a0'}
          </span>
        </div>
        {canRequest && (
          <div className="pointer-events-auto flex-none">
            <Tooltip content={intl.formatMessage(messages.requestCollection)}>
              <RequestIconButton
                aria-label={intl.formatMessage(messages.requestCollection)}
                onClick={onRequest}
              />
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  );
};

type LibraryRequestTarget = {
  type: 'movie' | 'tv' | 'collection';
  tmdbId: number;
  initialSeasonNumber?: number;
  visibleSeasonNumbers?: number[];
};

interface LibraryItemProps {
  item: LibraryItemType;
  expanded: boolean;
  selectionState: LibraryItemSelectionState;
  selectedKeys?: ReadonlySet<LibrarySelectionKey>;
  onSelectionChange: (
    target: LibrarySelectionTarget,
    selected: boolean,
    eligibleSeasonNumbers?: readonly number[]
  ) => void;
  onToggleExpanded: (canonicalMediaId: number) => void;
  onChanged: () => void;
}

const LibraryItem = ({
  item,
  expanded,
  selectionState,
  selectedKeys,
  onSelectionChange,
  onToggleExpanded,
  onChanged,
}: LibraryItemProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const [requestTarget, setRequestTarget] =
    useState<LibraryRequestTarget | null>(null);
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const { isPending, run } = useLibraryIndividualActions(
    `${item.mediaType}:${item.canonicalMediaId}`
  );
  const targetActionPending = isPending('target');
  const canRequestMovie = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_MOVIE],
    { type: 'or' }
  );
  const canRequestSeries = hasPermission(
    [Permission.REQUEST, Permission.REQUEST_TV],
    { type: 'or' }
  );
  const eligibleSeasonNumbers = useMemo(
    () => getEligibleLibrarySeasonNumbers(item),
    [item]
  );
  const handleToggleExpanded = useCallback(
    () => onToggleExpanded(item.canonicalMediaId),
    [item.canonicalMediaId, onToggleExpanded]
  );
  const handleSelectionChange = useCallback(
    (selected: boolean) =>
      onSelectionChange(
        {
          type: item.mediaType,
          canonicalMediaId: item.canonicalMediaId,
        },
        selected,
        eligibleSeasonNumbers
      ),
    [
      eligibleSeasonNumbers,
      item.canonicalMediaId,
      item.mediaType,
      onSelectionChange,
    ]
  );
  const openRequestModal = useCallback((target: LibraryRequestTarget) => {
    setRequestTarget(target);
    setRequestModalOpen(true);
  }, []);
  const closeRequestModal = useCallback(() => setRequestModalOpen(false), []);
  const completeRequest = useCallback(() => {
    setRequestModalOpen(false);
    onChanged();
  }, [onChanged]);
  const mediaHref = item.tmdbId
    ? item.mediaType === 'movie'
      ? `/movie/${item.tmdbId}`
      : `/tv/${item.tmdbId}`
    : null;
  const mainSchedule = item.removalSchedules?.find(
    (schedule) => schedule.targetType === item.mediaType
  );
  const firstSchedule = item.removalSchedules?.[0];
  const storageLabel = item.storageRoots.length
    ? `${item.storageRoots[0].label}${
        item.storageRoots.length > 1 ? ` +${item.storageRoots.length - 1}` : ''
      }`
    : '—';
  const storageTooltip = item.storageRoots.map((root) => root.label).join(', ');
  const resolutionLabel = formatLibraryResolution(item.resolution);
  const canRequestTitle = Boolean(
    item.tmdbId &&
    item.mediaType === 'movie' &&
    item.libraryState === 'archive' &&
    canRequestMovie
  );
  const canRequestSeason = Boolean(
    item.tmdbId &&
    canRequestSeries &&
    settings.currentSettings.partialRequestsEnabled
  );
  const removalSource = item.removalSource
    ? intl.formatMessage(
        item.removalSource === 'manual'
          ? messages.manual
          : item.removalSource === 'scheduled'
            ? messages.scheduledSource
            : item.removalSource === 'external'
              ? messages.external
              : messages.unknown
      )
    : null;
  const posterContainerClassName =
    'relative h-[5.0625rem] w-[3.375rem] flex-shrink-0 sm:w-16';
  const poster = (
    <CachedImage
      type="tmdb"
      src={
        item.posterPath
          ? `https://image.tmdb.org/t/p/w185${item.posterPath}`
          : '/images/seerr_poster_not_found.png'
      }
      alt=""
      width={64}
      height={96}
      className="h-[5.0625rem] w-[3.375rem] rounded object-cover sm:absolute sm:left-0 sm:top-1/2 sm:h-24 sm:w-16 sm:-translate-y-1/2"
    />
  );
  const identity = (
    <>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-gray-300">{item.year ?? '—'}</span>
          {item.fresh && (
            <Tooltip content={intl.formatMessage(messages.fresh)}>
              <span
                tabIndex={0}
                aria-label={intl.formatMessage(messages.fresh)}
              >
                <FireIcon className="h-5 w-5 text-orange-400" />
              </span>
            </Tooltip>
          )}
        </div>
        <div className="mt-1 truncate text-base font-bold text-white group-hover:underline group-focus-visible:underline">
          {item.title}
        </div>
      </div>
    </>
  );

  return (
    <article
      className="relative isolate overflow-hidden rounded-xl bg-gray-800 text-gray-400 shadow-md"
      data-testid={`library-library-row-${item.canonicalMediaId}`}
      data-library-state={item.libraryState}
    >
      {requestTarget && (
        <RequestModal
          show={requestModalOpen}
          type={requestTarget.type}
          tmdbId={requestTarget.tmdbId}
          initialSeasonNumber={requestTarget.initialSeasonNumber}
          visibleSeasonNumbers={requestTarget.visibleSeasonNumbers}
          onComplete={completeRequest}
          onCancel={closeRequestModal}
        />
      )}
      {item.backdropPath && (
        <div
          aria-hidden="true"
          className={`absolute inset-0 z-0 w-full overflow-hidden rounded-[inherit] bg-cover bg-center ${
            item.libraryState === 'archive' ? 'grayscale' : ''
          }`}
        >
          <CachedImage
            type="tmdb"
            src={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${item.backdropPath}`}
            alt=""
            fill
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          <div
            className="absolute inset-0 rounded-[inherit]"
            style={{
              backgroundImage:
                'linear-gradient(90deg, rgba(31, 41, 55, 0.55) 0%, rgba(31, 41, 55, 1) 100%)',
            }}
          />
        </div>
      )}
      {firstSchedule && (
        <div className="absolute right-0 top-0 z-20 flex max-w-[calc(100%_-_2rem)]">
          <Tooltip
            content={intl.formatMessage(messages.scheduleCount, {
              count: item.removalSchedules?.length ?? 0,
            })}
          >
            <span
              className="inline-flex h-4 max-w-full items-center whitespace-nowrap rounded-bl-md rounded-tr-xl bg-gray-900/90 px-2 text-center text-[0.6875rem] font-medium leading-none text-yellow-200 shadow-md"
              data-testid="library-leaving-soon-badge"
            >
              {intl.formatMessage(messages.scheduled, {
                date: intl.formatDate(firstSchedule.removeAt, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                }),
              })}
            </span>
          </Tooltip>
        </div>
      )}
      <div className="relative z-10 grid min-w-0 gap-4 p-4 md:grid-cols-2 xl:grid-cols-[minmax(15rem,1.05fr)_minmax(12rem,0.8fr)_4rem_minmax(18rem,1.2fr)_auto] xl:items-center">
        <div className="flex min-w-0 items-center overflow-visible">
          <div className="-ml-4 flex w-10 flex-shrink-0 items-center justify-center self-stretch">
            <LibrarySelectionCheckbox
              checked={selectionState === 'selected'}
              indeterminate={selectionState === 'some'}
              disabled={
                item.mediaType === 'series' &&
                eligibleSeasonNumbers.length === 0
              }
              hitArea="card"
              label={intl.formatMessage(messages.selectItem, {
                title: item.title,
              })}
              onChange={handleSelectionChange}
            />
          </div>
          {mediaHref ? (
            <Link
              href={mediaHref}
              className={posterContainerClassName}
              aria-label={item.title}
            >
              {poster}
            </Link>
          ) : (
            <div className={posterContainerClassName}>{poster}</div>
          )}
          <div className="min-w-0 pl-3">
            {mediaHref ? (
              <Link href={mediaHref} className="group block min-w-0">
                {identity}
              </Link>
            ) : (
              identity
            )}
            {item.mediaType === 'series' && item.seasonSummaries.length > 0 && (
              <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
                {item.seasonSummaries
                  .filter((season) => !season.isSpecial)
                  .map((season) => {
                    const availability =
                      classifyLibrarySeasonAvailability(season);
                    const actionableAvailability =
                      availability === 'partial' ||
                      availability === 'archive' ||
                      availability === 'missing';
                    return (
                      <SeasonPill
                        season={season}
                        key={season.key}
                        onRequest={
                          canRequestSeason &&
                          season.requestable &&
                          actionableAvailability
                            ? (seasonNumber) => {
                                if (!item.tmdbId) return;
                                openRequestModal({
                                  type: 'tv',
                                  tmdbId: item.tmdbId,
                                  initialSeasonNumber: seasonNumber,
                                  visibleSeasonNumbers: [seasonNumber],
                                });
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                <button
                  type="button"
                  className="rounded p-0.5 text-gray-300 hover:bg-gray-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-300"
                  aria-label={intl.formatMessage(
                    expanded
                      ? messages.hideSeriesDetail
                      : messages.showSeriesDetail
                  )}
                  aria-expanded={expanded}
                  onClick={handleToggleExpanded}
                >
                  {expanded ? (
                    <ChevronUpIcon className="h-4 w-4" />
                  ) : (
                    <ChevronDownIcon className="h-4 w-4" />
                  )}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] content-center items-center gap-x-3 gap-y-3">
          {item.lastActiveUsers.length > 0 && (
            <div className="col-start-1 row-start-1 flex h-7 w-fit min-w-0 max-w-full flex-nowrap items-center gap-2">
              <Tooltip content={intl.formatMessage(messages.lastActive)}>
                <span
                  aria-label={intl.formatMessage(messages.lastActive)}
                  className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-slate-300"
                  tabIndex={0}
                >
                  <ClockIcon className="h-4 w-4" />
                </span>
              </Tooltip>
              <LastActiveAvatarStack
                users={item.lastActiveUsers}
                lastActiveAt={item.lastActiveAt}
                ariaLabel={intl.formatMessage(messages.lastActive)}
              />
            </div>
          )}
          {item.requesters.length > 0 && (
            <div className="col-start-1 row-start-2 flex h-7 w-fit min-w-0 max-w-full flex-nowrap items-center gap-2">
              <Tooltip content={intl.formatMessage(messages.requesters)}>
                <span
                  aria-label={intl.formatMessage(messages.requesters)}
                  className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-slate-300"
                  tabIndex={0}
                >
                  <FolderArrowDownIcon className="h-4 w-4" />
                </span>
              </Tooltip>
              <RequesterAvatarStack
                requesters={item.requesters}
                ariaLabel={intl.formatMessage(messages.requesters)}
              />
            </div>
          )}
          {item.watchlistUsers.length > 0 && (
            <div className="col-start-2 row-start-1 flex h-7 w-fit min-w-0 max-w-full flex-nowrap items-center gap-2">
              <Tooltip content={intl.formatMessage(messages.watchlist)}>
                <span
                  aria-label={intl.formatMessage(messages.watchlist)}
                  className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-slate-300"
                  tabIndex={0}
                >
                  <BookmarkIcon className="h-4 w-4" />
                </span>
              </Tooltip>
              <AvatarStack users={item.watchlistUsers} />
            </div>
          )}
          {item.watchedUsers.length > 0 && (
            <div className="col-start-2 row-start-2 flex h-7 w-fit min-w-0 max-w-full flex-nowrap items-center gap-2">
              <Tooltip content={intl.formatMessage(messages.watched)}>
                <span
                  aria-label={intl.formatMessage(messages.watched)}
                  className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-green-400"
                  tabIndex={0}
                >
                  <PlayIcon className="h-4 w-4" />
                </span>
              </Tooltip>
              <WatchedChipGroup users={item.watchedUsers} />
            </div>
          )}
        </div>

        <div className={`${metadataColumnClassName} text-sm`}>
          <div className="flex h-5 min-w-0 items-center">
            {item.tmdbRating && item.tmdbRating.voteAverage > 0 && (
              <Tooltip
                content={intl.formatMessage(messages.tmdbRating, {
                  votes: item.tmdbRating.voteCount,
                })}
              >
                <span
                  className={`${metadataRowClassName} text-gray-200`}
                  tabIndex={0}
                >
                  <span className={metadataIconSlotClassName}>
                    <StarIcon className="h-4 w-4 text-yellow-400" />
                  </span>
                  <span>{item.tmdbRating.voteAverage.toFixed(1)}</span>
                </span>
              </Tooltip>
            )}
          </div>
          <div className="flex h-5 min-w-0 items-center">
            {resolutionLabel && (
              <LibraryResolutionBadge label={resolutionLabel} />
            )}
          </div>
        </div>

        <div
          className={`grid min-w-0 items-center ${
            item.collection
              ? '2xl:grid-cols-[max-content_minmax(0,1fr)] 2xl:gap-4'
              : ''
          }`}
        >
          <div className="grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-5 text-sm">
            <div className={metadataColumnClassName}>
              <AbsoluteDate
                value={item.addedAt}
                label={intl.formatMessage(messages.added)}
                Icon={CalendarDaysIcon}
              />
              <AbsoluteDate
                value={item.lastActiveAt}
                label={intl.formatMessage(messages.lastActive)}
                Icon={ClockIcon}
                includeTime
              />
            </div>
            <div className={metadataColumnClassName}>
              {item.libraryState === 'archive' ? (
                <>
                  <AbsoluteDate
                    value={item.removedAt}
                    label={intl.formatMessage(messages.removed)}
                    Icon={ArrowRightStartOnRectangleIcon}
                  />
                  {removalSource && (
                    <Badge
                      badgeType="light"
                      className="w-fit max-w-full justify-self-start"
                    >
                      {removalSource}
                    </Badge>
                  )}
                </>
              ) : (
                <>
                  <Tooltip content={intl.formatMessage(messages.size)}>
                    <span
                      className={`${metadataRowClassName} w-fit max-w-full justify-self-start whitespace-nowrap text-gray-200`}
                      tabIndex={0}
                    >
                      <span className={metadataIconSlotClassName}>
                        <ServerIcon className="h-4 w-4 text-slate-300" />
                      </span>
                      <span>{formatLibrarySize(item.logicalSizeBytes)}</span>
                    </span>
                  </Tooltip>
                  <Tooltip
                    content={
                      storageTooltip || intl.formatMessage(messages.storage)
                    }
                  >
                    <span
                      className={`${metadataRowClassName} w-fit max-w-full justify-self-start text-gray-200`}
                      tabIndex={0}
                    >
                      <span className="inline-flex h-4 min-w-4 flex-shrink-0 items-center justify-center gap-0.5">
                        {item.storageRoots.length ? (
                          item.storageRoots.map((root) => (
                            <ServerStackIcon
                              key={root.id}
                              className={`h-4 w-4 ${
                                root.color ? '' : 'text-gray-400'
                              }`}
                              style={
                                root.color ? { color: root.color } : undefined
                              }
                              aria-hidden="true"
                            />
                          ))
                        ) : (
                          <ServerStackIcon
                            className="h-4 w-4 text-gray-400"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span className="truncate">{storageLabel}</span>
                    </span>
                  </Tooltip>
                </>
              )}
            </div>
          </div>

          {item.collection && (
            <div className="hidden min-w-0 self-center 2xl:grid 2xl:items-center 2xl:justify-items-end">
              <LibraryCollectionBanner
                collection={item.collection}
                canRequest={canRequestMovie}
                onRequest={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openRequestModal({
                    type: 'collection',
                    tmdbId: item.collection!.id,
                  });
                }}
              />
            </div>
          )}
        </div>

        <div
          className="flex min-w-0 flex-wrap items-center gap-2 self-center xl:w-16 xl:justify-end"
          data-testid="library-action-grid"
        >
          <div className="grid w-16 gap-2">
            <div className="grid grid-cols-2 gap-1.5">
              {item.externalLinks.map((link) => (
                <ExternalServiceLink
                  link={link}
                  key={`${link.service}:${link.url}`}
                />
              ))}
              {canRequestTitle && item.tmdbId && (
                <Tooltip content={intl.formatMessage(globalMessages.request)}>
                  <RequestIconButton
                    aria-label={intl.formatMessage(globalMessages.request)}
                    data-testid="library-request-button"
                    className={
                      item.externalLinks.length % 2 === 0
                        ? 'col-span-2 justify-self-center'
                        : undefined
                    }
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openRequestModal({
                        type: item.mediaType === 'movie' ? 'movie' : 'tv',
                        tmdbId: item.tmdbId as number,
                      });
                    }}
                  />
                </Tooltip>
              )}
            </div>
            {item.libraryState === 'current' && (
              <div className="grid grid-cols-2 gap-1.5">
                {mainSchedule ? (
                  <CancelScheduledRemovalButton
                    label={intl.formatMessage(messages.cancelScheduledRemoval)}
                    disabled={targetActionPending}
                    onClick={() => {
                      void run({
                        key: 'target',
                        actionLabel: intl.formatMessage(
                          messages.cancelScheduledRemoval
                        ),
                        action: () =>
                          axios.delete(
                            `/api/v1/library/removal-schedules/${mainSchedule.id}`
                          ),
                        onCompleted: onChanged,
                      });
                    }}
                  />
                ) : (
                  <Tooltip
                    content={intl.formatMessage(messages.scheduleRemoval)}
                  >
                    <Button
                      aria-label={intl.formatMessage(messages.scheduleRemoval)}
                      buttonType="warning"
                      buttonSize="sm"
                      className="h-7 w-7 border-transparent bg-yellow-500/30 !p-0 hover:bg-yellow-500 focus:bg-yellow-500/80"
                      disabled={targetActionPending}
                      onClick={() => {
                        void run({
                          key: 'target',
                          actionLabel: intl.formatMessage(
                            messages.scheduleRemoval
                          ),
                          action: () =>
                            axios.post(
                              `/api/v1/library/${item.canonicalMediaId}/removal-schedules`,
                              { targetType: item.mediaType }
                            ),
                          onCompleted: onChanged,
                        });
                      }}
                    >
                      <CalendarDateRangeIcon className="!h-6 !w-6" />
                    </Button>
                  </Tooltip>
                )}
                <Tooltip content={intl.formatMessage(messages.removeNow)}>
                  <Button
                    aria-label={intl.formatMessage(messages.removeNow)}
                    buttonType="danger"
                    buttonSize="sm"
                    className="h-7 w-7 border-transparent bg-red-600/30 !p-0 hover:bg-red-600 focus:bg-red-600/80"
                    disabled={targetActionPending}
                    onClick={() => {
                      if (
                        !window.confirm(
                          intl.formatMessage(messages.confirmRemoval)
                        )
                      )
                        return;
                      void run({
                        key: 'target',
                        actionLabel: intl.formatMessage(messages.removeNow),
                        action: () =>
                          axios.post(
                            `/api/v1/library/${item.canonicalMediaId}/remove`,
                            {
                              targetType: item.mediaType,
                            }
                          ),
                        onCompleted: onChanged,
                      });
                    }}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </Tooltip>
              </div>
            )}
          </div>
        </div>
      </div>
      {expanded && item.mediaType === 'series' && (
        <div className="relative z-10">
          <SeriesDetail
            canonicalMediaId={item.canonicalMediaId}
            seriesTitle={item.title}
            readOnly={item.libraryState === 'archive'}
            selectedKeys={selectedKeys ?? new Set()}
            eligibleSeasonNumbers={eligibleSeasonNumbers}
            onSelectionChange={onSelectionChange}
            onChanged={onChanged}
          />
        </div>
      )}
    </article>
  );
};

export default memo(LibraryItem);
