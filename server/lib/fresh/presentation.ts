import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import logger from '@server/logger';
import axios from 'axios';

export const FRESH_PRESENTATION_CONCURRENCY = 4;

export type FreshProviderPresentation = TmdbMovieDetails | TmdbTvDetails;
export type FreshPresentationOutcome = {
  presentations: Map<string, FreshProviderPresentation>;
  permanentlyUnavailable: Set<string>;
};

// A short, bounded negative cache avoids retrying confirmed absent identities
// on every Fresh request without masking a later TMDb correction indefinitely.
export const FRESH_ABSENCE_TTL_MS = 60_000;
const FRESH_ABSENCE_MAX_ENTRIES = 256;
export class FreshPermanentAbsenceCache {
  private entries = new Map<string, number>();
  constructor(private now: () => number = Date.now) {}

  has(key: string): boolean {
    const expires = this.entries.get(key);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string): void {
    this.entries.delete(key);
    this.entries.set(key, this.now() + FRESH_ABSENCE_TTL_MS);
    while (this.entries.size > FRESH_ABSENCE_MAX_ENTRIES)
      this.entries.delete(this.entries.keys().next().value!);
  }
}

export interface FreshPresentationProvider {
  getMovie(input: {
    movieId: number;
    language?: string;
  }): Promise<TmdbMovieDetails>;
  getTvShow(input: { tvId: number; language?: string }): Promise<TmdbTvDetails>;
}

type FreshPresentationIdentity = { mediaType: 'movie' | 'tv'; tmdbId: number };
const identityKey = (item: FreshPresentationIdentity) =>
  `${item.mediaType}:${item.tmdbId}`;
const absenceCache = new FreshPermanentAbsenceCache();

/** Only a TMDb invalid/not-found 404 for this exact detail path is permanent. */
export const isFreshPermanentlyUnavailable = (
  error: unknown,
  item: FreshPresentationIdentity
): boolean => {
  let candidate = error;
  for (let depth = 0; depth < 4; depth++) {
    if (axios.isAxiosError(candidate)) {
      const data = candidate.response?.data as
        | { status_code?: unknown }
        | undefined;
      return (
        candidate.response?.status === 404 &&
        (data?.status_code === 6 || data?.status_code === 34) &&
        candidate.config?.url === `/${item.mediaType}/${item.tmdbId}`
      );
    }
    candidate = candidate instanceof Error ? candidate.cause : undefined;
    if (candidate === undefined) break;
  }
  return false;
};

/** Resolve one bounded Fresh batch with explicit, verified absence outcomes. */
export const resolveFreshPresentationOutcomes = async (
  page: FreshPresentationIdentity[],
  locale: string,
  provider?: FreshPresentationProvider,
  negatives: FreshPermanentAbsenceCache = absenceCache
): Promise<FreshPresentationOutcome> => {
  const identities = [
    ...new Map(page.map((item) => [identityKey(item), item])).values(),
  ];
  const presentations = new Map<string, FreshProviderPresentation>();
  const permanentlyUnavailable = new Set<string>();
  let metadataProvider = provider;
  if (!metadataProvider) {
    try {
      metadataProvider = new TheMovieDb();
    } catch (error) {
      logger.warn('Fresh presentation provider unavailable', {
        label: 'Fresh',
        errorType: error instanceof Error ? error.name : 'UnknownProviderError',
      });
      return { presentations, permanentlyUnavailable };
    }
  }
  let cursor = 0;
  await Promise.all(
    Array.from(
      {
        length: Math.min(FRESH_PRESENTATION_CONCURRENCY, identities.length),
      },
      async () => {
        while (cursor < identities.length) {
          const item = identities[cursor++];
          const key = identityKey(item);
          const negativeKey = `${locale}:${key}`;
          if (negatives.has(negativeKey)) {
            permanentlyUnavailable.add(key);
            continue;
          }
          try {
            presentations.set(
              key,
              item.mediaType === 'movie'
                ? await metadataProvider.getMovie({
                    movieId: item.tmdbId,
                    language: locale,
                  })
                : await metadataProvider.getTvShow({
                    tvId: item.tmdbId,
                    language: locale,
                  })
            );
          } catch (error) {
            const permanent = isFreshPermanentlyUnavailable(error, item);
            if (permanent) {
              negatives.add(negativeKey);
              permanentlyUnavailable.add(key);
            }
            logger.warn('Fresh presentation metadata unavailable', {
              label: 'Fresh',
              mediaType: item.mediaType,
              tmdbId: item.tmdbId,
              failureClass: permanent ? 'permanent_absence' : 'unavailable',
              errorType:
                error instanceof Error ? error.name : 'UnknownProviderError',
            });
          }
        }
      }
    )
  );
  return { presentations, permanentlyUnavailable };
};

/** Preserve the existing unfiltered-page fallback behavior and return shape. */
export const resolveFreshPagePresentation = async (
  page: FreshPresentationIdentity[],
  locale: string,
  provider?: FreshPresentationProvider
): Promise<Map<string, FreshProviderPresentation>> =>
  (await resolveFreshPresentationOutcomes(page, locale, provider))
    .presentations;

export const freshPresentationKey = identityKey;
