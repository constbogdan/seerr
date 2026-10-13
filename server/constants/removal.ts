export enum RemovalTargetType {
  MOVIE = 'movie',
  SERIES = 'series',
  SEASON = 'season',
}

export enum RemovalScheduleOrigin {
  MANUAL = 'manual',
  AUTOMATIC = 'automatic',
}

export enum RemovalScheduleStatus {
  ACTIVE = 'active',
  DEFERRED = 'deferred',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export enum RemovalExecutionInitiator {
  MANUAL = 'manual',
  BULK = 'bulk',
  SCHEDULED = 'scheduled',
}

export enum RemovalExecutionState {
  CLAIMED = 'claimed',
  PROVIDER_IN_FLIGHT = 'provider_in_flight',
  PROVIDER_ACKNOWLEDGED = 'provider_acknowledged',
  PROVIDER_ABSENT = 'provider_absent',
  RECONCILIATION_REQUIRED = 'reconciliation_required',
  UNCERTAIN = 'uncertain',
  COMPLETED = 'completed',
  FAILED_PRE_PROVIDER = 'failed_pre_provider',
  FAILED_PROVIDER = 'failed_provider',
  CANCELLED_PRE_PROVIDER = 'cancelled_pre_provider',
  ABANDONED_PRE_PROVIDER = 'abandoned_pre_provider',
}

export enum RemovalExecutionPhase {
  PRE_PROVIDER = 'pre_provider',
  PROVIDER = 'provider',
  RECONCILIATION = 'reconciliation',
  UNCERTAIN = 'uncertain',
}

export type RemovalProviderOutcome = 'acknowledged' | 'absent';

export interface AutomaticRemovalPolicy {
  enabled: boolean;
  minimumAgeMonths: number;
  inactivityMonths: number;
  itemsPerRun: number;
}

export interface RemovalSettings {
  removalDelayDays: number;
  removalScanEnabled: boolean;
  removalProcessingEnabled: boolean;
  movie: AutomaticRemovalPolicy;
  series: AutomaticRemovalPolicy;
}

export const DEFAULT_REMOVAL_SETTINGS: RemovalSettings = {
  removalDelayDays: 60,
  removalScanEnabled: false,
  removalProcessingEnabled: false,
  movie: {
    enabled: false,
    minimumAgeMonths: 3,
    inactivityMonths: 1,
    itemsPerRun: 10,
  },
  series: {
    enabled: false,
    minimumAgeMonths: 3,
    inactivityMonths: 1,
    itemsPerRun: 10,
  },
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const integer = (value: unknown, fallback: number) =>
  Number.isInteger(value) ? Number(value) : fallback;

const boolean = (value: unknown, fallback: boolean) =>
  typeof value === 'boolean' ? value : fallback;

const REMOVAL_DELAY_OPTIONS = [10, 20, 30, 60, 90] as const;

const removalDelay = (value: unknown) =>
  REMOVAL_DELAY_OPTIONS.includes(
    value as (typeof REMOVAL_DELAY_OPTIONS)[number]
  )
    ? Number(value)
    : DEFAULT_REMOVAL_SETTINGS.removalDelayDays;

const normalizePolicy = (
  value: unknown,
  defaults: AutomaticRemovalPolicy
): AutomaticRemovalPolicy => {
  const source = record(value);
  return {
    enabled: boolean(source.enabled, defaults.enabled),
    minimumAgeMonths: integer(
      source.minimumAgeMonths,
      defaults.minimumAgeMonths
    ),
    inactivityMonths: integer(
      source.inactivityMonths,
      defaults.inactivityMonths
    ),
    itemsPerRun: integer(source.itemsPerRun, defaults.itemsPerRun),
  };
};

/**
 * Normalize loaded JSON to the final released contract instead of retaining
 * unknown settings from unreleased development versions.
 */
export const normalizeRemovalSettings = (value: unknown): RemovalSettings => {
  const source = record(value);
  return {
    removalDelayDays: removalDelay(source.removalDelayDays),
    removalScanEnabled: boolean(
      source.removalScanEnabled,
      DEFAULT_REMOVAL_SETTINGS.removalScanEnabled
    ),
    removalProcessingEnabled: boolean(
      source.removalProcessingEnabled,
      DEFAULT_REMOVAL_SETTINGS.removalProcessingEnabled
    ),
    movie: normalizePolicy(source.movie, DEFAULT_REMOVAL_SETTINGS.movie),
    series: normalizePolicy(source.series, DEFAULT_REMOVAL_SETTINGS.series),
  };
};

export const isActiveRemovalStatus = (status: RemovalScheduleStatus) =>
  status === RemovalScheduleStatus.ACTIVE ||
  status === RemovalScheduleStatus.DEFERRED;
