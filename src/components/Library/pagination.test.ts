import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getLibraryNearbyPages,
  getLibraryPaginationItems,
  getLibraryPaginationPresentation,
} from './pagination';

describe('Library numbered pagination', () => {
  it('shows every page when the result has no skipped range', () => {
    assert.deepEqual(getLibraryPaginationItems(3, 6), [1, 2, 3, 4, 5, 6]);
  });

  it('keeps first, last, and nearby pages visible with deterministic ellipses', () => {
    assert.deepEqual(getLibraryPaginationItems(6, 12), [
      1,
      'start-ellipsis',
      5,
      6,
      7,
      'end-ellipsis',
      12,
    ]);
    assert.deepEqual(getLibraryPaginationItems(2, 12), [
      1,
      2,
      3,
      4,
      5,
      'end-ellipsis',
      12,
    ]);
    assert.deepEqual(getLibraryPaginationItems(11, 12), [
      1,
      'start-ellipsis',
      8,
      9,
      10,
      11,
      12,
    ]);
  });

  it('limits narrow layouts to adjacent page numbers', () => {
    assert.deepEqual(getLibraryNearbyPages(6, 12), [5, 6, 7]);
    assert.deepEqual(getLibraryNearbyPages(1, 12), [1, 2]);
    assert.deepEqual(getLibraryNearbyPages(12, 12), [11, 12]);
  });
});

describe('Library pagination presentation', () => {
  it('preserves the requested page during the initial load', () => {
    assert.deepEqual(
      getLibraryPaginationPresentation({
        requestedPage: 2,
        isLoading: true,
        isValidating: true,
        hasError: false,
      }),
      {
        displayedPage: 2,
        isRetainingPreviousPage: false,
        isPagePending: false,
      }
    );
  });

  it('identifies retained rows while a newly requested page loads', () => {
    assert.deepEqual(
      getLibraryPaginationPresentation({
        requestedPage: 2,
        responsePage: 1,
        isLoading: true,
        isValidating: true,
        hasError: false,
      }),
      {
        displayedPage: 1,
        isRetainingPreviousPage: true,
        isPagePending: true,
      }
    );
  });

  it('treats cached data for the requested page as current during revalidation', () => {
    assert.deepEqual(
      getLibraryPaginationPresentation({
        requestedPage: 2,
        responsePage: 2,
        isLoading: false,
        isValidating: true,
        hasError: false,
      }),
      {
        displayedPage: 2,
        isRetainingPreviousPage: false,
        isPagePending: false,
      }
    );
  });

  it('does not present an older rapid-change response as the requested page', () => {
    const stalePresentation = getLibraryPaginationPresentation({
      requestedPage: 3,
      responsePage: 2,
      isLoading: true,
      isValidating: true,
      hasError: false,
    });
    const currentPresentation = getLibraryPaginationPresentation({
      requestedPage: 3,
      responsePage: 3,
      isLoading: false,
      isValidating: false,
      hasError: false,
    });

    assert.equal(stalePresentation.displayedPage, 2);
    assert.equal(stalePresentation.isPagePending, true);
    assert.equal(currentPresentation.displayedPage, 3);
    assert.equal(currentPresentation.isPagePending, false);
  });

  it('stops the pending treatment when the requested page fails', () => {
    assert.deepEqual(
      getLibraryPaginationPresentation({
        requestedPage: 2,
        responsePage: 1,
        isLoading: false,
        isValidating: false,
        hasError: true,
      }),
      {
        displayedPage: 1,
        isRetainingPreviousPage: true,
        isPagePending: false,
      }
    );
  });
});
