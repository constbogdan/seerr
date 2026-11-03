import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const modal = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');

const consumers = [
  '../../RequestModal/MovieRequestModal.tsx',
  '../../RequestModal/TvRequestModal.tsx',
  '../../RequestModal/CollectionRequestModal.tsx',
  '../../Library/index.tsx',
  '../../LeavingSoon/index.tsx',
  '../../Settings/SettingsRemoval/index.tsx',
  '../../Settings/SettingsJobsCache/index.tsx',
].map((file) => readFileSync(path.join(__dirname, file), 'utf8'));

describe('shared Modal accessibility contract', () => {
  it('uses instance-unique title and description relationships', () => {
    assert.match(modal, /const generatedId = useId\(\)/);
    assert.match(modal, /aria-labelledby=\{title \|\| subTitle \? titleId/);
    assert.match(
      modal,
      /aria-describedby=\{title && subTitle \? descriptionId/
    );
    assert.doesNotMatch(modal, /id="modal-headline"/);
  });

  it('contains keyboard focus, supports Escape, and restores the trigger', () => {
    assert.match(modal, /event\.key === 'Escape'/);
    assert.match(modal, /event\.key !== 'Tab'/);
    assert.match(
      modal,
      /modalRef\.current\.contains\(document\.activeElement\)/
    );
    assert.match(
      modal,
      /originatingElement\.focus\(\{ preventScroll: true \}\)/
    );
    assert.match(modal, /modalStack\.at\(-1\) !== token/);
  });

  it('gives shared consumers the corrected behavior without page wrappers', () => {
    consumers.forEach((source) => {
      assert.match(source, /components\/Common\/Modal/);
      assert.match(source, /<Modal/);
    });
  });
});
