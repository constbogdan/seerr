import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TitleCardCornerBadge from './CornerBadge';

describe('TitleCard corner badges', () => {
  it('uses one geometry primitive for classification and owner metadata', () => {
    const movie = renderToStaticMarkup(
      createElement(TitleCardCornerBadge, {
        children: 'Movie',
        tone: 'movie',
      })
    );
    const owner = renderToStaticMarkup(
      createElement(TitleCardCornerBadge, {
        children: 'Bogdan',
        tone: 'owner',
      })
    );

    for (const markup of [movie, owner]) {
      assert.match(markup, /h-7/);
      assert.match(markup, /rounded-md/);
      assert.match(markup, /px-2/);
      assert.match(markup, /text-xs/);
      assert.match(markup, /leading-5/);
      assert.doesNotMatch(markup, /leading-none/);
    }
  });

  it('preserves classification colors and gives owner a neutral treatment', () => {
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
    const owner = renderToStaticMarkup(
      createElement(TitleCardCornerBadge, {
        children: 'Bogdan',
        tone: 'owner',
      })
    );

    assert.match(movie, /bg-blue-600\/80/);
    assert.match(series, /bg-purple-600\/80/);
    assert.match(owner, /bg-gray-900\/80/);
    assert.doesNotMatch(owner, /bg-(?:blue|purple|indigo)-/);
    for (const markup of [movie, series, owner]) {
      assert.doesNotMatch(markup, /\bborder(?:-|\s)/);
    }
  });

  it('keeps descender-bearing owner names inside the shared line box', () => {
    const owner = renderToStaticMarkup(
      createElement(TitleCardCornerBadge, {
        children: 'Bogdan Grumpy Jay',
        tone: 'owner',
      })
    );

    assert.match(owner, />Bogdan Grumpy Jay<\/span>/);
    assert.match(owner, /h-7/);
    assert.match(owner, /items-center/);
    assert.match(owner, /leading-5/);
  });
});
