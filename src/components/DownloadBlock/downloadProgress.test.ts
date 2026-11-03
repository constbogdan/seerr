import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// The node:test harness cannot resolve client aliases from its server tsconfig.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import { AcquisitionPhase } from '../../../server/lib/acquisitionPhase';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import {
  isDeterminateAcquisitionPhase,
  shouldShowDownloadEta,
} from '../../utils/acquisitionPhase';
import DownloadProgress from './DownloadProgress';

describe('DownloadBlock progress presentation', () => {
  it('renders downloading byte progress as a determinate percentage', () => {
    const markup = renderToStaticMarkup(
      createElement(DownloadProgress, {
        determinate: isDeterminateAcquisitionPhase(
          AcquisitionPhase.DOWNLOADING
        ),
        progress: 43,
      })
    );

    assert.match(markup, /aria-valuenow="43"/);
    assert.match(markup, />43%<\/span>/);
    assert.match(markup, /width:43%/);
    assert.doesNotMatch(markup, /animate-pulse/);
  });

  for (const acquisitionPhase of [
    AcquisitionPhase.PROCESSING,
    AcquisitionPhase.IMPORT_PENDING,
    AcquisitionPhase.IMPORTING,
    AcquisitionPhase.FINALIZING,
  ]) {
    it(`renders ${acquisitionPhase} as indeterminate without synthetic progress`, () => {
      const markup = renderToStaticMarkup(
        createElement(DownloadProgress, {
          determinate: isDeterminateAcquisitionPhase(acquisitionPhase),
          progress: undefined,
        })
      );

      assert.match(markup, /animate-pulse/);
      assert.doesNotMatch(markup, /aria-valuenow/);
      assert.doesNotMatch(markup, /0%|100%/);
      assert.equal(
        shouldShowDownloadEta({
          acquisitionPhase,
          estimatedCompletionTime: new Date('2026-01-01T00:00:00Z'),
        }),
        false
      );
    });
  }
});
