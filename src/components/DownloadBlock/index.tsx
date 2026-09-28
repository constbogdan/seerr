import Badge from '@app/components/Common/Badge';
import { Permission, useUser } from '@app/hooks/useUser';
import {
  calculateDownloadProgress,
  getAcquisitionPhaseMessage,
  isDeterminateAcquisitionPhase,
  shouldShowDownloadEta,
} from '@app/utils/acquisitionPhase';
import defineMessages from '@app/utils/defineMessages';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import DownloadProgress from './DownloadProgress';

const messages = defineMessages('components.DownloadBlock', {
  estimatedtime: 'Estimated {time}',
  formattedTitle: '{title}: Season {seasonNumber} Episode {episodeNumber}',
});

interface DownloadBlockProps {
  downloadItem: DownloadingItem;
  is4k?: boolean;
  title?: string;
}

const DownloadBlock = ({
  downloadItem,
  is4k = false,
  title,
}: DownloadBlockProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const progress = calculateDownloadProgress(downloadItem);
  const determinateProgress = isDeterminateAcquisitionPhase(
    downloadItem.acquisitionPhase
  );
  const phaseMessage = getAcquisitionPhaseMessage(
    downloadItem.acquisitionPhase
  );

  return (
    <div className="p-4">
      <div className="mb-2 w-56 truncate text-sm sm:w-80 md:w-full">
        {hasPermission(Permission.ADMIN)
          ? downloadItem.title
          : downloadItem.episode
            ? intl.formatMessage(messages.formattedTitle, {
                title,
                seasonNumber: downloadItem?.episode?.seasonNumber,
                episodeNumber: downloadItem?.episode?.episodeNumber,
              })
            : title}
      </div>
      <DownloadProgress
        determinate={determinateProgress}
        progress={determinateProgress ? progress : undefined}
      />
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
          {shouldShowDownloadEta(downloadItem)
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
