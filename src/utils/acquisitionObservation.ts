import type { DownloadingItem } from '@server/lib/downloadtracker';
import {
  acquisitionObservationKey,
  isTransferCandidate,
} from './acquisitionPresentation';

// Matches the maximum visible Servarr queue. Retain only the latest sample,
// never a history of downloads, routes or users.
export const MAX_ACQUISITION_OBSERVATIONS = 1000;

export interface AcquisitionObservation {
  scope: string;
  sample: object;
  validating: boolean;
  remaining: ReadonlyMap<string, number>;
  advancing: ReadonlySet<string>;
}

export const observeAcquisitionDownloads = (
  items: readonly DownloadingItem[],
  scope: string,
  sample: object,
  validating: boolean,
  previous?: AcquisitionObservation
): AcquisitionObservation => {
  const prior = previous?.scope === scope ? previous : undefined;
  if (prior?.sample === sample && prior.validating === validating) return prior;

  // A validation starting is not a new provider observation. Completion is,
  // even when SWR structurally deduplicates an unchanged response object.
  if (validating)
    return {
      scope,
      sample,
      validating,
      remaining: prior?.remaining ?? new Map(),
      advancing: prior?.advancing ?? new Set(),
    };

  const remaining = new Map<string, number>();
  const advancing = new Set<string>();
  for (const item of items.slice(0, MAX_ACQUISITION_OBSERVATIONS)) {
    if (!isTransferCandidate(item) || !item.downloadId) continue;
    const key = acquisitionObservationKey(item);
    const before = prior?.remaining.get(key);
    remaining.set(key, item.sizeLeft);
    if (before !== undefined && item.sizeLeft < before) advancing.add(key);
  }
  return { scope, sample, validating, remaining, advancing };
};
