import {
  FRESH_PRESENTATION_CONCURRENCY,
  resolveFreshPagePresentation,
} from '@server/lib/fresh/presentation';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Fresh page presentation', () => {
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
