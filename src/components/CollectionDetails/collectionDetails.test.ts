import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
const globalStyles = readFileSync(
  path.join(__dirname, '../../styles/globals.css'),
  'utf8'
);
const titleCard = readFileSync(
  path.join(__dirname, '../TitleCard/index.tsx'),
  'utf8'
);
const collectionModel = readFileSync(
  path.join(__dirname, '../../../server/models/Collection.ts'),
  'utf8'
);
const collectionPage = readFileSync(
  path.join(__dirname, '../../pages/collection/[collectionId]/index.tsx'),
  'utf8'
);
const moviePage = readFileSync(
  path.join(__dirname, '../../pages/movie/[movieId]/index.tsx'),
  'utf8'
);

describe('Collection Details movie grid', () => {
  it('renders the complete ordered response as the shared responsive card grid', () => {
    assert.match(source, /<ul className="cards-vertical">/);
    assert.match(source, /visibleParts\.map\(\(title\) =>/);
    assert.match(source, /<li key=\{`collection-movie-\$\{title\.id\}`\}>/);
    assert.match(source, /<TitleCard[\s\S]*?canExpand/);
    assert.doesNotMatch(source, /import Slider|<Slider/);
    assert.doesNotMatch(source, /visibleParts\.(?:slice|sort)\(/);
    assert.match(
      collectionModel,
      /sortBy\(collection\.parts, 'release_date'\)/
    );
    assert.match(
      globalStyles,
      /ul\.cards-vertical[\s\S]*repeat\(auto-fill, minmax\(9\.375rem, 1fr\)\)/
    );
    assert.doesNotMatch(source, /overflow-x-(?:auto|scroll)/);
  });

  it('preserves statuses, actions, watchlist state, and parent revalidation', () => {
    assert.match(source, /status=\{title\.mediaInfo\?\.status\}/);
    assert.match(
      source,
      /isAddedToWatchlist=\{title\.mediaInfo\?\.watchlists\?\.length \?\? 0\}/
    );
    assert.match(source, /mutateParent=\{revalidate\}/);
    assert.match(source, /<RequestModal[\s\S]*?onComplete=/);
  });

  it('preserves permission-aware blocklist filtering and the empty state', () => {
    assert.match(source, /Permission\.MANAGE_BLOCKLIST/);
    assert.match(source, /Permission\.VIEW_BLOCKLIST/);
    assert.match(
      source,
      /part\.mediaInfo\?\.status !== MediaStatus\.BLOCKLISTED/
    );
    assert.match(source, /visibleParts\.length > 0/);
    assert.match(source, /globalMessages\.noresults/);
  });

  it('inherits shared Android first-tap and accessible card interaction', () => {
    assert.match(titleCard, /beginCardPointerGesture/);
    assert.match(titleCard, /consumeCardNavigationClick/);
    assert.match(titleCard, /event\.preventDefault\(\)/);
    assert.match(
      titleCard,
      /aria-label=\{intl\.formatMessage\(messages\.viewTitle/
    );
  });

  it('keeps Collection and Movie details registered as server-rendered pages', () => {
    [collectionPage, moviePage].forEach((page) => {
      assert.match(page, /export const getServerSideProps/);
      assert.match(page, /export default/);
      assert.match(page, /ctx\.query\.(?:collectionId|movieId)/);
    });
    assert.match(
      collectionPage,
      /<CollectionDetails collection=\{collection\}/
    );
    assert.match(moviePage, /<MovieDetails movie=\{movie\}/);
  });
});
