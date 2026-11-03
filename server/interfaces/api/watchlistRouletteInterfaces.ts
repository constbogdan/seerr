import type { MediaType } from '@server/constants/media';
import type {
  WatchlistRouletteRunSummary,
  WatchlistRouletteSettings,
} from '@server/constants/watchlistRoulette';

export interface WatchlistRouletteAdministrator {
  id: number;
  displayName: string;
}

export interface WatchlistRouletteSelection {
  requestId: number;
  mediaType: MediaType | null;
  tmdbId: number | null;
  title: string | null;
  year: number | null;
  seerrUrl: string | null;
  servarrUrl: string | null;
  unavailable: boolean;
}

export interface WatchlistRouletteLastRun {
  summary: WatchlistRouletteRunSummary;
  selections: WatchlistRouletteSelection[];
}

export interface WatchlistRouletteSettingsResponse {
  settings: WatchlistRouletteSettings;
  administrators: WatchlistRouletteAdministrator[];
  lastMovieRun: WatchlistRouletteLastRun | null;
  lastSeriesRun: WatchlistRouletteLastRun | null;
}

export interface WatchlistRouletteSettingsUpdate {
  requestOwnerUserId: number | null;
  movieItemsPerRun: number;
  seriesItemsPerRun: number;
}
