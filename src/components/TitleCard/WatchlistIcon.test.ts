import { BookmarkIcon as BookmarkIconOutline } from '@heroicons/react/24/outline';
import { BookmarkIcon as BookmarkIconSolid } from '@heroicons/react/24/solid';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getWatchlistIcon } from './WatchlistIcon';

describe('TitleCard WatchlistIcon', () => {
  it('uses the outline bookmark when the title is not Watchlisted', () => {
    assert.equal(getWatchlistIcon(false), BookmarkIconOutline);
  });

  it('uses the solid bookmark when the title is Watchlisted', () => {
    assert.equal(getWatchlistIcon(true), BookmarkIconSolid);
  });

  it('switches icons when Watchlist membership changes', () => {
    const beforeAdding = getWatchlistIcon(false);
    const afterAdding = getWatchlistIcon(true);
    const afterRemoving = getWatchlistIcon(false);

    assert.notEqual(beforeAdding, afterAdding);
    assert.equal(afterAdding, BookmarkIconSolid);
    assert.equal(afterRemoving, BookmarkIconOutline);
  });

  it('binds the shared card icon to the current Watchlist membership', () => {
    const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');

    assert.match(
      source,
      /<WatchlistIcon\s+isWatchlisted=\{!toggleWatchlist\}[\s\S]*?className=\{watchlistIconClassName\}/
    );
  });
});
