import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import WatchlistItemCount from './WatchlistItemCount';

const renderCount = (count: number | undefined, loading = false) =>
  renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: 'en' },
      createElement(WatchlistItemCount, { count, loading })
    )
  );

describe('Watchlist filtered item count', () => {
  it('formats zero, singular, and plural authoritative totals', () => {
    assert.match(renderCount(0), />0 items</);
    assert.match(renderCount(1), />1 item</);
    assert.match(renderCount(530), />530 items</);
  });

  it('does not show a count while the current query is loading', () => {
    assert.equal(renderCount(undefined, true), '');
    assert.equal(renderCount(530, true), '');
  });
});
