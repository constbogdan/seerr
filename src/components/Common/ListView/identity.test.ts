import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import type { MovieResult } from '@server/models/Search';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { searchResultOccurrenceKey, watchlistOccurrenceKey } from './identity';

describe('ListView occurrence identities', () => {
  it('keeps duplicate titles distinct by durable Watchlist occurrence and owner', () => {
    const first = {
      id: 11,
      ratingKey: 'same-title',
      tmdbId: 99,
      mediaType: 'movie',
      title: 'Duplicate',
      requestedBy: { id: 1, displayName: 'One', avatar: '' },
    } satisfies WatchlistItem;
    const second = {
      ...first,
      id: 12,
      requestedBy: { id: 2, displayName: 'Two', avatar: '' },
    } satisfies WatchlistItem;

    assert.equal(watchlistOccurrenceKey(first, 0), 'watchlist-1-11');
    assert.equal(watchlistOccurrenceKey(second, 1), 'watchlist-2-12');
    assert.equal(watchlistOccurrenceKey(first, 25), 'watchlist-1-11');
  });

  it('uses typed media identity for ordinary results without their position', () => {
    const movie = {
      id: 42,
      mediaType: 'movie',
    } as MovieResult;
    assert.equal(searchResultOccurrenceKey(movie, 0), 'movie-42');
    assert.equal(searchResultOccurrenceKey(movie, 9), 'movie-42');
  });

  it('retains a positional fallback only when no durable identity exists', () => {
    const item = {
      id: Number.NaN,
      ratingKey: '',
      tmdbId: 9,
      mediaType: 'tv',
      title: 'Legacy',
    } as WatchlistItem;
    assert.equal(watchlistOccurrenceKey(item, 3), 'watchlist-fallback-tv-9-3');
  });
});
