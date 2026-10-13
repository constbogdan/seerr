import type { NextRouter } from 'next/router';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeQueryString } from './useUpdateQueryParams';

describe('query parameter updates', () => {
  it('removes cleared Library dates while retaining unrelated browsing state', () => {
    const router = {
      pathname: '/library',
      asPath:
        '/library?scope=all&addedFrom=2026-01-01&removedTo=2026-02-01&page=4',
      query: {
        scope: 'all',
        addedFrom: '2026-01-01',
        removedTo: '2026-02-01',
        page: '4',
      },
    } as unknown as NextRouter;

    const result = mergeQueryString(router, {
      addedFrom: undefined,
      removedTo: undefined,
      page: '1',
    });

    assert.equal(result.path, '/library?scope=all&page=1');
    assert.equal(result.pathname, '/library?scope=all&page=1');
  });
});
