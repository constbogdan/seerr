import type {
  LibraryCollectionCompletenessFilter,
  LibraryCollectionSort,
  LibrarySortDirection,
} from '@server/interfaces/api/libraryInterfaces';
import type { ParsedUrlQuery } from 'querystring';

export interface CollectionsQueryState {
  completeness: LibraryCollectionCompletenessFilter;
  sort: LibraryCollectionSort;
  sortDirection: LibrarySortDirection;
}

export const defaultCollectionsQuery: CollectionsQueryState = {
  completeness: 'all',
  sort: 'name',
  sortDirection: 'asc',
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export const parseCollectionsQuery = (
  query: ParsedUrlQuery
): CollectionsQueryState => {
  const completeness = first(query.completeness);
  const sort = first(query.sort);
  const sortDirection = first(query.sortDirection);
  return {
    completeness:
      completeness === 'complete' || completeness === 'incomplete'
        ? completeness
        : 'all',
    sort: sort === 'completeness' || sort === 'available' ? sort : 'name',
    sortDirection: sortDirection === 'desc' ? 'desc' : 'asc',
  };
};

export const collectionsQueryToUrl = (
  state: CollectionsQueryState
): Record<string, string> => ({
  completeness: state.completeness,
  sort: state.sort,
  sortDirection: state.sortDirection,
});
