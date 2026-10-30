import { MediaStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { getCollectionAvailability } from './collectionAvailability';

// The test runner uses server/tsconfig.json, which has no @app alias.
const { getCollectionCardActionPresentation } = createRequire(__filename)(
  path.join(__dirname, '../Collections/cardAction')
) as {
  getCollectionCardActionPresentation: (state: string) => {
    icon: string;
    className: string;
  };
};

const text = readFileSync(path.join(__dirname, 'LibraryItem.tsx'), 'utf8');
const source = ts.createSourceFile(
  'LibraryItem.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let banner: ts.VariableDeclaration | undefined;
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'LibraryCollectionBanner'
  )
    banner = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(banner);
interface Element {
  type: string;
  props: { children: unknown[]; [key: string]: unknown };
}
const flatten = (root: unknown): Element[] =>
  root && typeof root === 'object' && 'props' in root
    ? [root as Element, ...(root as Element).props.children.flatMap(flatten)]
    : [];
function render(
  available: number | undefined,
  total = 3,
  canRequest = true,
  error = false
) {
  const callback = () => undefined;
  const fixture = { exports: undefined as unknown };
  const components = [
    'CachedImage',
    'Link',
    'Tooltip',
    'RequestIconButton',
    'SquaresPlusIcon',
    'Squares2X2Icon',
  ];
  runInNewContext(
    ts.transpileModule(
      `${banner!.getText(source)}; module.exports = LibraryCollectionBanner;`,
      { compilerOptions: { jsx: ts.JsxEmit.React } }
    ).outputText,
    {
      module: fixture,
      React: {
        createElement: (
          type: string,
          props: object | null,
          ...children: unknown[]
        ) => ({ type, props: { ...props, children } }),
      },
      ...Object.fromEntries(components.map((name) => [name, name])),
      useIntl: () => ({ formatMessage: () => 'Request Collection' }),
      messages: {},
      useInView: () => ({ ref: null, inView: true }),
      useSWR: () => ({
        data:
          available === undefined
            ? undefined
            : {
                parts: Array.from({ length: total }, (_, id) => ({
                  id,
                  mediaInfo: {
                    status:
                      id < available
                        ? MediaStatus.AVAILABLE
                        : MediaStatus.UNKNOWN,
                  },
                })),
              },
        error,
      }),
      getCollectionAvailability,
      formatCollectionAvailability: (value?: {
        available: number;
        total: number;
      }) => (value ? `${value.available}/${value.total}` : undefined),
      getCollectionCardActionPresentation,
    }
  );
  const tree = (fixture.exports as (props: object) => Element)({
    collection: { id: 1, name: 'Fixture' },
    canRequest,
    onRequest: callback,
  });
  return { tree, elements: flatten(tree), callback };
}

describe('Library Collection request presentation parity', () => {
  for (const [available, total, state] of [
    [0, 3, 'incomplete'],
    [1, 2, 'incomplete'],
    [1, 3, 'incomplete'],
    [3, 3, 'complete'],
    [undefined, 3, 'unknown'],
  ] as const)
    it(`uses the Collections page visual mapping for ${available}/${total}`, () => {
      const { tree, elements, callback } = render(available, total);
      const button = elements.find(
        (element) => element.type === 'RequestIconButton'
      );
      assert.ok(button);
      const reference = getCollectionCardActionPresentation(state);
      assert.equal((button.props.icon as Element).type, reference.icon);
      assert.equal((button.props.icon as Element).props.className, 'h-4 w-4');
      assert.equal(
        button.props.className,
        `!h-8 !w-8 !p-1.5 ${reference.className}`
      );
      assert.equal(button.props.onClick, callback);
      assert.equal(button.props['aria-label'], 'Request Collection');
      assert.equal(button.props.disabled, undefined);
      assert.doesNotMatch(
        String(tree.props.className),
        /(?:^|\s)(?:opacity-0|group-hover:[^\s]+|hidden)(?:\s|$)/
      );
      assert.doesNotMatch(
        String(button.props.className),
        /(?:^|\s)(?:opacity-0|group-hover:[^\s]+|hidden)(?:\s|$)/
      );
      assert.match(String(tree.props.className), /h-16 w-full.*max-w-80/);
      const count = elements.find(
        (element) =>
          element.props['data-testid'] === 'library-collection-availability'
      )!;
      assert.equal(
        count.props.children[0],
        available === undefined ? '\u00a0' : `${available}/${total}`
      );
    });
  it('preserves the permission gate and does not add a second request action', () => {
    assert.equal(
      render(1, 3, false).elements.filter(
        (element) => element.type === 'RequestIconButton'
      ).length,
      0
    );
    assert.equal(
      render(1).elements.filter(
        (element) => element.type === 'RequestIconButton'
      ).length,
      1
    );
  });
  it('fails back to the reference unknown presentation on a read failure, without disabling the existing callback', () => {
    const { elements, callback } = render(3, 3, true, true);
    const button = elements.find(
      (element) => element.type === 'RequestIconButton'
    )!;
    assert.equal((button.props.icon as Element).type, 'Squares2X2Icon');
    assert.equal(button.props.onClick, callback);
    assert.match(String(button.props.className), /text-gray-300/);
  });
  it('retains the real shared native button and existing event suppression/modal callback', () => {
    const shared = readFileSync(
      path.join(__dirname, '../Common/RequestIconButton.tsx'),
      'utf8'
    );
    const native = readFileSync(
      path.join(__dirname, '../Common/Button/index.tsx'),
      'utf8'
    );
    assert.match(shared, /<Button/);
    assert.match(native, /<button/);
    assert.match(text, /canRequest=\{canRequestMovie\}/);
    assert.match(
      text,
      /event.preventDefault\(\);\s+event.stopPropagation\(\);\s+openRequestModal\(\{\s+type: 'collection'/
    );
  });
});
