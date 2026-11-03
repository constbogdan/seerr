import type { SonarrSettings } from '@server/lib/settings';

type PersistedSonarrSeriesTypes = Partial<
  Pick<SonarrSettings, 'seriesType' | 'animeSeriesType'>
>;

export const sonarrSeriesTypeInitialValues = (
  sonarr: PersistedSonarrSeriesTypes | null
): Pick<SonarrSettings, 'seriesType' | 'animeSeriesType'> => ({
  seriesType: sonarr?.seriesType ?? 'standard',
  animeSeriesType: sonarr?.animeSeriesType ?? 'anime',
});
