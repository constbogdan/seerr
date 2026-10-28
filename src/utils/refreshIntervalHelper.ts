import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';

interface MediaAcquisitionSnapshot {
  downloadStatus?: DownloadingItem[];
  downloadStatus4k?: DownloadingItem[];
  status?: MediaStatus;
  status4k?: MediaStatus;
  seasons?: {
    seasonNumber: number;
    status: MediaStatus;
    status4k: MediaStatus;
  }[];
  requests?: RequestAcquisitionScope[];
}

interface RequestAcquisitionScope {
  status: MediaRequestStatus;
  is4k: boolean;
  type: string;
  seasons?: { seasonNumber: number; status: MediaRequestStatus }[];
}

const hasUnfinishedScope = (
  media: MediaAcquisitionSnapshot,
  request: RequestAcquisitionScope
): boolean => {
  const quality = request.is4k ? 'status4k' : 'status';
  if (
    [
      MediaStatus.AVAILABLE,
      MediaStatus.DELETED,
      MediaStatus.BLOCKLISTED,
    ].includes(media[quality] as MediaStatus)
  )
    return false;
  const seasons = request.type === 'tv' ? (request.seasons ?? []) : [];
  if (
    seasons.length &&
    seasons.every(
      (season) =>
        season.status === MediaRequestStatus.COMPLETED ||
        media.seasons?.some(
          (known) =>
            known.seasonNumber === season.seasonNumber &&
            known[quality] === MediaStatus.AVAILABLE
        )
    )
  )
    return false;
  return true;
};

// These functions consume a single authoritative SWR response. Callers pass
// parent fallback data only while SWR has no current response for that key.
export const getRequestRefreshInterval = (
  request:
    | (RequestAcquisitionScope & { media: MediaAcquisitionSnapshot })
    | undefined,
  timer: number
): number => {
  if (!request) return 0;
  const downloads = getRequestDownloadStatus(
    request.media[request.is4k ? 'downloadStatus4k' : 'downloadStatus'],
    request.type === 'tv'
      ? (request.seasons ?? []).map((season) => season.seasonNumber)
      : []
  );
  if (downloads.length) return timer;
  return request.status === MediaRequestStatus.APPROVED &&
    hasUnfinishedScope(request.media, request)
    ? timer
    : 0;
};

export const getMediaRefreshInterval = (
  media: MediaAcquisitionSnapshot | undefined,
  timer: number
): number => {
  if (!media) return 0;
  if (
    refreshIntervalHelper(
      {
        downloadStatus: media.downloadStatus,
        downloadStatus4k: media.downloadStatus4k,
      },
      timer
    ) ||
    media.status === MediaStatus.PROCESSING ||
    media.status4k === MediaStatus.PROCESSING ||
    media.requests?.some(
      (request) =>
        request.status === MediaRequestStatus.APPROVED &&
        hasUnfinishedScope(media, request)
    )
  )
    return timer;
  return 0;
};

export const getRequestDownloadStatus = (
  downloadStatus: DownloadingItem[] | undefined,
  seasonNumbers: number[]
): DownloadingItem[] => {
  const items = downloadStatus ?? [];

  if (!seasonNumbers.length) {
    return items;
  }

  return items.filter(
    (item) => item.episode && seasonNumbers.includes(item.episode.seasonNumber)
  );
};

export const refreshIntervalHelper = (
  downloadItem: {
    downloadStatus: DownloadingItem[] | undefined;
    downloadStatus4k: DownloadingItem[] | undefined;
  },
  timer: number
) => {
  if (
    (downloadItem.downloadStatus ?? []).length > 0 ||
    (downloadItem.downloadStatus4k ?? []).length > 0
  ) {
    return timer;
  } else {
    return 0;
  }
};
