import { MediaStatus } from '@server/constants/media';
import { UserType } from '@server/constants/user';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import ActionStateGrid, { type TitleCardOverlayItem } from './ActionStateGrid';
import WatchlistIcon from './WatchlistIcon';
import { buildTitleCardStateIndicators } from './stateIndicators';

const filename = path.join(__dirname, 'index.tsx');
const source = readFileSync(filename, 'utf8');
const syntax = ts.createSourceFile(
  filename,
  source,
  ts.ScriptTarget.Latest,
  true
);
const declarations = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer)
    declarations.set(
      node.name.getText(syntax),
      node.initializer.getText(syntax)
    );
  ts.forEachChild(node, visit);
}
visit(syntax);

// Execute the real TitleCard action JSX, not a second copy of the predicate.
// Provider calls and mutation handlers are never executed by this fixture.
const compiled = ts.transpileModule(
  `export default function actions(context) {
    const { showDetail, toggleWatchlist, mediaType,
      cornerAction, persistentMetadata, actionsDisabled, currentStatus, user,
      isUpdating, showHideButton, blocklistAction, onClickWatchlistBtn,
      onClickDeleteWatchlistBtn } = context;
    const messages = { addToWatchList: 'Add', removeFromWatchList: 'Remove' };
    const intl = { formatMessage: value => value };
    const watchlistIconClassName = ${declarations.get('watchlistIconClassName')};
    const watchlistAction = ${declarations.get('watchlistAction')};
    const showWatchlistAction = ${declarations.get('showWatchlistAction')};
    const hideBlocklistPresentation = ${declarations.get('hideBlocklistPresentation')};
    return ${declarations.get('rightSideActions')};
  }
  export function states(context) {
    const { mediaType, cornerAction, persistentMetadata, actionsDisabled,
      stateIndicators } = context;
    const messages = { watched: 'Watched' };
    const intl = { formatMessage: value => value };
    const hideBlocklistPresentation = ${declarations.get('hideBlocklistPresentation')};
    const useLowerRightStatus = ${declarations.get('useLowerRightStatus')};
    return ${declarations.get('rightSideStates')};
  }`,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }
).outputText;
const exportsFixture: {
  default?: (context: object) => TitleCardOverlayItem[];
  states?: (context: object) => TitleCardOverlayItem[];
} = {};
runInNewContext(compiled, {
  exports: exportsFixture,
  require: createRequire(__filename),
  MediaStatus,
  UserType,
  Tooltip: ({ children }: { children: ReactElement }) => children,
  Button: ({ buttonType, buttonSize, ...props }: Record<string, unknown>) => {
    void buttonType;
    void buttonSize;
    return createElement('button', props);
  },
  WatchlistIcon,
  StatusBadgeMini: 'span',
});

const actions = (overrides: Record<string, unknown> = {}) =>
  exportsFixture.default!({
    showDetail: false,
    toggleWatchlist: false,
    mediaType: 'movie',
    actionsDisabled: false,
    currentStatus: MediaStatus.UNKNOWN,
    user: { userType: UserType.JELLYFIN },
    isUpdating: false,
    showHideButton: true,
    blocklistAction: {
      label: 'Blocklist',
      onClick: () => {},
      icon: 'Blocklist',
    },
    onClickWatchlistBtn: () => {},
    onClickDeleteWatchlistBtn: () => {},
    ...overrides,
  });
const bookmark = (items: TitleCardOverlayItem[]) =>
  items.find(({ id }) => id === 'watchlist');
const button = (items: TitleCardOverlayItem[]) =>
  (bookmark(items)!.content as ReactElement<{ children: ReactElement }>).props
    .children as ReactElement<{ disabled: boolean; onClick: () => void }>;
const states = (overrides: Record<string, unknown> = {}) =>
  exportsFixture.states!({
    mediaType: 'movie',
    actionsDisabled: false,
    stateIndicators: [],
    ...overrides,
  });

describe('persistent Watchlist bookmark presentation', () => {
  it('keeps gold bookmarks visible at rest and during hover/focus for Movies and Series', () => {
    for (const mediaType of ['movie', 'tv']) {
      for (const showDetail of [false, true]) {
        const items = actions({ mediaType, showDetail });
        assert.ok(bookmark(items));
        const markup = renderToStaticMarkup(
          createElement(ActionStateGrid, { actions: items, states: [] })
        );
        assert.match(markup, /text-\[#FFC107\]/);
        assert.match(markup, /fill="currentColor"/);
        assert.match(markup, /!h-\[1\.4375rem\] !w-\[1\.4375rem\]/);
        assert.equal(
          items.some(({ id }) => id === 'blocklist'),
          false
        );
      }
    }
  });

  it('keeps silver outline bookmarks hover/focus-only when not Watchlisted', () => {
    assert.equal(bookmark(actions({ toggleWatchlist: true })), undefined);
    const markup = renderToStaticMarkup(
      createElement(ActionStateGrid, {
        actions: actions({ toggleWatchlist: true, showDetail: true }),
        states: [],
      })
    );
    assert.match(markup, /text-\[#C0C0C0\]/);
    assert.match(markup, /fill="none"/);
    assert.match(source, /onFocusCapture=\{\(\) => setShowDetail\(true\)\}/);
  });

  it('retains the original add/remove callbacks and loading/permission gates', () => {
    let added = 0;
    let removed = 0;
    const callbacks = {
      onClickWatchlistBtn: () => added++,
      onClickDeleteWatchlistBtn: () => removed++,
    };
    button(actions(callbacks)).props.onClick();
    button(
      actions({ ...callbacks, toggleWatchlist: true, showDetail: true })
    ).props.onClick();
    assert.deepEqual([added, removed], [1, 1]);
    assert.equal(button(actions({ isUpdating: true })).props.disabled, true);
    assert.equal(bookmark(actions({ actionsDisabled: true })), undefined);
    assert.equal(
      bookmark(actions({ currentStatus: MediaStatus.BLOCKLISTED })),
      undefined
    );
    assert.equal(
      bookmark(actions({ user: { userType: UserType.PLEX } })),
      undefined
    );
  });

  it('leaves collection-level cards and specialized variants hover-only', () => {
    for (const overrides of [
      { mediaType: 'collection' },
      { cornerAction: createElement('span', null, 'Custom') },
      { persistentMetadata: createElement('span', null, 'Metadata') },
    ]) {
      assert.equal(bookmark(actions(overrides)), undefined);
      assert.ok(bookmark(actions({ ...overrides, showDetail: true })));
    }
  });

  it('does not change owner membership, duplicate identity, retrieval or mutation logic', () => {
    const list = readFileSync(
      path.join(__dirname, '../Common/ListView/index.tsx'),
      'utf8'
    );
    assert.match(list, /key=\{watchlistOccurrenceKey\(title, index\)\}/);
    assert.match(list, /isAddedToWatchlist=\{true\}/);
    assert.match(list, /watchState=\{title\.watchState\}/);
    assert.match(list, /showWatchlistOwner \? title\.requestedBy : undefined/);
    assert.doesNotMatch(source, /watchlistOwnerId|resolveCardUserState/);
    assert.match(source, /onClick=\{watchlistAction\.onClick\}/);
    const collection = readFileSync(
      path.join(__dirname, '../CollectionDetails/index.tsx'),
      'utf8'
    );
    assert.match(
      collection,
      /<TitleCard[\s\S]*?mediaType=\{title\.mediaType\}/
    );
    assert.doesNotMatch(collection, /persistentWatchlist|statusVariant/);
  });

  it('hides Block and Unblock actions only on ordinary Movie/Series cards', () => {
    for (const mediaType of ['movie', 'tv']) {
      for (const currentStatus of [
        MediaStatus.UNKNOWN,
        MediaStatus.BLOCKLISTED,
      ]) {
        const options = { mediaType, currentStatus, showDetail: true };
        assert.ok(!actions(options).some(({ id }) => id === 'blocklist'));
        assert.ok(
          actions({ ...options, cornerAction: createElement('span') }).some(
            ({ id }) => id === 'blocklist'
          )
        );
      }
    }
    assert.ok(
      actions({ mediaType: 'collection', showDetail: true }).some(
        ({ id }) => id === 'blocklist'
      )
    );
  });

  it('retains blocked-state hiding and Watched while media status moves to the lower right', () => {
    const blocked = buildTitleCardStateIndicators({
      currentStatus: MediaStatus.BLOCKLISTED,
      watchState: 'watched',
    });
    for (const mediaType of ['movie', 'tv']) {
      assert.deepEqual(
        Array.from(
          states({ mediaType, stateIndicators: blocked }),
          ({ id }) => id
        ),
        ['watched']
      );
      assert.equal(
        states({ mediaType, stateIndicators: blocked, actionsDisabled: true })
          .length,
        1
      );
    }
    assert.equal(
      states({ mediaType: 'collection', stateIndicators: blocked }).length,
      2
    );
    const downloading = buildTitleCardStateIndicators({
      currentStatus: MediaStatus.BLOCKLISTED,
      inProgress: true,
    });
    assert.equal(states({ stateIndicators: downloading }).length, 0);
  });

  it('relocates ordinary media status without changing Watched or specialized badges', () => {
    for (const currentStatus of [
      MediaStatus.PENDING,
      MediaStatus.PROCESSING,
      MediaStatus.PARTIALLY_AVAILABLE,
      MediaStatus.AVAILABLE,
      MediaStatus.DELETED,
    ]) {
      for (const inProgress of [false, true]) {
        const original = buildTitleCardStateIndicators({
          currentStatus,
          watchState: 'watched',
          inProgress,
        });
        const rendered = states({ stateIndicators: original });
        assert.deepEqual(
          Array.from(rendered, ({ id }) => id),
          ['watched']
        );
        assert.equal(rendered[0].row, 2);
        const legacy = states({
          stateIndicators: original,
          mediaType: 'collection',
        });
        assert.deepEqual(
          Array.from(legacy, ({ id }) => id),
          original.map(({ id }) => id)
        );
        for (const [index, item] of legacy.entries()) {
          const child = (
            item.content as ReactElement<{
              children: ReactElement<Record<string, unknown>>;
            }>
          ).props.children;
          assert.equal(child.props.status, original[index].status);
          assert.equal(child.props.inProgress, original[index].inProgress);
          assert.equal(child.props.shrink, true);
        }
      }
    }
  });
});
