import type { RemovalSettings } from '@server/constants/removal';

export const removalSettingsFingerprint = (settings: RemovalSettings) =>
  JSON.stringify(settings);

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

export const currentRemovalPreview = <T>(
  preview: RemovalPreviewIdentity<T> | null,
  settings: RemovalSettings
): T | null =>
  preview?.fingerprint === removalSettingsFingerprint(settings)
    ? preview.value
    : null;

export const isCurrentRemovalPreviewRequest = (
  requestId: number,
  latestRequestId: number,
  requestFingerprint: string,
  currentSettings: RemovalSettings | null
) =>
  requestId === latestRequestId &&
  currentSettings !== null &&
  removalSettingsFingerprint(currentSettings) === requestFingerprint;
