import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const text = readFileSync(path.join(__dirname, 'LibraryItem.tsx'), 'utf8');
const source = ts.createSourceFile(
  'LibraryItem.tsx',
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let column: ts.JsxElement | undefined;
const constants: string[] = [];
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    [
      'metadataColumnClassName',
      'metadataRowClassName',
      'metadataIconSlotClassName',
    ].includes(node.name.getText(source))
  )
    constants.push(`const ${node.getText(source)};`);
  if (
    ts.isJsxElement(node) &&
    node.openingElement.attributes.getText(source) ===
      'className={metadataColumnClassName}' &&
    node.getText(source).includes('<HandThumbUpIcon')
  )
    column = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(column, 'Production metadata preference column must exist');
interface Element {
  type: string;
  props: { children: unknown[]; [key: string]: unknown };
}
const moduleFixture = { exports: undefined as unknown };
runInNewContext(
  ts.transpileModule(
    `${constants.join('\n')} module.exports = (item, intl, messages) => (${column.getText(source)});`,
    { compilerOptions: { jsx: ts.JsxEmit.React } }
  ).outputText,
  {
    module: moduleFixture,
    React: {
      createElement: (
        type: string,
        props: object | null,
        ...children: unknown[]
      ) => ({ type, props: { ...props, children } }),
    },
    ...Object.fromEntries(
      ['HandThumbUpIcon', 'HandThumbDownIcon'].map((name) => [name, name])
    ),
  }
);
const render = (
  mediaType: 'movie' | 'series',
  counts: { likedUserCount?: number | null; dislikedUserCount?: number | null }
): Element =>
  (moduleFixture.exports as (...args: unknown[]) => Element)(
    { mediaType, ...counts },
    {
      formatMessage: (message: string, { count }: { count: number }) =>
        `${message}: ${count}`,
    },
    { likes: 'Likes', dislikes: 'Dislikes' }
  );
const rows = (element: Element) => element.props.children as Element[];
const icon = (row: Element) =>
  (row.props.children[0] as Element).props.children[0] as Element;

describe('Library compact metadata preferences', () => {
  for (const mediaType of ['movie', 'series'] as const)
    for (const counts of [
      {},
      { likedUserCount: undefined, dislikedUserCount: undefined },
      { likedUserCount: null, dislikedUserCount: null },
      { likedUserCount: 0, dislikedUserCount: 0 },
      { likedUserCount: 1, dislikedUserCount: 0 },
      { likedUserCount: 0, dislikedUserCount: 1 },
      { likedUserCount: 3, dislikedUserCount: 2 },
    ])
      it(`renders fixed solid Like/Dislike rows for ${mediaType} ${JSON.stringify(counts)}, without avatars or tooltips`, () => {
        const tree = render(mediaType, counts);
        assert.match(
          String(tree.props.className),
          /grid-rows-\[1\.25rem_1\.25rem\]/
        );
        assert.equal(rows(tree).length, 2);
        rows(tree).forEach((row, index) => {
          const count =
            (index ? counts.dislikedUserCount : counts.likedUserCount) ?? 0;
          assert.equal(row.type, 'span');
          assert.match(String(row.props.className), /h-5/);
          assert.equal(
            row.props['aria-label'],
            `${index ? 'Dislikes' : 'Likes'}: ${count}`
          );
          assert.equal(icon(row).type, `HandThumb${index ? 'Down' : 'Up'}Icon`);
          assert.match(
            String(icon(row).props.className),
            count
              ? index
                ? /text-red-400/
                : /text-blue-400/
              : /text-slate-300/
          );
          assert.match(String(icon(row).props.className), /h-4 w-4/);
          const number = row.props.children[1];
          assert.equal((number as Element).type, 'span');
          assert.equal((number as Element).props.children[0], count);
        });
      });
  it('reserves a fixed preference column between dates and storage, after rating/quality', () => {
    assert.match(
      text,
      /grid-cols-\[4rem_3rem_minmax\(0,1fr\)\].*gap-x-6.*sm:gap-x-8 2xl:gap-x-4/
    );
    const grid = column!.parent;
    assert.ok(ts.isJsxElement(grid));
    const columns = grid.children.filter(ts.isJsxElement);
    assert.equal(columns.length, 3);
    assert.match(
      columns[0].getText(source),
      /item.addedAt[\s\S]*item.lastActiveAt/
    );
    assert.equal(columns[1], column);
    assert.match(
      columns[2].getText(source),
      /item.logicalSizeBytes[\s\S]*storageLabel/
    );
    assert.ok(
      text.indexOf('item.tmdbRating.voteAverage.toFixed(1)') < grid.pos
    );
    assert.ok(text.indexOf('<LibraryResolutionBadge') < grid.pos);
    assert.match(
      column!.getText(source),
      /messages.likes[\s\S]*messages.dislikes/
    );
    assert.match(
      text,
      /import \{[\s\S]*?HandThumbDownIcon,[\s\S]*?HandThumbUpIcon,[\s\S]*?\} from '@heroicons\/react\/24\/solid'/
    );
    assert.doesNotMatch(text, /HandThumb(?:Up|Down)OutlineIcon/);
    assert.match(text, /<AbsoluteDate\s+value=\{item.addedAt\}/);
    assert.match(text, /value=\{item.lastActiveAt\}/);
    assert.match(text, /<LibraryCollectionBanner/);
    assert.doesNotMatch(
      column!.getText(source),
      /Avatar|Tooltip|onClick|button/
    );
  });
});
