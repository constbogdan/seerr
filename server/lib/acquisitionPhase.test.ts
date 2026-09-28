import {
  SERVARR_QUEUE_STATUSES,
  SERVARR_TRACKED_DOWNLOAD_STATES,
  SERVARR_TRACKED_DOWNLOAD_STATUSES,
} from '@server/api/servarr/base';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AcquisitionPhase,
  AcquisitionSafeReason,
  deriveAcquisitionState,
  type AcquisitionPhaseInput,
} from '@server/lib/acquisitionPhase';

const input = (
  overrides: Partial<AcquisitionPhaseInput> = {}
): AcquisitionPhaseInput => ({
  status: 'downloading',
  trackedDownloadStatus: 'ok',
  trackedDownloadState: 'downloading',
  sizeLeft: 500,
  ...overrides,
});

describe('deriveAcquisitionState', () => {
  it('locks the supported Servarr queue enum contract', () => {
    assert.deepEqual(SERVARR_QUEUE_STATUSES, [
      'unknown',
      'queued',
      'paused',
      'downloading',
      'completed',
      'failed',
      'warning',
      'delay',
      'downloadClientUnavailable',
      'fallback',
    ]);
    assert.deepEqual(SERVARR_TRACKED_DOWNLOAD_STATUSES, [
      'ok',
      'warning',
      'error',
    ]);
    assert.deepEqual(SERVARR_TRACKED_DOWNLOAD_STATES, [
      'downloading',
      'importBlocked',
      'importPending',
      'importing',
      'imported',
      'failedPending',
      'failed',
      'ignored',
    ]);
  });

  it('distinguishes byte download from queue-resident processing', () => {
    assert.equal(
      deriveAcquisitionState(input()).acquisitionPhase,
      AcquisitionPhase.DOWNLOADING
    );
    assert.equal(
      deriveAcquisitionState(input({ sizeLeft: 0 })).acquisitionPhase,
      AcquisitionPhase.PROCESSING
    );
  });

  for (const [trackedDownloadState, phase] of [
    ['importPending', AcquisitionPhase.IMPORT_PENDING],
    ['importing', AcquisitionPhase.IMPORTING],
    ['imported', AcquisitionPhase.FINALIZING],
    ['failedPending', AcquisitionPhase.FAILED],
    ['failed', AcquisitionPhase.FAILED],
  ] as const) {
    it(`preserves ${trackedDownloadState}`, () => {
      assert.equal(
        deriveAcquisitionState(input({ trackedDownloadState }))
          .acquisitionPhase,
        phase
      );
    });
  }

  it('gives importBlocked precedence and safely classifies low space', () => {
    const derived = deriveAcquisitionState(
      input({
        trackedDownloadState: 'importBlocked',
        trackedDownloadStatus: 'warning',
        sizeLeft: 0,
        statusMessages: [
          {
            title: 'Import failed',
            messages: ['Not enough free space on destination'],
          },
        ],
      })
    );
    assert.deepEqual(derived, {
      acquisitionPhase: AcquisitionPhase.IMPORT_BLOCKED,
      health: 'error',
      safeReason: AcquisitionSafeReason.INSUFFICIENT_SPACE,
    });
  });

  it('does not expose an unrecognized provider message', () => {
    const derived = deriveAcquisitionState(
      input({
        status: 'warning',
        trackedDownloadStatus: 'warning',
        errorMessage: 'Private path C:\\downloads\\title cannot be imported',
      })
    );
    assert.equal(derived.acquisitionPhase, AcquisitionPhase.WARNING);
    assert.equal(derived.safeReason, AcquisitionSafeReason.UNKNOWN_ERROR);
    assert.equal(JSON.stringify(derived).includes('C:\\downloads'), false);
  });

  for (const [status, phase, reason] of [
    ['paused', AcquisitionPhase.PAUSED, AcquisitionSafeReason.PAUSED],
    ['delay', AcquisitionPhase.DELAYED, AcquisitionSafeReason.DELAYED],
    [
      'downloadClientUnavailable',
      AcquisitionPhase.FAILED,
      AcquisitionSafeReason.DOWNLOAD_CLIENT_UNAVAILABLE,
    ],
    ['failed', AcquisitionPhase.FAILED, AcquisitionSafeReason.UNKNOWN_ERROR],
  ] as const) {
    it(`maps queue status ${status}`, () => {
      const derived = deriveAcquisitionState(input({ status }));
      assert.equal(derived.acquisitionPhase, phase);
      assert.equal(derived.safeReason, reason);
    });
  }

  it('falls back safely for unsupported combinations', () => {
    const derived = deriveAcquisitionState(
      input({
        status: 'fallback',
        trackedDownloadState: 'ignored',
        sizeLeft: 0,
      })
    );
    assert.deepEqual(derived, {
      acquisitionPhase: AcquisitionPhase.WAITING,
      health: 'ok',
    });
  });

  it('fails safe when a future Servarr value arrives at runtime', () => {
    const derived = deriveAcquisitionState({
      ...input(),
      status: 'future-status',
      trackedDownloadStatus: 'future-health',
      trackedDownloadState: 'future-state',
      sizeLeft: 0,
    } as unknown as AcquisitionPhaseInput);
    assert.deepEqual(derived, {
      acquisitionPhase: AcquisitionPhase.WAITING,
      health: 'ok',
    });
  });
});
