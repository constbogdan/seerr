import type { RemovalSettings } from '@server/constants/removal';

export const removalSettingsFingerprint = (settings: RemovalSettings) =>
  JSON.stringify(settings);

// RemovalScheduler.preview forces both policies enabled and only passes these
// policy fields to the eligibility planner. Job toggles and the grace period
// therefore must not invalidate an otherwise current preview.
export const removalPreviewFingerprint = (settings: RemovalSettings) =>
  JSON.stringify({
    movie: {
      minimumAgeMonths: settings.movie.minimumAgeMonths,
      inactivityMonths: settings.movie.inactivityMonths,
      itemsPerRun: settings.movie.itemsPerRun,
    },
    series: {
      minimumAgeMonths: settings.series.minimumAgeMonths,
      inactivityMonths: settings.series.inactivityMonths,
      itemsPerRun: settings.series.itemsPerRun,
    },
  });

export const removalSettingsEqual = (
  left: RemovalSettings,
  right: RemovalSettings
) => removalSettingsFingerprint(left) === removalSettingsFingerprint(right);

export type RemovalDraftReconciliation =
  | { type: 'unchanged' }
  | { type: 'initialize'; settings: RemovalSettings }
  | { type: 'adopt-remote'; settings: RemovalSettings }
  | { type: 'remote-conflict'; settings: RemovalSettings };

export const reconcileRemovalDraft = (
  remote: RemovalSettings,
  saved: RemovalSettings | null,
  draft: RemovalSettings | null
): RemovalDraftReconciliation => {
  if (!saved || !draft) return { type: 'initialize', settings: remote };
  if (removalSettingsEqual(remote, saved)) return { type: 'unchanged' };
  if (removalSettingsEqual(draft, saved)) {
    return { type: 'adopt-remote', settings: remote };
  }
  return { type: 'remote-conflict', settings: remote };
};

export interface RemovalPreviewIdentity<T> {
  fingerprint: string;
  value: T;
}

export interface RemovalPreviewPresentation<T> {
  value: T | null;
  current: boolean;
  refreshing: boolean;
  failed: boolean;
}

export const removalPreviewPresentation = <T>(
  preview: RemovalPreviewIdentity<T> | null,
  settings: RemovalSettings,
  previewingFingerprint: string | null,
  errorFingerprint: string | null
): RemovalPreviewPresentation<T> => {
  const fingerprint = removalPreviewFingerprint(settings);
  const current = preview?.fingerprint === fingerprint;
  const failed = errorFingerprint === fingerprint;
  return {
    value: preview?.value ?? null,
    current,
    refreshing: previewingFingerprint === fingerprint || (!current && !failed),
    failed,
  };
};

export const isCurrentRemovalPreviewRequest = (
  requestId: number,
  latestRequestId: number,
  requestFingerprint: string,
  currentSettings: RemovalSettings | null
) =>
  requestId === latestRequestId &&
  currentSettings !== null &&
  removalPreviewFingerprint(currentSettings) === requestFingerprint;
