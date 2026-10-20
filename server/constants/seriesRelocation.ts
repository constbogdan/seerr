export enum SeriesRelocationState {
  CLAIMED = 'claimed',
  PROVIDER_IN_FLIGHT = 'provider_in_flight',
  VERIFYING = 'verifying',
  COMPLETED = 'completed',
  RECONCILIATION_REQUIRED = 'reconciliation_required',
}

export const ACTIVE_SERIES_RELOCATION_STATES = [
  SeriesRelocationState.CLAIMED,
  SeriesRelocationState.PROVIDER_IN_FLIGHT,
  SeriesRelocationState.VERIFYING,
  SeriesRelocationState.RECONCILIATION_REQUIRED,
] as const;

export type SeriesRelocationOutcome =
  | 'moved'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'needs_reconciliation';

export type SeriesRelocationReason =
  | 'eligible'
  | 'configuration-incomplete'
  | 'not-default-volume'
  | 'below-season-threshold'
  | 'already-relocating'
  | 'active-acquisition'
  | 'pending-request'
  | 'removal-conflict'
  | 'destination-capacity-unavailable'
  | 'insufficient-capacity'
  | 'root-resolution-failed'
  | 'foundation-mismatch'
  | 'incomplete-history'
  | 'unknown-download-client'
  | 'torrent-cooldown'
  | 'move-pending'
  | 'pre-provider-terminated'
  | 'provider-error'
  | 'verification-failed';
