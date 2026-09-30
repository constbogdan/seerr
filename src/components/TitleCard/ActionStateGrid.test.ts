import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ActionStateGrid from './ActionStateGrid';

const item = (id: string) => ({
  id,
  content: createElement('span', null, id),
});

describe('TitleCard action and state grid', () => {
  it('keeps a dense action-only column when no state exists', () => {
    const markup = renderToStaticMarkup(
      createElement(ActionStateGrid, {
        actions: [item('watchlist'), item('blocklist')],
        states: [],
      })
    );

    assert.match(markup, /grid-cols-\[1\.75rem\]/);
    assert.match(
      markup,
      /data-action-slot="watchlist"[^>]*grid-column:1;grid-row:1/
    );
    assert.match(
      markup,
      /data-action-slot="blocklist"[^>]*grid-column:1;grid-row:2/
    );
    assert.doesNotMatch(markup, /data-state-slot/);
  });

  it('aligns Watched-only with the first action without an empty state row', () => {
    const markup = renderToStaticMarkup(
      createElement(ActionStateGrid, {
        actions: [item('watchlist'), item('blocklist')],
        states: [item('watched')],
      })
    );

    assert.match(markup, /grid-cols-\[1\.75rem_1\.75rem\]/);
    assert.match(
      markup,
      /data-action-slot="watchlist"[^>]*grid-column:1;grid-row:1/
    );
    assert.match(
      markup,
      /data-state-slot="watched"[^>]*grid-column:2;grid-row:1/
    );
  });

  it('aligns availability and Watched with the first two action rows', () => {
    const markup = renderToStaticMarkup(
      createElement(ActionStateGrid, {
        actions: [item('watchlist'), item('blocklist')],
        states: [item('availability'), item('watched')],
      })
    );

    assert.match(
      markup,
      /data-action-slot="watchlist"[^>]*grid-column:1;grid-row:1/
    );
    assert.match(
      markup,
      /data-state-slot="availability"[^>]*grid-column:2;grid-row:1/
    );
    assert.match(
      markup,
      /data-action-slot="blocklist"[^>]*grid-column:1;grid-row:2/
    );
    assert.match(
      markup,
      /data-state-slot="watched"[^>]*grid-column:2;grid-row:2/
    );
    assert.match(markup, /auto-rows-\[1\.75rem\]/);
    assert.ok(markup.indexOf('availability') < markup.indexOf('watched'));
  });

  it('keeps the state column in place while hover actions are absent', () => {
    const markup = renderToStaticMarkup(
      createElement(ActionStateGrid, {
        actions: [],
        states: [item('availability'), item('watched')],
      })
    );

    assert.match(markup, /grid-cols-\[1\.75rem_1\.75rem\]/);
    assert.match(
      markup,
      /data-state-slot="availability"[^>]*grid-column:2;grid-row:1/
    );
    assert.match(
      markup,
      /data-state-slot="watched"[^>]*grid-column:2;grid-row:2/
    );
  });

  it('keeps compact visible geometry without shrinking action hit targets below 28px', () => {
    const markup = renderToStaticMarkup(
      createElement(ActionStateGrid, {
        actions: [item('watchlist'), item('blocklist')],
        states: [item('availability'), item('watched')],
      })
    );

    assert.match(markup, /pointer-events-none grid/);
    assert.equal(
      (markup.match(/class="pointer-events-auto flex h-7 w-7/g) ?? []).length,
      2
    );
    assert.match(markup, /data-action-slot="watchlist"/);
    assert.match(markup, /data-action-slot="blocklist"/);
    assert.match(markup, /class="flex h-7[^>]*data-state-slot="availability"/);
    assert.equal((markup.match(/flex h-7 w-7/g) ?? []).length, 4);
  });
});
