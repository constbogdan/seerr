import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Person filmography Watchlist presentation', () => {
  const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');

  it('passes current-user Watchlist membership to cast and crew cards', () => {
    assert.equal(
      (
        source.match(
          /isAddedToWatchlist=\{\s*media\.mediaInfo\?\.watchlists\?\.length \?\? 0\s*\}/g
        ) ?? []
      ).length,
      2
    );
    assert.match(source, /id=\{media\.id\}/);
    assert.match(source, /mediaType=\{media\.mediaType as 'movie' \| 'tv'\}/);
  });

  it('revalidates the combined credits after confirmed card mutations', () => {
    assert.match(source, /mutate: revalidateCombinedCredits/);
    assert.equal(
      (source.match(/mutateParent=\{revalidateCombinedCredits\}/g) ?? [])
        .length,
      2
    );
  });
});
