/** Fresh's two supported cross-media categories; unknown is never false. */
export interface FreshClassification {
  isAnimation: boolean | null;
  isDocumentary: boolean | null;
}

export const classifyFreshGenres = (genres: unknown): FreshClassification => {
  if (
    !Array.isArray(genres) ||
    genres.some(
      (genre) =>
        !genre ||
        typeof genre !== 'object' ||
        !Number.isSafeInteger(genre.id) ||
        genre.id <= 0
    )
  )
    return { isAnimation: null, isDocumentary: null };
  return {
    isAnimation: genres.some((genre) => genre.id === 16),
    isDocumentary: genres.some((genre) => genre.id === 99),
  };
};

export const freshTitleAnchor = (mediaType: 'movie' | 'tv') =>
  mediaType === 'movie' ? 'movie' : 'series';
