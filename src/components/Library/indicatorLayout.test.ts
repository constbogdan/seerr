import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Evaluate the existing production JSX, not a separately reimplemented layout.
const source = ts.createSourceFile(
  'LibraryItem.tsx',
  readFileSync(path.join(__dirname, 'LibraryItem.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let grid: ts.JsxElement | undefined;
const visit = (node: ts.Node): void => {
  if (
    ts.isJsxElement(node) &&
    node.openingElement.attributes.properties.some(
      (attribute) =>
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(source) === 'className' &&
        attribute.initializer?.getText(source).includes('grid-cols-[4.75rem_')
    )
  )
    grid = node;
  ts.forEachChild(node, visit);
};
visit(source);
assert.ok(grid, 'Existing Library engagement grid must exist');

interface Element {
  type: string;
  props: Record<string, unknown> & { children: (Element | false)[] };
}
const createElement = (
  type: string,
  props: Record<string, unknown> | null,
  ...children: (Element | false)[]
): Element => ({ type, props: { ...props, children } });
const componentNames = [
  'Tooltip',
  'LastActiveAvatarStack',
  'RequesterAvatarStack',
  'AvatarStack',
  'WatchedChipGroup',
  'ClockIcon',
  'FolderArrowDownIcon',
  'BookmarkIcon',
  'PlayIcon',
];
const compiled = ts.transpileModule(
  `module.exports = (item, intl, messages) => (${grid.getText(source)});`,
  { compilerOptions: { jsx: ts.JsxEmit.React } }
).outputText;
const moduleFixture = { exports: undefined as unknown };
runInNewContext(compiled, {
  module: moduleFixture,
  React: { createElement },
  ...Object.fromEntries(componentNames.map((name) => [name, name])),
});
const item = {
  lastActiveUsers: [{ id: 1 }, { id: 2 }],
  requesters: [{ id: 3 }, { id: 4 }],
  watchlistUsers: [{ id: 5 }],
  watchedUsers: [{ userId: 6, watchedPercentage: 55 }],
  lastActiveAt: '2026-10-29T12:00:00.000Z',
};
type Item = typeof item;
const messages = {
  lastActive: 'Last active',
  requesters: 'Requesters',
  watchlist: 'Watchlist',
  watched: 'Watched',
};
const render = (value: Item): Element =>
  (moduleFixture.exports as (...args: unknown[]) => Element)(
    value,
    { formatMessage: (message: string) => message },
    messages
  );
const children = (element: Element): Element[] =>
  element.props.children.filter((child): child is Element => !!child);
const slot = (tree: Element, component: string): Element | undefined =>
  children(tree).find((cell) =>
    children(cell).some((child) => child.type === component)
  );

describe('Library Requesters above Last Active positions', () => {
  for (const [active, requested] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ])
    it(`keeps assigned positions with Last Active=${active}, Requesters=${requested}`, () => {
      const tree = render({
        ...item,
        lastActiveUsers: active ? item.lastActiveUsers : [],
        requesters: requested ? item.requesters : [],
      });
      const lastActive = slot(tree, 'LastActiveAvatarStack');
      const requesters = slot(tree, 'RequesterAvatarStack');
      assert.equal(!!lastActive, active);
      assert.equal(!!requesters, requested);
      if (lastActive)
        assert.match(
          String(lastActive.props.className),
          /col-start-1 row-start-2/
        );
      if (requesters)
        assert.match(
          String(requesters.props.className),
          /col-start-1 row-start-1/
        );
      assert.match(
        String(slot(tree, 'AvatarStack')?.props.className),
        /col-start-2 row-start-1/
      );
      assert.match(
        String(slot(tree, 'WatchedChipGroup')?.props.className),
        /col-start-2 row-start-2/
      );
    });

  it('passes original user groups, activity time and watched percentages unchanged', () => {
    const tree = render(item);
    for (const [component, prop, expected] of [
      ['LastActiveAvatarStack', 'users', item.lastActiveUsers],
      ['RequesterAvatarStack', 'requesters', item.requesters],
      ['AvatarStack', 'users', item.watchlistUsers],
      ['WatchedChipGroup', 'users', item.watchedUsers],
    ] as const) {
      const child = children(slot(tree, component)!).find(
        (node) => node.type === component
      )!;
      assert.equal(child.props[prop], expected);
      if (component === 'LastActiveAvatarStack')
        assert.equal(child.props.lastActiveAt, item.lastActiveAt);
    }
  });

  it('retains icon styling, tooltip labels and keyboard focus without new UI', () => {
    const tree = render(item);
    for (const [component, icon, label] of [
      ['LastActiveAvatarStack', 'ClockIcon', 'Last active'],
      ['RequesterAvatarStack', 'FolderArrowDownIcon', 'Requesters'],
    ]) {
      const cell = slot(tree, component)!;
      assert.match(
        String(cell.props.className),
        /flex h-7 w-fit.*flex-nowrap items-center gap-2/
      );
      const tooltip = children(cell)[0];
      assert.equal(tooltip.type, 'Tooltip');
      assert.equal(tooltip.props.content, label);
      const span = children(tooltip)[0];
      assert.equal(span.props['aria-label'], label);
      assert.equal(span.props.tabIndex, 0);
      assert.match(String(span.props.className), /h-4 w-4.*text-slate-300/);
      assert.equal(children(span)[0].type, icon);
      assert.equal(children(span)[0].props.className, 'h-4 w-4');
    }
  });

  it('preserves the existing two-column container and empty visibility', () => {
    const tree = render({
      ...item,
      lastActiveUsers: [],
      requesters: [],
      watchlistUsers: [],
      watchedUsers: [],
    });
    assert.equal(children(tree).length, 0);
    assert.equal(
      tree.props.className,
      'grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] content-center items-center gap-x-3 gap-y-3'
    );
  });
});
