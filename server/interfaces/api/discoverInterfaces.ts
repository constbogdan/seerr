export interface GenreSliderItem {
  id: number;
  name: string;
  backdrops: string[];
}

export interface WatchlistItem {
  id: number;
  ratingKey: string;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  genreIds?: number[] | null;
}

export interface WatchlistResponse {
  page: number;
  totalPages: number;
  totalResults: number;
  results: WatchlistItem[];
  source: 'local' | 'plex';
  supportsPresentation: boolean;
  hasUnclassifiedItems: boolean;
}
