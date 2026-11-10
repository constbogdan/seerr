import type Media from '@server/entity/Media';

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
  media?: Media | null;
  createdAt?: Date;
  updatedAt?: Date;
  artwork?: { posterPath: string | null; backdropPath: string | null } | null;
  watchState?: 'watched' | 'not_watched' | 'unknown';
  lastPlayedAt?: string;
  watchStateSyncedAt?: string;
  requestedBy?: {
    id: number;
    displayName: string;
    avatar: string;
  };
}

export interface WatchlistMembershipResponse {
  results: {
    mediaType: 'movie' | 'tv';
    tmdbId: number;
    onWatchlist: boolean;
  }[];
}

export interface WatchlistResponse {
  page: number;
  totalPages: number;
  totalResults: number;
  results: WatchlistItem[];
  source: 'local' | 'plex';
  supportsPresentation: boolean;
  supportsWatchState: boolean;
  supportsLibraryStatus: boolean;
  hasUnclassifiedItems: boolean;
}
