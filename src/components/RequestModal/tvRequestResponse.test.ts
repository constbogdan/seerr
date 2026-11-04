import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual component handlers with isolated transport/UI dependencies.
// AST extraction avoids duplicating their response or season-selection logic.
const source = ts.createSourceFile(
  'TvRequestModal.tsx',
  readFileSync(path.join(__dirname, 'TvRequestModal.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
function handler(name: string, context: Record<string, unknown>) {
  let expression: string | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name)
      expression = node.initializer?.getText(source);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, name);
  const compiled = ts.transpileModule(
    `const handler = ${expression}; handler;`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.React,
      },
    }
  ).outputText;
  return vm.runInNewContext(compiled, context) as (
    approve?: boolean
  ) => Promise<void>;
}
function fixture(
  status: number,
  data: unknown = { message: 'Already covered' }
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const toasts: { appearance: string }[] = [];
  const updates: boolean[] = [];
  const completed: unknown[] = [];
  const selected = Object.freeze([3, 2]);
  const request =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return { status, data };
    };
  const context = {
    axios: {
      post: request('post'),
      put: request('put'),
      delete: request('delete'),
    },
    React: { createElement: () => 'Rendered toast' },
    settings: { currentSettings: { partialRequestsEnabled: true } },
    requestOverrides: null,
    initialSeasonNumber: undefined,
    initialSeasonRequestable: true,
    visibleSeasonNumbers: undefined,
    selectedSeasons: [3, 2],
    validatedSelectedSeasons: selected,
    data: { id: 123, name: 'Synthetic show', externalIds: { tvdbId: 456 } },
    tvdbId: undefined,
    is4k: false,
    editRequest: { id: 7 },
    MediaStatus: { PENDING: 2 },
    getAllSeasons: () => [1, 2, 3],
    getAllRequestedSeasons: () => [1],
    messages: {},
    intl: { formatMessage: () => 'Synthetic message' },
    mutate: () => undefined,
    addToast: (_message: unknown, options: { appearance: string }) =>
      toasts.push(options),
    onUpdating: (value: boolean) => updates.push(value),
    onComplete: (value: unknown) => completed.push(value),
  };
  return { context, calls, toasts, updates, completed, selected };
}

it('POST 202 is informational, preserves validated selection and never reports success', async () => {
  const f = fixture(202);
  await handler('sendRequest', f.context)();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'post');
  const body = f.calls[0].args[1] as { seasons: number[] };
  assert.deepEqual(Array.from(body.seasons), [2, 3]);
  assert.deepEqual(f.selected, [3, 2]);
  assert.deepEqual(f.completed, []);
  assert.deepEqual(
    f.toasts.map((toast) => toast.appearance),
    ['info']
  );
  assert.deepEqual(f.updates, [true, false]);
});

it('PUT 202 returns before approval, completion or a success toast and releases updating state', async () => {
  const f = fixture(202);
  await handler('updateRequest', f.context)(true);
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ['put']
  );
  assert.deepEqual(f.completed, []);
  assert.deepEqual(
    f.toasts.map((toast) => toast.appearance),
    ['info']
  );
  assert.deepEqual(f.updates, [true, false]);
});

it('ordinary TV creation and edit approval retain successful completion', async () => {
  const create = fixture(201, { media: { status: 3 } });
  await handler('sendRequest', create.context)();
  assert.deepEqual(create.completed, [3]);
  assert.deepEqual(
    create.toasts.map((toast) => toast.appearance),
    ['success']
  );
  const edit = fixture(200);
  await handler('updateRequest', edit.context)(true);
  assert.deepEqual(
    edit.calls.map((call) => call.method),
    ['put', 'post']
  );
  assert.equal(edit.calls[1].args[0], '/api/v1/request/7/approve');
  assert.deepEqual(edit.completed, [2]);
});

it('invalid or hidden season submission guards still suppress transport', async () => {
  for (const override of [
    { initialSeasonNumber: 2, initialSeasonRequestable: false },
    { validatedSelectedSeasons: [] },
    {
      visibleSeasonNumbers: [2],
      settings: { currentSettings: { partialRequestsEnabled: false } },
    },
  ]) {
    const f = fixture(202);
    await handler('sendRequest', { ...f.context, ...override })();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.completed, []);
  }
});
