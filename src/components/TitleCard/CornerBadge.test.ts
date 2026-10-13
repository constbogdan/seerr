import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TitleCardCornerBadge from './CornerBadge';

describe('TitleCard corner badges', () => {
  it('reuses the compact Leaving Soon deadline badge geometry', () => {
    const movie = renderToStaticMarkup(
      createElement(TitleCardCornerBadge, {
        children: 'Movie',
        tone: 'movie',
      })
    );
    const series = renderToStaticMarkup(
      createElement(TitleCardCornerBadge, {
        children: 'Series',
        tone: 'series',
      })
    );

    for (const markup of [movie, series]) {
      assert.match(markup, /rounded-md/);
      assert.match(markup, /bg-gray-900\/90/);
      assert.match(markup, /px-2/);
      assert.match(markup, /py-1/);
      assert.match(markup, /text-center/);
      assert.match(markup, /text-xs/);
      assert.match(markup, /font-medium/);
      assert.match(markup, /shadow-md/);
      assert.doesNotMatch(
        markup,
        /\bborder\b|h-(?:4|7)|sm:h-5|rounded-(?:full|tl-|tr-|bl-|br-)|leading-(?:4|5)/
      );
    }
  });

  it('uses Movie and Series colors only for badge text', () => {
    const movie = renderToStaticMarkup(
      createElement(TitleCardCornerBadge, {
        children: 'Movie',
        tone: 'movie',
      })
    );
    const series = renderToStaticMarkup(
      createElement(TitleCardCornerBadge, {
        children: 'Series',
        tone: 'series',
      })
    );
    assert.match(movie, /text-blue-400/);
    assert.match(series, /text-purple-400/);
    assert.doesNotMatch(movie, /bg-blue|border-blue/);
    assert.doesNotMatch(series, /bg-purple|border-purple/);
  });
});
