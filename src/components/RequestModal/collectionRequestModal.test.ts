import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getCollectionBackdropUrl } from './collectionRequestPresentation';

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

  it('keeps submission disabled when no collection Movies are eligible or selected', () => {
    assert.match(
      source,
      /okDisabled=\{isUpdating \|\| selectedParts\.length === 0\}/
    );
    assert.match(source, /getAllRequestedParts\(\)\.includes\(tmdbId\)/);
    assert.match(source, /MediaStatus\.BLOCKLISTED/);
    assert.match(source, /currentlyRemaining <= 0/);
  });

  it('only constructs a normalized collection backdrop URL when artwork exists', () => {
    assert.equal(getCollectionBackdropUrl(undefined), undefined);
    assert.equal(getCollectionBackdropUrl(null), undefined);
    assert.equal(
      getCollectionBackdropUrl('/backdrop.jpg'),
      'https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/backdrop.jpg'
    );
    assert.equal(
      getCollectionBackdropUrl('backdrop.jpg'),
      'https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/backdrop.jpg'
    );
    assert.equal(
      (source.match(/backdrop=\{collectionBackdrop\}/g) ?? []).length,
      2
    );
    assert.doesNotMatch(
      source,
      /backdrop=\{`https:\/\/image\.tmdb\.org\/t\/p\/w1920_and_h800_multi_faces\/\$\{data\?\.backdropPath\}`\}/
    );
  });
});
