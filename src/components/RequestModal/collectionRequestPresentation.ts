const COLLECTION_BACKDROP_BASE =
  'https://image.tmdb.org/t/p/w1920_and_h800_multi_faces';

export const getCollectionBackdropUrl = (
  backdropPath: string | null | undefined
): string | undefined =>
  backdropPath
    ? `${COLLECTION_BACKDROP_BASE}${
        backdropPath.startsWith('/') ? '' : '/'
      }${backdropPath}`
    : undefined;
