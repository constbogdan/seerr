import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const item = readFileSync(path.join(__dirname, 'LibraryItem.tsx'), 'utf8');
const detail = readFileSync(path.join(__dirname, 'SeriesDetail.tsx'), 'utf8');
const actions = readFileSync(
  path.join(__dirname, 'useLibraryIndividualActions.ts'),
  'utf8'
);

describe('Library individual mutation state', () => {
  it('shares one pending key across Schedule, Cancel and Remove for a card', () => {
    assert.match(item, /const targetActionPending = isPending\('target'\)/);
    assert.ok((item.match(/key: 'target'/g) ?? []).length >= 3);
    assert.ok(
      (item.match(/disabled=\{targetActionPending\}/g) ?? []).length >= 3
    );
  });

  it('isolates pending state by expanded Season target', () => {
    assert.match(
      detail,
      /const actionKey = `season:\$\{season\.seasonNumber\}`/
    );
    assert.match(detail, /const actionPending = isPending\(actionKey\)/);
    assert.ok((detail.match(/key: actionKey/g) ?? []).length >= 3);
    assert.ok((detail.match(/disabled=\{actionPending\}/g) ?? []).length >= 3);
  });

  it('reports mutation and refresh failures separately and fences stale UI', () => {
    assert.match(actions, /getServerErrorMessage/);
    assert.match(actions, /actionCompleted[\s\S]*messages\.refreshFailed/);
    assert.match(actions, /operationScope !== currentScopeRef\.current/);
    assert.match(actions, /mountedRef\.current/);
    assert.match(actions, /autoDismiss: false/);
  });
});
