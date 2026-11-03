import type {
  ServarrQueueStatus,
  ServarrStatusMessage,
  ServarrTrackedDownloadState,
  ServarrTrackedDownloadStatus,
} from '@server/api/servarr/base';

export enum AcquisitionPhase {
  WAITING = 'waiting',
  DOWNLOADING = 'downloading',
  PROCESSING = 'processing',
  IMPORT_PENDING = 'importPending',
  IMPORTING = 'importing',
  IMPORT_BLOCKED = 'importBlocked',
  FINALIZING = 'finalizing',
  PAUSED = 'paused',
  DELAYED = 'delayed',
  WARNING = 'warning',
  FAILED = 'failed',
}

export enum AcquisitionSafeReason {
  INSUFFICIENT_SPACE = 'insufficient_space',
  DOWNLOAD_CLIENT_UNAVAILABLE = 'download_client_unavailable',
  IMPORT_BLOCKED = 'import_blocked',
  IMPORT_FAILED = 'import_failed',
  DELAYED = 'delayed',
  PAUSED = 'paused',
  UNKNOWN_ERROR = 'unknown_error',
}

export type AcquisitionHealth = 'ok' | 'warning' | 'error';

export interface AcquisitionPhaseInput {
  status: ServarrQueueStatus;
  trackedDownloadStatus: ServarrTrackedDownloadStatus;
  trackedDownloadState: ServarrTrackedDownloadState;
  sizeLeft: number;
  statusMessages?: ServarrStatusMessage[];
  errorMessage?: string;
}

export interface DerivedAcquisitionState {
  acquisitionPhase: AcquisitionPhase;
  safeReason?: AcquisitionSafeReason;
  health: AcquisitionHealth;
}

const insufficientSpacePattern =
  /(?:not enough|insufficient|no)\s+(?:free\s+)?(?:disk\s+)?space|disk\s+(?:is\s+)?full/i;

const hasInsufficientSpaceMessage = ({
  statusMessages = [],
  errorMessage,
}: Pick<AcquisitionPhaseInput, 'statusMessages' | 'errorMessage'>): boolean =>
  [
    errorMessage,
    ...statusMessages.flatMap((message) => [
      message.title,
      ...(Array.isArray(message.messages) ? message.messages : []),
    ]),
  ].some((message) =>
    typeof message === 'string' ? insufficientSpacePattern.test(message) : false
  );

export const deriveAcquisitionState = (
  input: AcquisitionPhaseInput
): DerivedAcquisitionState => {
  const insufficientSpace = hasInsufficientSpaceMessage(input);

  if (input.trackedDownloadState === 'importBlocked') {
    return {
      acquisitionPhase: AcquisitionPhase.IMPORT_BLOCKED,
      health: 'error',
      safeReason: insufficientSpace
        ? AcquisitionSafeReason.INSUFFICIENT_SPACE
        : AcquisitionSafeReason.IMPORT_BLOCKED,
    };
  }

  if (
    input.trackedDownloadState === 'failed' ||
    input.trackedDownloadState === 'failedPending'
  ) {
    return {
      acquisitionPhase: AcquisitionPhase.FAILED,
      health: 'error',
      safeReason: AcquisitionSafeReason.IMPORT_FAILED,
    };
  }

  if (input.status === 'downloadClientUnavailable') {
    return {
      acquisitionPhase: AcquisitionPhase.FAILED,
      health: 'error',
      safeReason: AcquisitionSafeReason.DOWNLOAD_CLIENT_UNAVAILABLE,
    };
  }

  if (input.status === 'failed' || input.trackedDownloadStatus === 'error') {
    return {
      acquisitionPhase: AcquisitionPhase.FAILED,
      health: 'error',
      safeReason: insufficientSpace
        ? AcquisitionSafeReason.INSUFFICIENT_SPACE
        : AcquisitionSafeReason.UNKNOWN_ERROR,
    };
  }

  if (input.trackedDownloadState === 'importing') {
    return { acquisitionPhase: AcquisitionPhase.IMPORTING, health: 'ok' };
  }

  if (input.trackedDownloadState === 'importPending') {
    return { acquisitionPhase: AcquisitionPhase.IMPORT_PENDING, health: 'ok' };
  }

  if (input.trackedDownloadState === 'imported') {
    return { acquisitionPhase: AcquisitionPhase.FINALIZING, health: 'ok' };
  }

  if (input.status === 'paused') {
    return {
      acquisitionPhase: AcquisitionPhase.PAUSED,
      health: 'warning',
      safeReason: AcquisitionSafeReason.PAUSED,
    };
  }

  if (input.status === 'delay') {
    return {
      acquisitionPhase: AcquisitionPhase.DELAYED,
      health: 'warning',
      safeReason: AcquisitionSafeReason.DELAYED,
    };
  }

  if (input.status === 'warning' || input.trackedDownloadStatus === 'warning') {
    return {
      acquisitionPhase: AcquisitionPhase.WARNING,
      health: 'warning',
      safeReason: insufficientSpace
        ? AcquisitionSafeReason.INSUFFICIENT_SPACE
        : AcquisitionSafeReason.UNKNOWN_ERROR,
    };
  }

  if (
    input.sizeLeft > 0 &&
    (input.status === 'downloading' ||
      input.trackedDownloadState === 'downloading')
  ) {
    return { acquisitionPhase: AcquisitionPhase.DOWNLOADING, health: 'ok' };
  }

  if (
    input.sizeLeft <= 0 &&
    (input.status === 'downloading' ||
      input.status === 'completed' ||
      input.trackedDownloadState === 'downloading')
  ) {
    return { acquisitionPhase: AcquisitionPhase.PROCESSING, health: 'ok' };
  }

  return { acquisitionPhase: AcquisitionPhase.WAITING, health: 'ok' };
};
