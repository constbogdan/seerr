import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WATCHLIST_INITIAL_PAGE_COUNT,
  WATCHLIST_RETAINED_PAGE_LIMIT,
  getInitialWatchlistPageCount,
  getWatchlistQueryIdentity,
  retainWatchlistPageCount,
  retainWatchlistPreferences,
} from './navigationState';
import { defaultWatchlistPreferences } from './preferences';

describe('Watchlist navigation state', () => {
  it('uses a stable identity for the complete filtered query', () => {
    const first = getWatchlistQueryIdentity('/api/v1/discover/watchlist', {
      owner: 'me',
      category: 'movies',
      watched: 'watched',
      libraryStatus: 'active',
      sort: 'title_asc',
    });
    const reordered = getWatchlistQueryIdentity('/api/v1/discover/watchlist', {
      sort: 'title_asc',
      libraryStatus: 'active',
      watched: 'watched',
      category: 'movies',
      owner: 'me',
    });
    const differentFilter = getWatchlistQueryIdentity(
      '/api/v1/discover/watchlist',
      {
        owner: 'me',
        category: 'movies',
        watched: 'watched',
        libraryStatus: 'archived',
        sort: 'title_asc',
      }
    );

    assert.equal(first, reordered);
    assert.notEqual(first, differentFilter);
    assert.notEqual(
      first,
      getWatchlistQueryIdentity('/api/v1/user/7/watchlist', {
        owner: 'me',
        category: 'movies',
        watched: 'watched',
        libraryStatus: 'active',
        sort: 'title_asc',
      })
    );
  });

  it('restores deep page counts with bounded retention', () => {
    assert.equal(getInitialWatchlistPageCount(), WATCHLIST_INITIAL_PAGE_COUNT);
    assert.equal(getInitialWatchlistPageCount(8), 8);
    assert.equal(
      getInitialWatchlistPageCount(WATCHLIST_RETAINED_PAGE_LIMIT + 10),
      WATCHLIST_RETAINED_PAGE_LIMIT
    );

    const retained = new Map<string, number>();
    retainWatchlistPageCount(retained, 'first', 7, 2);
    retainWatchlistPageCount(retained, 'second', 5, 2);
    retainWatchlistPageCount(retained, 'third', 4, 2);

    assert.equal(retained.has('first'), false);
    assert.equal(retained.get('second'), 5);
    assert.equal(retained.get('third'), 4);
  });

  it('keeps retained preferences isolated and bounded by page scope', () => {
    const retained = new Map();
    retainWatchlistPreferences(
      retained,
      'user-1',
      defaultWatchlistPreferences,
      1
    );
    retainWatchlistPreferences(
      retained,
      'user-2',
      { ...defaultWatchlistPreferences, owner: 'all' },
      1
    );

    assert.equal(retained.has('user-1'), false);
    assert.equal(retained.get('user-2')?.owner, 'all');
    assert.notEqual(retained.get('user-2'), defaultWatchlistPreferences);
  });
});
