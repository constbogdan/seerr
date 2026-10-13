import type { RemovalSettings } from '@server/constants/removal';

export type RemovalPolicyKey = 'movie' | 'series';

export const newlyEnabledRemovalPolicies = (
  saved: RemovalSettings,
  proposed: RemovalSettings
): RemovalPolicyKey[] =>
  (['movie', 'series'] as const).filter(
    (key) => !saved[key].enabled && proposed[key].enabled
  );

export const revertNewlyEnabledRemovalPolicies = (
  proposed: RemovalSettings,
  keys: RemovalPolicyKey[]
): RemovalSettings =>
  keys.reduce(
    (settings, key) => ({
      ...settings,
      [key]: { ...settings[key], enabled: false },
    }),
    proposed
  );

interface RemovalPreviewBounds {
  movie: { maximumSelectableMonths: number };
  series: { maximumSelectableMonths: number };
}

export const normalizeRemovalThresholds = (
  settings: RemovalSettings,
  preview: RemovalPreviewBounds
): RemovalSettings => ({
  ...settings,
  movie: {
    ...settings.movie,
    minimumAgeMonths: Math.min(
      settings.movie.minimumAgeMonths,
      preview.movie.maximumSelectableMonths
    ),
    inactivityMonths: Math.min(
      settings.movie.inactivityMonths,
      preview.movie.maximumSelectableMonths
    ),
  },
  series: {
    ...settings.series,
    minimumAgeMonths: Math.min(
      settings.series.minimumAgeMonths,
      preview.series.maximumSelectableMonths
    ),
    inactivityMonths: Math.min(
      settings.series.inactivityMonths,
      preview.series.maximumSelectableMonths
    ),
  },
});
