import {
  ArrowDownTrayIcon,
  ServerIcon,
  ServerStackIcon,
} from '@heroicons/react/24/solid';
import { MediaStatus } from '@server/constants/media';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import ActionStateGrid, { type TitleCardOverlayItem } from './ActionStateGrid';
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
let region = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer)
    declarations.set(
      node.name.getText(syntax),
      node.initializer.getText(syntax)
    );
  if (ts.isJsxExpression(node) && node.expression) {
    const expression = node.expression.getText(syntax);
    if (
      expression.includes('data-testid="title-card-request-region"') &&
      (!region || expression.length < region.length)
    )
      region = expression;
  }
  ts.forEachChild(node, visit);
}
visit(syntax);
assert.ok(
  region,
  'The test must execute the actual lower-right TitleCard JSX.'
);
const nativeRequire = createRequire(__filename);
const modules = new Map<string, unknown>();
function loadComponent(relativePath: string): unknown {
  if (modules.has(relativePath)) return modules.get(relativePath);
  const exports = {};
  const output = ts.transpileModule(
    readFileSync(path.join(__dirname, relativePath), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }
  ).outputText;
  runInNewContext(output, {
    exports,
    require: (id: string) =>
      id === '@app/components/Common/Button'
        ? {
            __esModule: true,
            default: loadComponent('../Common/Button/index.tsx'),
          }
        : nativeRequire(id),
  });
  const component = (exports as { default: unknown }).default;
  modules.set(relativePath, component);
  return component;
}
const RequestIconButton = loadComponent('../Common/RequestIconButton.tsx');
// Read the real exported style token rather than reproducing its square styling.
const styleDeclaration = readFileSync(
  path.join(__dirname, '../Common/RequestIconButton.tsx'),
  'utf8'
).match(/export const requestIconButtonClassName =\s*'([^']+)'/);
assert.ok(styleDeclaration);
const globalMessages = Object.fromEntries(
  [
    'processing',
    'notrequested',
    'requested',
    'deleted',
    'partiallyavailable',
    'available',
  ].map((key) => [key, key])
);
const compiled = ts.transpileModule(
  `
  export default function render(context) {
    const { mediaType, currentStatus, cornerAction, persistentMetadata,
      actionsDisabled, showRequestButton, requestActionEnabled, requestActionAlwaysVisible, image, showDetail,
      showRequestModal, requestActionIcon, requestActionClassName, inProgress,
      setShowRequestModal } = context;
    const intl = { formatMessage: value => value };
    const messages = { watched: 'Watched' };
    const resolvedRequestActionLabel = 'Request';
    const stateIndicators = buildTitleCardStateIndicators(context);
    const hideBlocklistPresentation = ${declarations.get('hideBlocklistPresentation')};
    const useLowerRightStatus = ${declarations.get('useLowerRightStatus')};
    const lowerRightStatus = ${declarations.get('lowerRightStatus')};
    const lowerRightStatusIcon = ${declarations.get('lowerRightStatusIcon')};
    const canRequestTitle = ${declarations.get('canRequestTitle')};
    const rightSideStates = ${declarations.get('rightSideStates')};
    return { region: ${region}, canRequestTitle, icon: lowerRightStatusIcon,
      states: rightSideStates };
  }`,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }
).outputText;
type Result = {
  region: ReactElement | false;
  canRequestTitle: boolean;
  icon: ReactElement;
  states: TitleCardOverlayItem[];
};
const fixture: { default?: (context: object) => Result } = {};
runInNewContext(compiled, {
  exports: fixture,
  require: nativeRequire,
  MediaStatus,
  globalMessages,
  ArrowDownTrayIcon,
  ServerIcon,
  ServerStackIcon,
  buildTitleCardStateIndicators,
  RequestIconButton,
  requestIconButtonClassName: styleDeclaration[1],
  twMerge: nativeRequire('tailwind-merge').twMerge,
  Fragment: nativeRequire('react').Fragment,
  Transition: ({
    show,
    children,
  }: {
    show: boolean;
    children: ReactElement;
  }) => (show ? children : null),
  Tooltip: ({ children }: { children: ReactElement }) => children,
  StatusBadgeMini: ({ label }: { label?: string }) =>
    createElement('span', { 'aria-label': label }),
});
const render = (overrides: Record<string, unknown> = {}) =>
  fixture.default!({
    mediaType: 'movie',
    currentStatus: MediaStatus.UNKNOWN,
    actionsDisabled: false,
    showRequestButton: true,
    image: '/poster.jpg',
    showDetail: false,
    showRequestModal: false,
    requestActionAlwaysVisible: false,
    inProgress: false,
    setShowRequestModal: () => {},
    ...overrides,
  });
const markup = (result: Result) =>
  renderToStaticMarkup(result.region || createElement('span'));
function action(
  node: unknown
): ReactElement<{ onClick: (event: object) => void }> | undefined {
  if (!isValidElement<{ children?: unknown }>(node)) return;
  if (node.type === RequestIconButton) return node as ReturnType<typeof action>;
  for (const child of [node.props.children].flat(Infinity)) {
    const found = action(child);
    if (found) return found;
  }
}

describe('TitleCard lower-right status/action presentation', () => {
  it('opts dedicated Collections into visibility only, preserving the original button and callback', () => {
    for (const currentStatus of [
      MediaStatus.UNKNOWN,
      MediaStatus.PARTIALLY_AVAILABLE,
      MediaStatus.AVAILABLE,
    ]) {
      let opened = 0;
      let prevented = 0;
      const context = {
        mediaType: 'collection',
        actionsDisabled: true,
        requestActionEnabled: true,
        currentStatus,
        requestActionIcon: createElement('svg', { 'data-original-icon': true }),
        requestActionClassName: 'existing-state-class',
        setShowRequestModal: () => opened++,
      };
      assert.equal(markup(render(context)), '');
      const visible = render({ ...context, requestActionAlwaysVisible: true });
      const html = markup(visible);
      assert.equal((html.match(/<button/g) ?? []).length, 1);
      assert.match(html, /data-original-icon/);
      assert.match(html, /existing-state-class/);
      assert.match(html, /!h-8 !w-8/);
      assert.match(html, /bg-gray-900\/90/);
      assert.match(html, /row-start-3 self-end justify-self-end/);
      action(visible.region)!.props.onClick({
        preventDefault: () => prevented++,
        stopPropagation: () => prevented++,
      });
      assert.equal(opened, 1);
      assert.equal(prevented, 2);
      assert.equal(
        render({
          ...context,
          requestActionAlwaysVisible: true,
          showRequestButton: false,
        }).canRequestTitle,
        false
      );
      assert.equal(
        render({
          ...context,
          requestActionAlwaysVisible: true,
          showRequestButton: false,
        }).region,
        false
      );
      assert.equal(
        render({
          ...context,
          requestActionAlwaysVisible: true,
          requestActionEnabled: false,
        }).region,
        false
      );
    }
    assert.match(source, /requestActionAlwaysVisible = false/);
  });
  for (const [status, Icon, color] of [
    [MediaStatus.UNKNOWN, ArrowDownTrayIcon, 'purple'],
    [MediaStatus.PENDING, ArrowDownTrayIcon, 'orange'],
    [MediaStatus.PROCESSING, ArrowDownTrayIcon, 'blue'],
    [MediaStatus.DELETED, ArrowDownTrayIcon, 'red'],
    [MediaStatus.PARTIALLY_AVAILABLE, ServerIcon, 'green'],
    [MediaStatus.AVAILABLE, ServerStackIcon, 'green'],
  ] as const) {
    it(`renders the single persistent approved icon for ${MediaStatus[status]}`, () => {
      for (const mediaType of ['movie', 'tv']) {
        const result = render({ mediaType, currentStatus: status });
        assert.equal(result.icon.type, Icon);
        const html = markup(result);
        assert.match(html, new RegExp(`text-${color}-400`));
        assert.equal((html.match(/<svg/g) ?? []).length, 1);
        assert.equal(
          (html.match(/title-card-request-region/g) ?? []).length,
          1
        );
        assert.match(html, /bg-gray-900\/90/);
        assert.match(html, /!h-8 !w-8/);
        assert.match(html, /!p-1\.5/);
        assert.match(html, /row-start-3 self-end justify-self-end/);
        assert.equal(result.states.length, 0);
      }
    });
  }
  it('keeps existing requestable and removed actions and adds only partial availability', () => {
    for (const currentStatus of [
      MediaStatus.UNKNOWN,
      MediaStatus.DELETED,
      MediaStatus.PARTIALLY_AVAILABLE,
    ]) {
      for (const mediaType of ['movie', 'tv']) {
        let opened = false;
        let prevented = 0;
        const result = render({
          mediaType,
          currentStatus,
          setShowRequestModal: (show: boolean) => {
            opened = show;
          },
        });
        assert.equal(result.canRequestTitle, true);
        action(result.region)!.props.onClick({
          preventDefault: () => prevented++,
          stopPropagation: () => prevented++,
        });
        assert.equal(opened, true);
        assert.equal(prevented, 2);
      }
    }
  });
  it('leaves requested, acquiring and fully available informational and non-clickable', () => {
    for (const currentStatus of [
      MediaStatus.PENDING,
      MediaStatus.PROCESSING,
      MediaStatus.AVAILABLE,
    ]) {
      const result = render({ currentStatus });
      assert.equal(result.canRequestTitle, false);
      assert.equal(action(result.region), undefined);
      assert.doesNotMatch(markup(result), /<button|tabindex|href=/);
      assert.match(markup(result), /role="img"/);
      assert.match(markup(result), /pointer-events-none/);
    }
  });
  it('respects permissions, disabled cards and explicit request overrides for partial availability', () => {
    for (const guard of [
      { showRequestButton: false },
      { actionsDisabled: true },
      { requestActionEnabled: false },
    ]) {
      const result = render({
        currentStatus: MediaStatus.PARTIALLY_AVAILABLE,
        ...guard,
      });
      assert.equal(result.canRequestTitle, false);
      assert.equal(action(result.region), undefined);
      assert.match(markup(result), /role="img"/);
    }
    assert.equal(
      render({
        currentStatus: MediaStatus.PROCESSING,
        requestActionEnabled: true,
      }).canRequestTitle,
      true
    );
  });
  it('preserves Watched content and its original grid coordinates with no empty media-state slot', () => {
    const result = render({
      currentStatus: MediaStatus.AVAILABLE,
      watchState: 'watched',
    });
    assert.deepEqual(
      Array.from(result.states, (item) => item.id),
      ['watched']
    );
    const html = renderToStaticMarkup(
      createElement(ActionStateGrid, { actions: [], states: result.states })
    );
    assert.match(
      html,
      /data-state-slot="watched"[^>]*grid-column:1;grid-row:2/
    );
    assert.doesNotMatch(html, /data-state-slot="availability"/);
    assert.equal(render({ watchState: 'watched' }).states[0].row, 1);
  });
  it('preserves download precedence using the blue pulsing acquisition icon', () => {
    for (const currentStatus of [
      MediaStatus.AVAILABLE,
      MediaStatus.DELETED,
      MediaStatus.BLOCKLISTED,
    ]) {
      const result = render({ currentStatus, inProgress: true });
      assert.equal(result.icon.type, ArrowDownTrayIcon);
      assert.match(markup(result), /animate-pulse text-blue-400/);
      assert.equal(result.states.length, 0);
    }
  });
  it('keeps Blocklist presentation hidden without changing its request restriction', () => {
    const result = render({ currentStatus: MediaStatus.BLOCKLISTED });
    assert.ok(!result.region);
    assert.equal(result.canRequestTitle, false);
    assert.equal(result.states.length, 0);
  });
  it('leaves collection-level and specialized cards on their existing hover-only path', () => {
    for (const variant of [
      { mediaType: 'collection' },
      { cornerAction: createElement('span') },
      { persistentMetadata: createElement('span') },
    ]) {
      assert.equal(markup(render(variant)), '');
      const available = render({
        ...variant,
        currentStatus: MediaStatus.AVAILABLE,
      });
      assert.equal(available.region, false);
      assert.equal(available.states.length, 1);
      assert.equal(
        render({ ...variant, currentStatus: MediaStatus.PARTIALLY_AVAILABLE })
          .canRequestTitle,
        false
      );
    }
  });
});
