import Badge from '@app/components/Common/Badge';
import PersonCard from '@app/components/PersonCard';
import TitleCard from '@app/components/TitleCard';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import { Permission, useUser } from '@app/hooks/useUser';
import useVerticalScroll from '@app/hooks/useVerticalScroll';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckCircleIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/20/solid';
import { MediaStatus } from '@server/constants/media';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import { useIntl } from 'react-intl';

type ListViewProps = {
  items?: (TvResult | MovieResult | PersonResult | CollectionResult)[];
  plexItems?: WatchlistItem[];
  isEmpty?: boolean;
  isLoading?: boolean;
  isReachingEnd?: boolean;
  onScrollBottom: () => void;
  mutateParent?: () => void;
  showWatchlistOwner?: boolean;
};

const messages = defineMessages('components.Common.ListView', {
  watched: 'Watched',
  watchStateUnknown: 'Watch status unavailable',
});

const ListView = ({
  items,
  isEmpty,
  isLoading,
  onScrollBottom,
  isReachingEnd,
  plexItems,
  mutateParent,
  showWatchlistOwner = false,
}: ListViewProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  useVerticalScroll(onScrollBottom, !isLoading && !isEmpty && !isReachingEnd);

  const blocklistVisibility = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );

  return (
    <>
      {isEmpty && (
        <div className="mt-64 w-full text-center text-2xl text-gray-400">
          {intl.formatMessage(globalMessages.noresults)}
        </div>
      )}
      <ul className="cards-vertical">
        {plexItems?.map((title, index) => {
          return (
            <li key={`${title.ratingKey}-${index}`}>
              <div className="relative">
                <TmdbTitleCard
                  id={title.tmdbId}
                  tmdbId={title.tmdbId}
                  type={title.mediaType}
                  isAddedToWatchlist={true}
                  canExpand
                  mutateParent={mutateParent}
                />
                {(title.watchState === 'watched' ||
                  title.watchState === 'unknown' ||
                  (showWatchlistOwner && title.requestedBy)) && (
                  <div className="pointer-events-none absolute bottom-2 left-2 z-40 flex max-w-[calc(100%-1rem)] flex-col items-start gap-1">
                    {title.watchState === 'watched' && (
                      <Badge badgeType="success">
                        <span className="flex items-center gap-1">
                          <CheckCircleIcon className="h-4 w-4" />
                          {intl.formatMessage(messages.watched)}
                        </span>
                      </Badge>
                    )}
                    {title.watchState === 'unknown' && (
                      <Badge badgeType="dark">
                        <span className="flex items-center gap-1">
                          <QuestionMarkCircleIcon className="h-4 w-4" />
                          {intl.formatMessage(messages.watchStateUnknown)}
                        </span>
                      </Badge>
                    )}
                    {showWatchlistOwner && title.requestedBy && (
                      <Badge badgeType="default">
                        {title.requestedBy.displayName}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
        {items
          ?.filter((title) => {
            if (!blocklistVisibility)
              return (
                (title as TvResult | MovieResult).mediaInfo?.status !==
                MediaStatus.BLOCKLISTED
              );
            return title;
          })
          .map((title, index) => {
            let titleCard: React.ReactNode;

            switch (title.mediaType) {
              case 'movie':
                titleCard = (
                  <TitleCard
                    key={title.id}
                    id={title.id}
                    isAddedToWatchlist={
                      title.mediaInfo?.watchlists?.length ?? 0
                    }
                    image={title.posterPath}
                    status={title.mediaInfo?.status}
                    summary={title.overview}
                    title={title.title}
                    userScore={title.voteAverage}
                    year={title.releaseDate}
                    mediaType={title.mediaType}
                    inProgress={
                      (title.mediaInfo?.downloadStatus ?? []).length > 0
                    }
                    canExpand
                  />
                );
                break;
              case 'tv':
                titleCard = (
                  <TitleCard
                    key={title.id}
                    id={title.id}
                    isAddedToWatchlist={
                      title.mediaInfo?.watchlists?.length ?? 0
                    }
                    image={title.posterPath}
                    status={title.mediaInfo?.status}
                    summary={title.overview}
                    title={title.name}
                    userScore={title.voteAverage}
                    year={title.firstAirDate}
                    mediaType={title.mediaType}
                    inProgress={
                      (title.mediaInfo?.downloadStatus ?? []).length > 0
                    }
                    canExpand
                  />
                );
                break;
              case 'collection':
                titleCard = (
                  <TitleCard
                    id={title.id}
                    image={title.posterPath}
                    summary={title.overview}
                    title={title.title}
                    mediaType={title.mediaType}
                    canExpand
                  />
                );
                break;
              case 'person':
                titleCard = (
                  <PersonCard
                    personId={title.id}
                    name={title.name}
                    profilePath={title.profilePath}
                    canExpand
                  />
                );
                break;
            }

            return <li key={`${title.id}-${index}`}>{titleCard}</li>;
          })}
        {isLoading &&
          !isReachingEnd &&
          [...Array(20)].map((_item, i) => (
            <li key={`placeholder-${i}`}>
              <TitleCard.Placeholder canExpand />
            </li>
          ))}
      </ul>
    </>
  );
};

export default ListView;
