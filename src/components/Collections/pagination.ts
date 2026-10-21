import type {
  LibraryCollectionItem,
  LibraryCollectionsResponse,
} from '@server/interfaces/api/libraryInterfaces';
import type { CollectionsQueryState } from './query';

export const COLLECTIONS_PAGE_SIZE = 20;

export const collectionsQueryIdentity = (
  state: CollectionsQueryState
): string =>
  new URLSearchParams({
    completeness: state.completeness,
    sort: state.sort,
    sortDirection: state.sortDirection,
  }).toString();

export const collectionsPageUrl = (
  state: CollectionsQueryState,
  pageIndex: number,
  previousPage: LibraryCollectionsResponse | null
): string | null => {
  if (
    previousPage &&
    (previousPage.pageInfo.pages === 0 ||
      previousPage.pageInfo.page >= previousPage.pageInfo.pages)
  ) {
    return null;
  }

  return `/api/v1/library/collections?${new URLSearchParams({
    take: String(COLLECTIONS_PAGE_SIZE),
    skip: String(pageIndex * COLLECTIONS_PAGE_SIZE),
    completeness: state.completeness,
    sort: state.sort,
    sortDirection: state.sortDirection,
  }).toString()}`;
};

export const mergeCollectionPages = (
  pages: LibraryCollectionsResponse[] | undefined
): LibraryCollectionItem[] => {
  const items: LibraryCollectionItem[] = [];
  const indexes = new Map<number, number>();

  for (const page of pages ?? []) {
    for (const item of page.results) {
      const existingIndex = indexes.get(item.id);
      if (existingIndex === undefined) {
        indexes.set(item.id, items.length);
        items.push(item);
      } else {
        items[existingIndex] = item;
      }
    }
  }

  return items;
};

export const isLastCollectionsPage = (
  pages: LibraryCollectionsResponse[] | undefined
): boolean => {
  const lastPage = pages?.at(-1);
  return Boolean(
    lastPage &&
    (lastPage.pageInfo.pages === 0 ||
      lastPage.pageInfo.page >= lastPage.pageInfo.pages)
  );
};
