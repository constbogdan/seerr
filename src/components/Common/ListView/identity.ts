import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import type {
  CollectionResult,
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';

type SearchResult = TvResult | MovieResult | PersonResult | CollectionResult;

export const watchlistOccurrenceKey = (
  item: WatchlistItem,
  fallbackPosition: number
): string => {
  const owner = item.requestedBy?.id;
  if (Number.isSafeInteger(item.id) && item.id > 0) {
    return `watchlist-${owner ?? 'plex'}-${item.id}`;
  }
  if (item.ratingKey) {
    return `watchlist-${owner ?? 'plex'}-${item.ratingKey}`;
  }
  return `watchlist-fallback-${item.mediaType}-${item.tmdbId}-${fallbackPosition}`;
};

export const searchResultOccurrenceKey = (
  item: SearchResult,
  fallbackPosition: number
): string =>
  Number.isSafeInteger(item.id)
    ? `${item.mediaType}-${item.id}`
    : `search-fallback-${item.mediaType}-${fallbackPosition}`;
