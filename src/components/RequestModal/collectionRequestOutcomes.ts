import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { Collection } from '@server/models/Collection';

export type CollectionRequestOutcomeKind =
  | 'requested'
  | 'already-requested'
  | 'failed';

export interface CollectionRequestOutcome {
  partId: number;
  title: string;
  kind: CollectionRequestOutcomeKind;
  retryable: boolean;
}

const rejectionStatus = (reason: unknown): number | undefined => {
  if (!reason || typeof reason !== 'object' || !('response' in reason)) {
    return undefined;
  }
  const response = reason.response;
  if (!response || typeof response !== 'object' || !('status' in response)) {
    return undefined;
  }
  return typeof response.status === 'number' ? response.status : undefined;
};

export const classifyCollectionRequestOutcomes = (
  parts: Collection['parts'],
  settled: PromiseSettledResult<unknown>[]
): CollectionRequestOutcome[] =>
  parts.map((part, index) => {
    const result = settled[index];
    const kind: CollectionRequestOutcomeKind =
      result?.status === 'fulfilled'
        ? 'requested'
        : rejectionStatus(result?.reason) === 409
          ? 'already-requested'
          : 'failed';
    return { partId: part.id, title: part.title, kind, retryable: false };
  });

export const isCollectionPartRequestable = (
  part: Collection['parts'][number],
  is4k: boolean
): boolean => {
  if (part.mediaInfo?.status === MediaStatus.BLOCKLISTED) return false;
  const status = part.mediaInfo?.[is4k ? 'status4k' : 'status'];
  if (
    status !== undefined &&
    status !== MediaStatus.UNKNOWN &&
    status !== MediaStatus.DELETED
  ) {
    return false;
  }
  return !(part.mediaInfo?.requests ?? []).some(
    (request) =>
      request.is4k === is4k &&
      request.status !== MediaRequestStatus.DECLINED &&
      request.status !== MediaRequestStatus.COMPLETED
  );
};

export const reconcileCollectionRequestRetryability = (
  outcomes: CollectionRequestOutcome[],
  refreshedParts: Collection['parts'] | undefined,
  is4k: boolean
): CollectionRequestOutcome[] =>
  outcomes.map((outcome) => ({
    ...outcome,
    retryable: Boolean(
      outcome.kind === 'failed' &&
      refreshedParts?.some(
        (part) =>
          part.id === outcome.partId && isCollectionPartRequestable(part, is4k)
      )
    ),
  }));
