import Badge from '@app/components/Common/Badge';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import {
  getAcquisitionPhaseMessage,
  shouldShowDownloadEta,
} from '@app/utils/acquisitionPhase';
import { getAcquisitionPresentation } from '@app/utils/acquisitionPresentation';
import defineMessages from '@app/utils/defineMessages';
import {
  finalizingEpisodeLabel,
  hasEpisodeCoordinates,
  type DownloadTitleItem,
} from '@app/utils/downloadTitle';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import DownloadProgress from './DownloadProgress';

const messages = defineMessages('components.DownloadBlock', {
  estimatedtime: 'Estimated {time}',
  formattedTitle: '{title}: Season {seasonNumber} Episode {episodeNumber}',
});

interface DownloadBlockProps {
  downloadItem: DownloadTitleItem;
  is4k?: boolean;
  title?: string;
}

export const useDownloadTitle = () => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  return (item: DownloadTitleItem, title?: string): string => {
    if (hasPermission(Permission.ADMIN) && item.title.trim()) return item.title;
    const finalizingLabel = finalizingEpisodeLabel(item);
    if (finalizingLabel) return finalizingLabel;
    const fallback =
      title ||
      intl.formatMessage(
        item.mediaType === 'tv' ? globalMessages.tvshow : globalMessages.movie
      );
    return !hasPermission(Permission.ADMIN) &&
      item.episode &&
      hasEpisodeCoordinates(item)
      ? intl.formatMessage(messages.formattedTitle, {
          title: fallback,
          seasonNumber: item.episode.seasonNumber,
          episodeNumber: item.episode.episodeNumber,
        })
      : fallback;
  };
};

const DownloadBlock = ({
  downloadItem,
  is4k = false,
  title,
}: DownloadBlockProps) => {
  const intl = useIntl();
  const downloadTitle = useDownloadTitle();
  const displayTitle = downloadTitle(downloadItem, title);
  const { phase, progress, determinate } = getAcquisitionPresentation([
    downloadItem,
  ]);
  const phaseMessage = getAcquisitionPhaseMessage(phase);

  return (
    <div className="p-4">
      <div
        className="mb-2 w-56 truncate text-sm sm:w-80 md:w-full"
        title={displayTitle}
      >
        {displayTitle}
      </div>
      <DownloadProgress determinate={determinate} progress={progress} />
      <div className="flex items-center justify-between text-xs">
        <span>
          {is4k && (
            <Badge badgeType="warning" className="mr-2">
              4K
            </Badge>
          )}
          <Badge className="capitalize">
            {phaseMessage
              ? intl.formatMessage(phaseMessage)
              : downloadItem.status}
          </Badge>
        </span>
        <span>
          {shouldShowDownloadEta({
            acquisitionPhase: phase,
            estimatedCompletionTime: downloadItem.estimatedCompletionTime,
          })
            ? intl.formatMessage(messages.estimatedtime, {
                time: (
                  <FormattedRelativeTime
                    value={Math.floor(
                      (new Date(
                        downloadItem.estimatedCompletionTime!
                      ).getTime() -
                        Date.now()) /
                        1000
                    )}
                    updateIntervalInSeconds={1}
                    numeric="auto"
                  />
                ),
              })
            : ''}
        </span>
      </div>
    </div>
  );
};

export default DownloadBlock;
