import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Collection Request modal partial outcomes', () => {
  const source = readFileSync(
    path.join(__dirname, 'CollectionRequestModal.tsx'),
    'utf8'
  );

  it('settles every title and refreshes authoritative collection state', () => {
    assert.match(source, /Promise\.allSettled/);
    assert.match(source, /classifyCollectionRequestOutcomes/);
    assert.match(source, /reconcileCollectionRequestRetryability/);
    assert.match(source, /refreshed = await retryCollection\(\)/);
    assert.doesNotMatch(source, /await Promise\.all\(\s*\(\s*data\?\.parts/);
  });

  it('keeps only retryable failed titles selected and never retries automatically', () => {
    assert.match(
      source,
      /filter\(\(\{ kind, retryable \}\) => kind === 'failed' && retryable\)/
    );
    assert.match(source, /requestActiveRef\.current/);
    assert.equal((source.match(/axios\.post<MediaRequest>/g) ?? []).length, 1);
  });

  it('renders per-title requested, already-requested, and failed outcomes', () => {
    assert.match(source, /role="status"/);
    assert.match(source, /requestOutcomeRequested/);
    assert.match(source, /requestOutcomeAlreadyRequested/);
    assert.match(source, /requestOutcomeFailed/);
    assert.match(source, /result\.retryable/);
  });
});
