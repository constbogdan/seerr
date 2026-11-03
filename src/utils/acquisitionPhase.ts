import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import defineMessages from './defineMessages';

export const acquisitionPhaseMessages = defineMessages(
  'i18n.acquisitionPhase',
  {
    waiting: 'Searching / Waiting',
    downloading: 'Downloading',
    processing: 'Processing',
    importPending: 'Import Pending',
    importing: 'Importing',
    importBlocked: 'Import Blocked',
    finalizing: 'Finalizing',
    paused: 'Paused',
    delayed: 'Delayed',
    warning: 'Warning',
    failed: 'Failed',
  }
);

export const getAcquisitionPhaseMessage = (phase: unknown) => {
  switch (phase) {
    case AcquisitionPhase.WAITING:
      return acquisitionPhaseMessages.waiting;
    case AcquisitionPhase.DOWNLOADING:
      return acquisitionPhaseMessages.downloading;
    case AcquisitionPhase.PROCESSING:
      return acquisitionPhaseMessages.processing;
    case AcquisitionPhase.IMPORT_PENDING:
      return acquisitionPhaseMessages.importPending;
    case AcquisitionPhase.IMPORTING:
      return acquisitionPhaseMessages.importing;
    case AcquisitionPhase.IMPORT_BLOCKED:
      return acquisitionPhaseMessages.importBlocked;
    case AcquisitionPhase.FINALIZING:
      return acquisitionPhaseMessages.finalizing;
    case AcquisitionPhase.PAUSED:
      return acquisitionPhaseMessages.paused;
    case AcquisitionPhase.DELAYED:
      return acquisitionPhaseMessages.delayed;
    case AcquisitionPhase.WARNING:
      return acquisitionPhaseMessages.warning;
    case AcquisitionPhase.FAILED:
      return acquisitionPhaseMessages.failed;
    default:
      return undefined;
  }
};

export const calculateDownloadProgress = (
  item: Pick<DownloadingItem, 'size' | 'sizeLeft'>
): number | undefined => {
  if (
    !Number.isFinite(item.size) ||
    !Number.isFinite(item.sizeLeft) ||
    item.size <= 0 ||
    item.sizeLeft < 0
  ) {
    return undefined;
  }
  return Math.max(
    0,
    Math.min(100, Math.round(((item.size - item.sizeLeft) / item.size) * 100))
  );
};

export const isDeterminateAcquisitionPhase = (phase: unknown): boolean =>
  ![
    AcquisitionPhase.PROCESSING,
    AcquisitionPhase.IMPORT_PENDING,
    AcquisitionPhase.IMPORTING,
    AcquisitionPhase.FINALIZING,
  ].includes(phase as AcquisitionPhase);

export const shouldShowDownloadEta = (
  item: Pick<DownloadingItem, 'acquisitionPhase' | 'estimatedCompletionTime'>
): boolean =>
  Boolean(item.estimatedCompletionTime) &&
  (!item.acquisitionPhase ||
    item.acquisitionPhase === AcquisitionPhase.DOWNLOADING);
