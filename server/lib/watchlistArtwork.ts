import TheMovieDb from '@server/api/themoviedb';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';

export const WATCHLIST_ARTWORK_CONCURRENCY = 3;
export const WATCHLIST_ARTWORK_TIMEOUT_MS = 3_000;

const key = (item: WatchlistItem) => `${item.mediaType}:${item.tmdbId}`;
const imagePath = (value: unknown): string | null =>
  typeof value === 'string' &&
  /^\/[a-z\d._/-]+$/i.test(value) &&
  !value.startsWith('//') &&
  !value.includes('..')
    ? value
    : null;

const releaseDate = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
};

export const enrichWatchlistArtwork = async (
  page: WatchlistResponse,
  tmdb: Pick<TheMovieDb, 'getWatchlistArtwork'> = new TheMovieDb(),
  timeoutMs = WATCHLIST_ARTWORK_TIMEOUT_MS
): Promise<WatchlistResponse> => {
  const pending = [
    ...new Map(page.results.map((item) => [key(item), item])).values(),
  ];
  const artwork = new Map<string, WatchlistItem['artwork']>();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, timeoutMs);
  });
  let cursor = 0;
  const worker = async () => {
    while (!controller.signal.aborted && cursor < pending.length) {
      const item = pending[cursor++];
      try {
        const metadata = await tmdb.getWatchlistArtwork(
          item.mediaType,
          item.tmdbId,
          controller.signal
        );
        if (!controller.signal.aborted && metadata?.id === item.tmdbId) {
          artwork.set(key(item), {
            posterPath: imagePath(metadata.poster_path),
            backdropPath: imagePath(metadata.backdrop_path),
            ...(item.mediaType === 'movie'
              ? { releaseDate: releaseDate(metadata.release_date) }
              : { firstAirDate: releaseDate(metadata.first_air_date) }),
          });
        }
      } catch {
        // Optional metadata never removes a saved row or changes its state.
      }
    }
  };
  try {
    await Promise.race([
      Promise.all(
        Array.from(
          { length: Math.min(WATCHLIST_ARTWORK_CONCURRENCY, pending.length) },
          worker
        )
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
  return {
    ...page,
    results: page.results.map((item) => ({
      ...item,
      artwork: artwork.get(key(item)) ?? null,
    })),
  };
};
