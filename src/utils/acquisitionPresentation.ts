import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import {
  calculateDownloadProgress,
  isDeterminateAcquisitionPhase,
} from './acquisitionPhase';

const hasTransferEstimate = (item: DownloadingItem): boolean => {
  // Servarr TimeSpan, including day-prefixed values. A percentage alone says
  // nothing about activity; queued/stalled rows can retain downloaded bytes.
  const duration = item.timeLeft?.match(/^(?:(\d+)\.)?(\d+):(\d{2}):(\d{2})$/);
  if (!duration) return false;
  const [, days = '0', hours, minutes, seconds] = duration;
  const total =
    Number(days) * 86400 +
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds);
  return (
    Number.isSafeInteger(total) &&
    total > 0 &&
    Number(minutes) < 60 &&
    Number(seconds) < 60
  );
};

export const getDownloadPresentationPhase = (
  item: DownloadingItem
): AcquisitionPhase => {
  if (
    item.acquisitionPhase &&
    item.acquisitionPhase !== AcquisitionPhase.DOWNLOADING
  )
    return item.acquisitionPhase;
  if (item.status === 'paused') return AcquisitionPhase.PAUSED;
  if (item.status === 'delay') return AcquisitionPhase.DELAYED;
  if (
    item.status === 'failed' ||
    item.status === 'downloadClientUnavailable' ||
    item.health === 'error' ||
    item.trackedDownloadStatus === 'error' ||
    item.trackedStatus === 'error'
  )
    return AcquisitionPhase.FAILED;
  if (
    item.status === 'warning' ||
    item.health === 'warning' ||
    item.trackedDownloadStatus === 'warning' ||
    item.trackedStatus === 'warning'
  )
    return AcquisitionPhase.WARNING;
  if (
    item.status === 'downloading' &&
    item.trackedDownloadState === 'downloading' &&
    item.trackedDownloadStatus === 'ok' &&
    Number.isFinite(item.size) &&
    Number.isFinite(item.sizeLeft) &&
    item.size > 0 &&
    item.sizeLeft > 0 &&
    item.sizeLeft <= item.size &&
    hasTransferEstimate(item)
  )
    return AcquisitionPhase.DOWNLOADING;
  return AcquisitionPhase.WAITING;
};

// Transfer first, then local import/processing and Finalizing. Actionable
// blocked/warning states precede waiting, paused/delayed and incomplete evidence.
const priority = (item: DownloadingItem): number => {
  const phase = getDownloadPresentationPhase(item);
  switch (phase) {
    case AcquisitionPhase.DOWNLOADING:
      return 0;
    case AcquisitionPhase.IMPORTING:
      return 1;
    case AcquisitionPhase.PROCESSING:
    case AcquisitionPhase.IMPORT_PENDING:
      return 2;
    case AcquisitionPhase.FINALIZING:
      return 3;
    case AcquisitionPhase.IMPORT_BLOCKED:
    case AcquisitionPhase.FAILED:
    case AcquisitionPhase.WARNING:
      return 4;
    case AcquisitionPhase.WAITING:
      return item.status === 'queued' ? 5 : 7;
    default:
      return 6;
  }
};

const identity = (item: DownloadingItem): string =>
  JSON.stringify([
    item.mediaType,
    item.externalId,
    item.downloadId,
    item.episode?.seasonNumber,
    item.episode?.episodeNumber,
    item.episode?.id,
  ]);

export const selectRepresentativeDownload = (
  items: readonly DownloadingItem[]
): DownloadingItem | undefined => {
  let selected: DownloadingItem | undefined;
  let selectedPriority = Infinity;
  let selectedKey = '';
  for (const item of items) {
    const rank = priority(item);
    // Identity decides equivalent priorities, never provider array order. The
    // final payload key makes contradictory duplicate identities deterministic
    // too; byte values are NOT evidence of transfer activity.
    const key = `${identity(item)}:${JSON.stringify([
      item.status,
      item.acquisitionPhase,
      item.size,
      item.sizeLeft,
      item.timeLeft,
      item.title,
    ])}`;
    if (
      rank < selectedPriority ||
      (rank === selectedPriority && key < selectedKey)
    ) {
      selected = item;
      selectedPriority = rank;
      selectedKey = key;
    }
  }
  return selected;
};

export const getAcquisitionPresentation = (
  items: readonly DownloadingItem[]
) => {
  const item = selectRepresentativeDownload(items);
  const phase = item ? getDownloadPresentationPhase(item) : undefined;
  const determinate = isDeterminateAcquisitionPhase(phase);
  return {
    item,
    phase,
    determinate,
    progress: item && determinate ? calculateDownloadProgress(item) : undefined,
    seasonPack:
      !!item?.downloadId &&
      items.length > 1 &&
      items.every((entry) => entry.downloadId === item.downloadId),
  };
};
