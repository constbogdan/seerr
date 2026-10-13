export const invalidLeavingSoonPage = (
  currentPage: number,
  authoritativePages: number
): number | null => {
  const lastPage = Math.max(1, authoritativePages);
  return currentPage > lastPage ? lastPage : null;
};
