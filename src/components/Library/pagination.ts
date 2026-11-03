interface LibraryPaginationPresentationInput {
  requestedPage: number;
  responsePage?: number;
  isLoading: boolean;
  isValidating: boolean;
  hasError: boolean;
}

export type LibraryPaginationItem = number | 'start-ellipsis' | 'end-ellipsis';

const pageRange = (start: number, end: number) =>
  Array.from({ length: Math.max(0, end - start + 1) }, (_, index) =>
    Math.max(1, start + index)
  );

export const getLibraryPaginationItems = (
  currentPage: number,
  pageCount: number
): LibraryPaginationItem[] => {
  const totalPages = Math.max(1, Math.floor(pageCount));
  const current = Math.min(totalPages, Math.max(1, Math.floor(currentPage)));

  if (totalPages <= 7) return pageRange(1, totalPages);
  if (current <= 4) return [...pageRange(1, 5), 'end-ellipsis', totalPages];
  if (current >= totalPages - 3)
    return [1, 'start-ellipsis', ...pageRange(totalPages - 4, totalPages)];

  return [
    1,
    'start-ellipsis',
    current - 1,
    current,
    current + 1,
    'end-ellipsis',
    totalPages,
  ];
};

export const getLibraryNearbyPages = (
  currentPage: number,
  pageCount: number
) => {
  const totalPages = Math.max(1, Math.floor(pageCount));
  const current = Math.min(totalPages, Math.max(1, Math.floor(currentPage)));
  return pageRange(Math.max(1, current - 1), Math.min(totalPages, current + 1));
};

export const getLibraryPaginationPresentation = ({
  requestedPage,
  responsePage,
  isLoading,
  isValidating,
  hasError,
}: LibraryPaginationPresentationInput) => {
  const isRetainingPreviousPage =
    responsePage !== undefined && responsePage !== requestedPage;

  return {
    displayedPage: responsePage ?? requestedPage,
    isRetainingPreviousPage,
    isPagePending:
      isRetainingPreviousPage && !hasError && (isLoading || isValidating),
  };
};
