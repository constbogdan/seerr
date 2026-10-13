import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbMovieDetails,
  TmdbTvDetails,
} from '@server/api/themoviedb/interfaces';
import type FreshMedia from '@server/entity/FreshMedia';
import logger from '@server/logger';

export const FRESH_PRESENTATION_CONCURRENCY = 4;

export type FreshProviderPresentation = TmdbMovieDetails | TmdbTvDetails;

export interface FreshPresentationProvider {
  getMovie(input: {
    movieId: number;
    language?: string;
  }): Promise<TmdbMovieDetails>;
  getTvShow(input: { tvId: number; language?: string }): Promise<TmdbTvDetails>;
}

const identityKey = (item: Pick<FreshMedia, 'mediaType' | 'tmdbId'>) =>
  `${item.mediaType}:${item.tmdbId}`;

/** Resolves only the already selected Fresh page through Seerr's TMDB cache. */
export const resolveFreshPagePresentation = async (
  page: Pick<FreshMedia, 'mediaType' | 'tmdbId'>[],
  locale: string,
  provider?: FreshPresentationProvider
): Promise<Map<string, FreshProviderPresentation>> => {
  const identities = [
    ...new Map(page.map((item) => [identityKey(item), item])).values(),
  ];
  const presentations = new Map<string, FreshProviderPresentation>();
  let metadataProvider = provider;
  if (!metadataProvider) {
    try {
      metadataProvider = new TheMovieDb();
    } catch (error) {
      logger.warn('Fresh presentation provider unavailable', {
        label: 'Fresh',
        errorType: error instanceof Error ? error.name : 'UnknownProviderError',
      });
      return presentations;
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
          try {
            presentations.set(
              identityKey(item),
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
            logger.warn('Fresh presentation metadata unavailable', {
              label: 'Fresh',
              mediaType: item.mediaType,
              tmdbId: item.tmdbId,
              errorType:
                error instanceof Error ? error.name : 'UnknownProviderError',
            });
          }
        }
      }
    )
  );
  return presentations;
};

export const freshPresentationKey = identityKey;
