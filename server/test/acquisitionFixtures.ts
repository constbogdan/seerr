import { MediaType } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import type { DownloadingItem } from '@server/lib/downloadtracker';

export const acquisitionDownload = (
  episodeNumber = 1,
  overrides: Partial<DownloadingItem> = {}
): DownloadingItem => ({
  mediaType: MediaType.TV,
  externalId: 200,
  downloadId: `synthetic-${episodeNumber}`,
  title: 'Synthetic acquisition',
  size: 1000,
  sizeLeft: 570,
  status: 'downloading',
  trackedDownloadStatus: 'ok',
  trackedDownloadState: 'downloading',
  acquisitionPhase: AcquisitionPhase.DOWNLOADING,
  health: 'ok',
  timeLeft: '00:05:00',
  episode: {
    id: 100 + episodeNumber,
    seasonNumber: 1,
    episodeNumber,
    absoluteEpisodeNumber: episodeNumber,
  },
  ...overrides,
});
