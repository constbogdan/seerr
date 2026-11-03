import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calculateDownloadProgress,
  getAcquisitionPhaseMessage,
  isDeterminateAcquisitionPhase,
  shouldShowDownloadEta,
} from './acquisitionPhase';

describe('acquisition phase presentation', () => {
  it('maps canonical phases to stable user-facing messages', () => {
    for (const [phase, label] of [
      [AcquisitionPhase.WAITING, 'Searching / Waiting'],
      [AcquisitionPhase.DOWNLOADING, 'Downloading'],
      [AcquisitionPhase.PROCESSING, 'Processing'],
      [AcquisitionPhase.IMPORT_PENDING, 'Import Pending'],
      [AcquisitionPhase.IMPORTING, 'Importing'],
      [AcquisitionPhase.IMPORT_BLOCKED, 'Import Blocked'],
      [AcquisitionPhase.FINALIZING, 'Finalizing'],
      [AcquisitionPhase.PAUSED, 'Paused'],
      [AcquisitionPhase.DELAYED, 'Delayed'],
      [AcquisitionPhase.WARNING, 'Warning'],
      [AcquisitionPhase.FAILED, 'Failed'],
    ] as const) {
      assert.equal(getAcquisitionPhaseMessage(phase)?.defaultMessage, label);
    }
    assert.equal(getAcquisitionPhaseMessage('future-phase'), undefined);
  });

  it('derives bounded byte progress only from valid sizes', () => {
    assert.equal(calculateDownloadProgress({ size: 100, sizeLeft: 57 }), 43);
    assert.equal(calculateDownloadProgress({ size: 100, sizeLeft: 0 }), 100);
    assert.equal(
      calculateDownloadProgress({ size: 0, sizeLeft: 0 }),
      undefined
    );
    assert.equal(
      calculateDownloadProgress({ size: 100, sizeLeft: Number.NaN }),
      undefined
    );
  });

  it('classifies byte progress separately from indeterminate activity', () => {
    assert.equal(
      isDeterminateAcquisitionPhase(AcquisitionPhase.DOWNLOADING),
      true
    );
    for (const acquisitionPhase of [
      AcquisitionPhase.PROCESSING,
      AcquisitionPhase.IMPORT_PENDING,
      AcquisitionPhase.IMPORTING,
      AcquisitionPhase.FINALIZING,
    ]) {
      assert.equal(isDeterminateAcquisitionPhase(acquisitionPhase), false);
    }

    for (const acquisitionPhase of [
      AcquisitionPhase.IMPORT_BLOCKED,
      AcquisitionPhase.PAUSED,
      AcquisitionPhase.DELAYED,
      AcquisitionPhase.WARNING,
      AcquisitionPhase.FAILED,
    ]) {
      assert.equal(isDeterminateAcquisitionPhase(acquisitionPhase), true);
    }
  });

  it('does not reuse a byte-transfer ETA for processing or import phases', () => {
    const estimatedCompletionTime = new Date('2026-01-01T00:00:00Z');
    assert.equal(
      shouldShowDownloadEta({
        acquisitionPhase: AcquisitionPhase.DOWNLOADING,
        estimatedCompletionTime,
      }),
      true
    );
    for (const acquisitionPhase of [
      AcquisitionPhase.PROCESSING,
      AcquisitionPhase.IMPORT_PENDING,
      AcquisitionPhase.IMPORTING,
      AcquisitionPhase.FINALIZING,
    ]) {
      assert.equal(
        shouldShowDownloadEta({
          acquisitionPhase,
          estimatedCompletionTime,
        }),
        false
      );
    }
  });
});
