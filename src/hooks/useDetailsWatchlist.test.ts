import { MediaType } from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDetailsWatchlistTarget,
  DetailsWatchlistMutationTracker,
  getDetailsWatchlistCacheKey,
  getDetailsWatchlistIdentity,
  parseDetailsRouteId,
  resolveDetailsWatchlistMembership,
  updateDetailsWatchlistMembership,
} from './useDetailsWatchlist';

describe('media details Watchlist state', () => {
  it('parses only positive integer route identities', () => {
    assert.equal(parseDetailsRouteId('42'), 42);
    assert.equal(parseDetailsRouteId('0'), undefined);
    assert.equal(parseDetailsRouteId('-1'), undefined);
    assert.equal(parseDetailsRouteId('1.5'), undefined);
    assert.equal(parseDetailsRouteId('1e3'), undefined);
    assert.equal(parseDetailsRouteId(['42']), undefined);
    assert.equal(parseDetailsRouteId(undefined), undefined);
  });

  it('scopes identities and SWR keys by user, media type, and TMDB ID', () => {
    const movie = {
      mediaType: MediaType.MOVIE as const,
      tmdbId: 42,
      userId: 7,
    };
    const sameIdSeries = { ...movie, mediaType: MediaType.TV as const };
    const otherMovie = { ...movie, tmdbId: 43 };
    const otherUser = { ...movie, userId: 8 };

    const identities = [movie, sameIdSeries, otherMovie, otherUser].map(
      getDetailsWatchlistIdentity
    );
    assert.equal(new Set(identities).size, identities.length);
    assert.deepEqual(getDetailsWatchlistCacheKey(movie), [
      '/api/v1/movie/42',
      '7:movie:42',
    ]);
    assert.deepEqual(getDetailsWatchlistCacheKey(sameIdSeries), [
      '/api/v1/tv/42',
      '7:tv:42',
    ]);
    assert.notDeepEqual(
      getDetailsWatchlistCacheKey(movie),
      getDetailsWatchlistCacheKey(otherUser)
    );
  });

  it('does not reuse authoritative membership from a previous details route', () => {
    const resolve = (
      routeTmdbId: number,
      authoritativeTmdbId: number,
      authoritativeMembership: boolean
    ) =>
      resolveDetailsWatchlistMembership({
        authoritativeMembership,
        authoritativeTmdbId,
        routeTmdbId,
      });

    assert.equal(resolve(100, 100, true), true);
    assert.equal(resolve(100, 100, false), false);
    assert.equal(resolve(101, 100, true), undefined);
    assert.equal(resolve(101, 100, false), undefined);
    assert.equal(
      resolveDetailsWatchlistMembership({
        authoritativeMembership: undefined,
        authoritativeTmdbId: 101,
        routeTmdbId: 101,
      }),
      undefined
    );

    // Back and Forward select only the response matching the active route.
    assert.equal(resolve(100, 100, true), true);
    assert.equal(resolve(101, 101, false), false);
    assert.equal(resolve(100, 100, true), true);
    assert.equal(resolve(101, 101, false), false);
  });

  it('covers Movie and Series transitions in both membership directions', () => {
    for (const mediaType of [MediaType.MOVIE, MediaType.TV] as const) {
      const first = createDetailsWatchlistTarget({
        mediaType,
        title: 'First',
        tmdbId: 100,
        userId: 7,
      });
      const second = createDetailsWatchlistTarget({
        mediaType,
        title: 'Second',
        tmdbId: 101,
        userId: 7,
      });
      assert.ok(first);
      assert.ok(second);
      assert.notEqual(first.identity, second.identity);

      // Watchlisted -> not watchlisted: old data is unknown on the new route.
      assert.equal(
        resolveDetailsWatchlistMembership({
          authoritativeMembership: true,
          authoritativeTmdbId: first.tmdbId,
          routeTmdbId: second.tmdbId,
        }),
        undefined
      );
      assert.equal(
        resolveDetailsWatchlistMembership({
          authoritativeMembership: false,
          authoritativeTmdbId: second.tmdbId,
          routeTmdbId: second.tmdbId,
        }),
        false
      );

      // Not watchlisted -> watchlisted follows the same identity boundary.
      assert.equal(
        resolveDetailsWatchlistMembership({
          authoritativeMembership: false,
          authoritativeTmdbId: second.tmdbId,
          routeTmdbId: first.tmdbId,
        }),
        undefined
      );
      assert.equal(
        resolveDetailsWatchlistMembership({
          authoritativeMembership: true,
          authoritativeTmdbId: first.tmdbId,
          routeTmdbId: first.tmdbId,
        }),
        true
      );
    }
  });

  it('builds typed add/delete targets for the media currently on screen', () => {
    const movie = createDetailsWatchlistTarget({
      mediaType: MediaType.MOVIE,
      title: 'Movie A',
      tmdbId: 123,
      userId: 7,
    });
    const series = createDetailsWatchlistTarget({
      mediaType: MediaType.TV,
      title: 'Series A',
      tmdbId: 123,
      userId: 7,
    });

    assert.deepEqual(movie, {
      cacheKey: ['/api/v1/movie/123', '7:movie:123'],
      deleteUrl: '/api/v1/watchlist/123?mediaType=movie',
      identity: '7:movie:123',
      mediaType: MediaType.MOVIE,
      tmdbId: 123,
      title: 'Movie A',
      userId: 7,
    });
    assert.deepEqual(series, {
      cacheKey: ['/api/v1/tv/123', '7:tv:123'],
      deleteUrl: '/api/v1/watchlist/123?mediaType=tv',
      identity: '7:tv:123',
      mediaType: MediaType.TV,
      tmdbId: 123,
      title: 'Series A',
      userId: 7,
    });
  });

  it('updates only the exact media cache selected by a mutation target', () => {
    const target = createDetailsWatchlistTarget({
      mediaType: MediaType.MOVIE,
      title: 'Movie A',
      tmdbId: 123,
      userId: 7,
    });
    assert.ok(target);

    const current = { id: 123, onUserWatchlist: false, title: 'Movie A' };
    assert.deepEqual(updateDetailsWatchlistMembership(current, target, true), {
      ...current,
      onUserWatchlist: true,
    });

    const differentMedia = {
      id: 124,
      onUserWatchlist: false,
      title: 'Movie B',
    };
    assert.equal(
      updateDetailsWatchlistMembership(differentMedia, target, true),
      differentMedia
    );
  });

  it('prevents old in-flight responses from applying to a new route', () => {
    const tracker = new DetailsWatchlistMutationTracker();
    const first = '7:movie:100';
    const second = '7:movie:101';

    tracker.setCurrentIdentity(first);
    const firstToken = tracker.begin(first);
    assert.ok(firstToken);
    assert.equal(tracker.isCurrent(first, firstToken), true);

    tracker.setCurrentIdentity(second);
    assert.equal(tracker.isCurrent(first, firstToken), false);
    const secondToken = tracker.begin(second);
    assert.ok(secondToken);
    assert.equal(tracker.isCurrent(second, secondToken), true);
    assert.equal(tracker.isPending(first), true);
    assert.equal(tracker.isPending(second), true);

    assert.equal(tracker.finish(first, firstToken), true);
    assert.equal(tracker.isCurrent(second, secondToken), true);
    assert.equal(tracker.isPending(second), true);
    assert.equal(tracker.finish(second, secondToken), true);
    assert.equal(tracker.isPending(second), false);
  });

  it('preserves typed identity through cross-type and back navigation', () => {
    const tracker = new DetailsWatchlistMutationTracker();
    const movie = '7:movie:55';
    const series = '7:tv:55';

    tracker.setCurrentIdentity(movie);
    const movieToken = tracker.begin(movie);
    assert.ok(movieToken);

    tracker.setCurrentIdentity(series);
    assert.equal(tracker.isCurrent(movie, movieToken), false);
    const seriesToken = tracker.begin(series);
    assert.ok(seriesToken);
    assert.equal(tracker.isCurrent(series, seriesToken), true);

    tracker.setCurrentIdentity(movie);
    assert.equal(tracker.isCurrent(movie, movieToken), true);
    assert.equal(tracker.isCurrent(series, seriesToken), false);
  });

  it('rejects duplicate mutations only for the same exact identity', () => {
    const tracker = new DetailsWatchlistMutationTracker();
    const movie = '7:movie:55';
    const otherUserMovie = '8:movie:55';

    tracker.setCurrentIdentity(movie);
    assert.ok(tracker.begin(movie));
    assert.equal(tracker.begin(movie), undefined);
    assert.ok(tracker.begin(otherUserMovie));
  });
});
