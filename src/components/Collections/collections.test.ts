import type {
  LibraryCollectionItem,
  LibraryCollectionsResponse,
} from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getCollectionCardActionPresentation } from './cardAction';
import {
  COLLECTIONS_PAGE_SIZE,
  collectionsPageUrl,
  collectionsQueryIdentity,
  isLastCollectionsPage,
  mergeCollectionPages,
} from './pagination';
import {
  collectionsQueryToUrl,
  defaultCollectionsQuery,
  parseCollectionsQuery,
} from './query';

const component = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
const cornerBadge = readFileSync(
  path.join(__dirname, '../TitleCard/CornerBadge.tsx'),
  'utf8'
);
const titleCard = readFileSync(
  path.join(__dirname, '../TitleCard/index.tsx'),
  'utf8'
);
const globalMessageSource = readFileSync(
  path.join(__dirname, '../../i18n/globalMessages.ts'),
  'utf8'
);
const page = readFileSync(
  path.join(__dirname, '../../pages/collections/index.tsx'),
  'utf8'
);

describe('Collections page', () => {
  const collection = (
    id: number,
    name = `Collection ${id}`
  ): LibraryCollectionItem => ({
    id,
    name,
    overview: null,
    posterPath: null,
    backdropPath: null,
    availableMovies: 1,
    totalMovies: 2,
    completeness: 'incomplete',
  });
  const responsePage = (
    pageNumber: number,
    pages: number,
    results: LibraryCollectionItem[]
  ): LibraryCollectionsResponse => ({
    pageInfo: {
      pages,
      page: pageNumber,
      results: pages * COLLECTIONS_PAGE_SIZE,
      pageSize: COLLECTIONS_PAGE_SIZE,
    },
    results,
    status: 'complete',
    stale: false,
    discoveredCollections: pages * COLLECTIONS_PAGE_SIZE,
    failedCollections: 0,
    refreshedAt: '2026-10-21T00:00:00.000Z',
  });

  it('round-trips bounded filter, sort, and direction URL state without visible pages', () => {
    const state = parseCollectionsQuery({
      page: '3',
      completeness: 'incomplete',
      sort: 'available',
      sortDirection: 'desc',
    });
    assert.deepEqual(state, {
      completeness: 'incomplete',
      sort: 'available',
      sortDirection: 'desc',
    });
    assert.deepEqual(
      parseCollectionsQuery(collectionsQueryToUrl(state)),
      state
    );
    assert.deepEqual(
      parseCollectionsQuery({
        page: '-2',
        completeness: 'unknown',
        sort: 'popularity',
        sortDirection: 'sideways',
      }),
      defaultCollectionsQuery
    );
    for (const sortDirection of ['asc', 'desc'] as const) {
      const directionalState = {
        ...defaultCollectionsQuery,
        sort: 'completeness' as const,
        sortDirection,
      };
      assert.equal(
        parseCollectionsQuery(collectionsQueryToUrl(directionalState))
          .sortDirection,
        sortDirection
      );
    }
  });

  it('loads backend pages incrementally and stops at the reported boundary', () => {
    const state = defaultCollectionsQuery;
    assert.match(collectionsPageUrl(state, 0, null) ?? '', /take=20&skip=0/);
    assert.match(
      collectionsPageUrl(state, 1, responsePage(1, 4, [collection(1)])) ?? '',
      /take=20&skip=20/
    );
    assert.equal(
      collectionsPageUrl(state, 4, responsePage(4, 4, [collection(80)])),
      null
    );
    assert.equal(isLastCollectionsPage([responsePage(1, 4, [])]), false);
    assert.equal(isLastCollectionsPage([responsePage(4, 4, [])]), true);
  });

  it('deduplicates cards across page boundaries while retaining updated data', () => {
    const merged = mergeCollectionPages([
      responsePage(1, 2, [collection(1), collection(2)]),
      responsePage(2, 2, [collection(2, 'Updated'), collection(3)]),
    ]);
    assert.deepEqual(
      merged.map(({ id }) => id),
      [1, 2, 3]
    );
    assert.equal(merged[1].name, 'Updated');
  });

  it('gives each filter and sort combination an independent restoration identity', () => {
    assert.notEqual(
      collectionsQueryIdentity(defaultCollectionsQuery),
      collectionsQueryIdentity({
        ...defaultCollectionsQuery,
        completeness: 'complete',
      })
    );
    assert.notEqual(
      collectionsQueryIdentity(defaultCollectionsQuery),
      collectionsQueryIdentity({
        ...defaultCollectionsQuery,
        sortDirection: 'desc',
      })
    );
  });

  it('uses collection-specific icons, labels, and colors for every completeness state', () => {
    assert.deepEqual(getCollectionCardActionPresentation('complete'), {
      icon: 'Squares2X2Icon',
      label: 'view',
      className:
        'text-green-400 hover:text-green-300 focus:ring-green-300 active:text-green-300',
    });
    assert.deepEqual(getCollectionCardActionPresentation('incomplete'), {
      icon: 'SquaresPlusIcon',
      label: 'request',
      className:
        'text-gray-300 hover:text-white focus:ring-gray-300 active:text-white',
    });
    assert.deepEqual(getCollectionCardActionPresentation('unknown'), {
      icon: 'Squares2X2Icon',
      label: 'view',
      className:
        'text-gray-300 hover:text-white focus:ring-gray-300 active:text-white',
    });
  });

  it('uses the responsive Seerr card grid and existing accessible Collection navigation', () => {
    assert.match(component, /<ul[\s\S]*?className="cards-vertical"/);
    assert.match(component, /<TitleCard[\s\S]*?mediaType="collection"/);
    assert.match(component, /classificationBadge=/);
    assert.match(
      component,
      /<TitleCardCornerBadge tone=\{availabilityClassName\}>/
    );
    assert.match(component, /collection\.name/);
    assert.match(component, /title=\{collection\.name\}/);
    assert.match(component, /availabilityUnknown/);
    assert.match(component, /actionsDisabled/);
    assert.match(component, /requestActionEnabled/);
    assert.match(component, /requestActionLabel=\{requestActionLabel\}/);
    assert.match(
      component,
      /requestActionClassName=\{requestAction\.className\}/
    );
    assert.match(component, /requestActionIcon=/);
    assert.match(
      component,
      /data-collection-action-icon=\{requestAction\.icon\}/
    );
    assert.match(component, /Squares2X2Icon/);
    assert.match(component, /SquaresPlusIcon/);
    assert.match(component, /globalMessages\.view/);
    assert.match(component, /globalMessages\.request/);
    assert.match(
      titleCard,
      /mediaType === 'collection'[\s\S]*?`\/collection\/\$\{id\}`/
    );
    assert.match(
      titleCard,
      /aria-label=\{intl\.formatMessage\(messages\.viewTitle/
    );
    assert.match(cornerBadge, /complete: 'text-green-400'/);
    assert.match(cornerBadge, /incomplete: 'text-amber-300'/);
    assert.match(cornerBadge, /neutral: 'text-gray-300'/);
    assert.doesNotMatch(component, /cardComplete|cardIncomplete/);
    assert.doesNotMatch(component, /globalMessages\.collection/);
    assert.doesNotMatch(component, /persistentMetadata=/);
    assert.match(page, /useRouteGuard\(Permission\.ADMIN\)/);
  });

  it('selects collection-only tooltip and accessible labels by completeness', () => {
    assert.match(globalMessageSource, /request: 'Request'/);
    assert.match(globalMessageSource, /view: 'View'/);
    assert.match(
      component,
      /requestAction\.label === 'request'[\s\S]*?globalMessages\.request[\s\S]*?globalMessages\.view/
    );
    assert.doesNotMatch(component, /Request Movies|View Collection Movies/);
    assert.match(titleCard, /resolveTitleCardRequestActionLabel\(/);
    assert.match(titleCard, /<Tooltip content=\{resolvedRequestActionLabel\}>/);
    assert.match(titleCard, /aria-label=\{resolvedRequestActionLabel\}/);
    assert.doesNotMatch(component, /View \/ Request Movies|viewRequestMovies/);
  });

  it('uses the shared Request modal action without custom collection touch handling', () => {
    assert.match(titleCard, /<RequestModal[\s\S]*?type=\{/);
    assert.match(titleCard, /<RequestIconButton/);
    assert.match(titleCard, /setShowRequestModal\(true\)/);
    assert.match(titleCard, /e\.preventDefault\(\)/);
    assert.match(titleCard, /e\.stopPropagation\(\)/);
    assert.match(titleCard, /beginCardPointerGesture/);
    assert.match(titleCard, /consumeCardNavigationClick/);
    assert.doesNotMatch(component, /onPointerDown|onTouchStart|onClick=/);
    assert.doesNotMatch(component, /requestActionEnabled=\{/);
  });

  it('keeps the collection name in the shared hover and missing-artwork overlay', () => {
    assert.match(component, /title=\{collection\.name\}/);
    assert.match(
      titleCard,
      /show=\{!image \|\| showDetail \|\| showRequestModal\}/
    );
    assert.match(titleCard, /data-testid="title-card-title"/);
    assert.match(titleCard, /<span className="sr-only">\{title\}<\/span>/);
    assert.match(titleCard, /seerr_poster_not_found_logo_top\.png/);
  });

  it('uses the Watchlist header and compact responsive filter layout', () => {
    assert.match(
      component,
      /className="mb-5 mt-1"[\s\S]*?className="flex flex-col justify-between lg:flex-row lg:items-end"/
    );
    assert.match(
      component,
      /<Header>\{intl\.formatMessage\(messages\.title\)\}<\/Header>[\s\S]*?className="relative z-50 mt-2 flex flex-wrap gap-2"/
    );
    assert.equal(
      component.match(/className="rounded-r-only min-w-0"/g)?.length,
      3
    );
    assert.equal(
      component.match(
        /<span className="sr-only">\s*\{intl\.formatMessage\(messages\.(?:completeness|sort|direction)\)\}\s*<\/span>/g
      )?.length,
      3
    );
    assert.match(
      component,
      /aria-label=\{intl\.formatMessage\(messages\.completeness\)\}/
    );
    assert.match(
      component,
      /aria-label=\{intl\.formatMessage\(messages\.sort\)\}/
    );
    assert.match(
      component,
      /aria-label=\{intl\.formatMessage\(messages\.direction\)\}/
    );
    assert.doesNotMatch(
      component,
      /mb-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end/
    );
    assert.doesNotMatch(component, /sm:w-44|sm:w-48|sm:w-40/);
  });

  it('keeps pending, partial, unavailable, and empty states explicit', () => {
    assert.match(component, /currentStatus === 'pending'/);
    assert.match(component, /currentStatus === 'partial'/);
    assert.match(component, /currentStatus === 'unavailable'/);
    assert.match(component, /collections\.length === 0/);
  });

  it('uses shared infinite loading and skeleton conventions without eager pagination controls', () => {
    assert.match(component, /useSWRInfinite<LibraryCollectionsResponse>/);
    assert.match(component, /useVerticalScroll/);
    assert.match(component, /setSize\(\(currentSize\) => currentSize \+ 1\)/);
    assert.match(component, /revalidateAll: true/);
    assert.match(component, /<TitleCard\.Placeholder canExpand \/>/);
    assert.match(component, /aria-busy=\{showSkeletons \|\| isValidating\}/);
    assert.doesNotMatch(component, /<LoadingSpinner|<nav/);
  });

  it('resets changed queries and retains page height for native Back restoration', () => {
    assert.match(component, /const retainedCollectionPageCounts = new Map/);
    assert.match(
      component,
      /initialSize: retainedCollectionPageCounts\.get\(queryIdentity\) \?\? 1/
    );
    assert.match(
      component,
      /retainedCollectionPageCounts\.delete\(collectionsQueryIdentity\(nextState\)\)/
    );
    assert.doesNotMatch(
      component,
      /window\.scrollTo|history\.scrollRestoration/
    );
  });

  it('uses stable responsive cards and valid typography', () => {
    assert.match(
      component,
      /classificationBadge=\{[\s\S]*?TitleCardCornerBadge[\s\S]*?\{availability\}/
    );
    assert.doesNotMatch(component, /persistentMetadata=/);
    assert.match(component, /Loading Library collections…/);
    assert.match(component, /Refreshing collection metadata…/);
    assert.doesNotMatch(component, /Movie collections represented/);
    assert.doesNotMatch(component, /â|Ã|Â/);
  });
});
