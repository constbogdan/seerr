import TheMovieDb from '@server/api/themoviedb';
import {
  FRESH_ABSENCE_TTL_MS,
  FRESH_PRESENTATION_CONCURRENCY,
  FreshPermanentAbsenceCache,
  isFreshPermanentlyUnavailable,
  resolveFreshPagePresentation,
  resolveFreshPresentationOutcomes,
} from '@server/lib/fresh/presentation';
import {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Fresh page presentation', () => {
  const tmdbFailure = (status: number, code: number, url: string) => {
    const config = { url, headers: {} } as InternalAxiosRequestConfig;
    const response = {
      status,
      statusText: 'fixture',
      data: { status_code: code },
      headers: {},
      config,
    } as AxiosResponse;
    return new Error('TMDb detail failed', {
      cause: new AxiosError('fixture', undefined, config, undefined, response),
    });
  };

  it('recognizes only TMDb invalid/not-found 404s for the exact typed detail path', () => {
    const movie = { mediaType: 'movie' as const, tmdbId: 1828781 };
    for (const code of [6, 34])
      assert.equal(
        isFreshPermanentlyUnavailable(
          tmdbFailure(404, code, '/movie/1828781'),
          movie
        ),
        true
      );
    for (const [status, code, url] of [
      [401, 6, '/movie/1828781'],
      [429, 34, '/movie/1828781'],
      [500, 34, '/movie/1828781'],
      [503, 34, '/movie/1828781'],
      [404, 99, '/movie/1828781'],
      [404, 34, '/movie/999'],
      [404, 34, '/tv/1828781'],
    ] as const)
      assert.equal(
        isFreshPermanentlyUnavailable(tmdbFailure(status, code, url), movie),
        false
      );
    assert.equal(
      isFreshPermanentlyUnavailable(new Error('timeout'), movie),
      false
    );
    assert.equal(
      isFreshPermanentlyUnavailable(tmdbFailure(404, 34, '/movie/1828781'), {
        mediaType: 'tv',
        tmdbId: 1828781,
      }),
      false
    );
  });

  it('retains the 404 classification through the real getMovie error wrapper', async () => {
    const client = new TheMovieDb();
    const detailError = tmdbFailure(404, 34, '/movie/1828781');
    (client as unknown as { get: () => Promise<never> }).get = async () => {
      throw detailError.cause;
    };
    await assert.rejects(client.getMovie({ movieId: 1828781 }), (error) =>
      isFreshPermanentlyUnavailable(error, {
        mediaType: 'movie',
        tmdbId: 1828781,
      })
    );
  });

  it('negatively caches only confirmed absence with bounded expiry and typed locale keys', async () => {
    let now = 0;
    let calls = 0;
    let absent = true;
    const negatives = new FreshPermanentAbsenceCache(() => now);
    const movie = { mediaType: 'movie' as const, tmdbId: 1828781 };
    const provider = {
      getMovie: async () => {
        calls++;
        if (absent) throw tmdbFailure(404, 34, '/movie/1828781');
        return { id: 1828781, vote_average: 8 } as never;
      },
      getTvShow: async () => ({ id: 1828781 }) as never,
    };
    const first = await resolveFreshPresentationOutcomes(
      [movie],
      'en',
      provider,
      negatives
    );
    assert.deepEqual([...first.permanentlyUnavailable], ['movie:1828781']);
    assert.equal(first.presentations.size, 0);
    await resolveFreshPresentationOutcomes([movie], 'en', provider, negatives);
    assert.equal(calls, 1, 'confirmed absence is not refetched while cached');
    absent = false;
    const otherLocale = await resolveFreshPresentationOutcomes(
      [movie],
      'fr',
      provider,
      negatives
    );
    assert.equal(otherLocale.presentations.get('movie:1828781')?.id, 1828781);
    assert.equal(calls, 2, 'locale must not inherit a negative lookup');
    now = FRESH_ABSENCE_TTL_MS;
    const recovered = await resolveFreshPresentationOutcomes(
      [movie],
      'en',
      provider,
      negatives
    );
    assert.equal(recovered.permanentlyUnavailable.size, 0);
    assert.equal(recovered.presentations.get('movie:1828781')?.id, 1828781);
    assert.equal(calls, 3);
    for (let index = 0; index <= 256; index++)
      negatives.add(`en:movie:${index}`);
    assert.equal(negatives.has('en:movie:0'), false);
    assert.equal(negatives.has('en:movie:256'), true);
  });

  it('does not negatively cache transient failures or convert mismatched IDs into absence', async () => {
    let calls = 0;
    const negatives = new FreshPermanentAbsenceCache();
    const movie = { mediaType: 'movie' as const, tmdbId: 1828781 };
    const provider = {
      getMovie: async () => {
        calls++;
        throw tmdbFailure(429, 25, '/movie/1828781');
      },
      getTvShow: async () => ({ id: 1828781 }) as never,
    };
    for (let i = 0; i < 2; i++) {
      const result = await resolveFreshPresentationOutcomes(
        [movie],
        'en',
        provider,
        negatives
      );
      assert.equal(result.permanentlyUnavailable.size, 0);
      assert.equal(result.presentations.size, 0);
    }
    assert.equal(calls, 2);
    const mismatched = await resolveFreshPresentationOutcomes(
      [movie],
      'en',
      {
        ...provider,
        getMovie: async () => ({ id: 999 }) as never,
      },
      negatives
    );
    assert.equal(mismatched.permanentlyUnavailable.size, 0);
    assert.equal(mismatched.presentations.get('movie:1828781')?.id, 999);
  });
  it('deduplicates and bounds selected-page provider resolution', async () => {
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const provider = {
      getMovie: async ({ movieId }: { movieId: number }) => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return { id: movieId, title: `Movie ${movieId}` } as never;
      },
      getTvShow: async ({ tvId }: { tvId: number }) => {
        calls++;
        return { id: tvId, name: `Series ${tvId}` } as never;
      },
    };
    const selected = Array.from({ length: 20 }, (_, index) => ({
      mediaType: 'movie' as const,
      tmdbId: index + 1,
    }));
    selected.push(selected[0]);
    const result = await resolveFreshPagePresentation(selected, 'en', provider);
    assert.equal(result.size, 20);
    assert.equal(calls, 20);
    assert.ok(maximum <= FRESH_PRESENTATION_CONCURRENCY);
  });

  it('keeps the domain item when one provider lookup fails', async () => {
    const result = await resolveFreshPagePresentation(
      [{ mediaType: 'movie', tmdbId: 1 }],
      'en',
      {
        getMovie: async () => {
          throw new TypeError('fixture failure');
        },
        getTvShow: async () => {
          throw new TypeError('fixture failure');
        },
      }
    );
    assert.equal(result.size, 0);
  });
});
