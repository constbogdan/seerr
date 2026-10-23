import type { MouseEvent } from 'react';

export const collectionMovieHref = (tmdbId: number): string =>
  `/movie/${tmdbId}`;

export const handleCollectionMovieNavigation = (
  event: Pick<MouseEvent<HTMLElement>, 'stopPropagation'>,
  closeModal?: () => void
): void => {
  event.stopPropagation();
  closeModal?.();
};
