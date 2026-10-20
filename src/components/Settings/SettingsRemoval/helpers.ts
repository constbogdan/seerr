import type { RemovalSettings } from '@server/constants/removal';

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
