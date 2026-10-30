import type { LibraryLastActiveUser } from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { libraryLastActiveTooltip } from './presentation';

const source = ts.createSourceFile(
  'LibraryEngagement.tsx',
  readFileSync(path.join(__dirname, 'LibraryEngagement.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
let component: ts.VariableDeclaration | undefined;
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === 'LastActiveAvatarStack'
  )
    component = node;
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(component);
interface Element {
  type: string;
  props: { children: unknown[]; [key: string]: unknown };
}
const flatten = (root: unknown): Element[] =>
  Array.isArray(root)
    ? root.flatMap(flatten)
    : root && typeof root === 'object' && 'props' in root
      ? [root as Element, ...(root as Element).props.children.flatMap(flatten)]
      : [];
function render(users: LibraryLastActiveUser[]) {
  const calls: unknown[][] = [];
  const fixture = { exports: undefined as unknown };
  runInNewContext(
    ts.transpileModule(
      `${component!.getText(source)}; module.exports = LastActiveAvatarStack;`,
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
      Tooltip: 'Tooltip',
      UserAvatar: 'UserAvatar',
      useIntl: () => ({
        formatDate: (...args: unknown[]) => {
          calls.push(args);
          return 'Oct 29, 4:16 PM';
        },
        formatMessage: (message: string) => message,
      }),
      parseFactualDate: (value: string) => new Date(value),
      messages: { partialActivity: 'Partial', watchedActivity: 'Watched' },
      libraryLastActiveTooltip,
    }
  );
  const tree = (fixture.exports as (props: object) => Element)({
    users,
    lastActiveAt: '2026-10-29T13:16:00Z',
    ariaLabel: 'Last active users',
  });
  return { tree, elements: flatten(tree), calls };
}
const user: LibraryLastActiveUser = {
  id: 1,
  displayName: 'Viewer',
  avatar: '/avatar',
};

describe('Existing Library Last Active tooltip Episode context', () => {
  it('includes a known Episode title or coordinates only, retaining user and timestamp', () => {
    assert.equal(
      libraryLastActiveTooltip('Viewer', 'Oct 29, 4:16 PM', {
        seasonNumber: 2,
        episodeNumber: 3,
        title: 'Episode Title',
      }),
      'Viewer · S02E03 — Episode Title · Oct 29, 4:16 PM'
    );
    assert.equal(
      libraryLastActiveTooltip('Viewer', 'Oct 29, 4:16 PM', {
        seasonNumber: 1,
        episodeNumber: 4,
      }),
      'Viewer · S01E04 · Oct 29, 4:16 PM'
    );
    assert.equal(
      libraryLastActiveTooltip('Viewer', 'Oct 29, 4:16 PM'),
      'Viewer · Oct 29, 4:16 PM'
    );
    assert.equal(libraryLastActiveTooltip('Viewer'), 'Viewer');
  });
  for (const classification of ['partial', 'watched'] as const)
    it(`uses the actual avatar component to render ${classification} accessibly without new layout`, () => {
      const { tree, elements, calls } = render([
        {
          ...user,
          episode: { seasonNumber: 1, episodeNumber: 4, classification },
        },
      ]);
      const expected = `Viewer · S01E04 · ${classification === 'partial' ? 'Partial' : 'Watched'} · Oct 29, 4:16 PM`;
      const tooltip = elements.find((e) => e.type === 'Tooltip')!;
      assert.equal(tooltip.props.content, expected);
      assert.equal(tree.props.className, 'flex -space-x-1');
      const focus = elements.find((e) => e.props['aria-label'] === expected)!;
      assert.equal(focus.props.className, 'inline-flex h-7');
      assert.equal(focus.props.tabIndex, 0);
      const avatar = elements.find((e) => e.type === 'UserAvatar')!;
      assert.equal((avatar.props.user as LibraryLastActiveUser).id, user.id);
      assert.equal(
        (avatar.props.user as LibraryLastActiveUser).avatar,
        user.avatar
      );
      assert.equal(avatar.props.showTooltip, false);
      assert.equal(
        JSON.stringify(tooltip.props.tooltipConfig),
        JSON.stringify({ trigger: ['hover', 'focus'] })
      );
      assert.equal(calls.length, 1);
      assert.equal(
        JSON.stringify(calls[0][1]),
        JSON.stringify({ dateStyle: 'medium', timeStyle: 'short' })
      );
    });
  it('retains overflow avatars and Episode context for each user without borrowing activity', () => {
    const users = Array.from({ length: 6 }, (_, id) => ({
      ...user,
      id,
      episode: { seasonNumber: 1, episodeNumber: id + 1 },
    }));
    const { elements } = render(users);
    assert.equal(elements.filter((e) => e.type === 'UserAvatar').length, 5);
    const overflowTooltip = elements.find(
      (e) => e.type === 'Tooltip' && typeof e.props.content === 'object'
    );
    assert.ok(overflowTooltip, 'Overflow users must retain their tooltip');
    assert(
      flatten(overflowTooltip.props.content).some((e) =>
        e.props.children.includes('Viewer · S01E06 · Oct 29, 4:16 PM')
      )
    );
    const plain = render([user]);
    assert.equal(
      plain.elements.find((e) => e.type === 'Tooltip')!.props.content,
      'Viewer · Oct 29, 4:16 PM'
    );
  });
});
