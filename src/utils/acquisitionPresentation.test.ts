import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import { acquisitionDownload as item } from '@server/test/acquisitionFixtures';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getAcquisitionPresentation,
  getDownloadPresentationPhase,
  selectRepresentativeDownload,
} from './acquisitionPresentation';

describe('representative acquisition presentation', () => {
  for (const order of [
    [1, 2, 3],
    [3, 2, 1],
    [2, 1, 3],
    [3, 1, 2],
    [1, 3, 2],
    [2, 3, 1],
  ]) {
    it(`selects the actual transfer rather than queue order ${order.join(',')}`, () => {
      const rows = order.map((episode) =>
        item(
          episode,
          episode === 2
            ? { sizeLeft: 230 }
            : { status: 'queued', timeLeft: '', sizeLeft: 900 }
        )
      );
      const original = JSON.stringify(rows);
      const selected = getAcquisitionPresentation(rows);
      assert.equal(selected.item?.episode?.episodeNumber, 2);
      assert.equal(selected.phase, AcquisitionPhase.DOWNLOADING);
      assert.equal(selected.progress, 77);
      assert.equal(JSON.stringify(rows), original);
      assert.equal(rows.length, 3);
    });
  }

  it('uses durable identity to break concurrent-transfer ties across reorderings', () => {
    const first = item(1, { downloadId: 'a-transfer', sizeLeft: 800 });
    const second = item(2, { downloadId: 'z-transfer', sizeLeft: 100 });
    assert.equal(selectRepresentativeDownload([second, first]), first);
    assert.equal(selectRepresentativeDownload([first, second]), first);
    assert.equal(getAcquisitionPresentation([second, first]).progress, 20);
  });

  for (const overrides of [
    { status: 'queued' as const },
    { timeLeft: '' },
    { timeLeft: '00:00:00' },
    { timeLeft: 'unknown' },
    { timeLeft: '00:99:00' },
    { trackedDownloadState: undefined },
    { trackedDownloadStatus: undefined },
    { size: 0 },
    { sizeLeft: Number.NaN },
  ]) {
    it(`does not invent transfer activity from bytes/phase: ${JSON.stringify(overrides)}`, () => {
      const waiting = item(1, overrides);
      assert.equal(
        getDownloadPresentationPhase(waiting),
        AcquisitionPhase.WAITING
      );
      assert.equal(
        selectRepresentativeDownload([waiting, item(2)])?.episode
          ?.episodeNumber,
        2
      );
    });
  }

  it('accepts valid day-prefixed transfer estimates without consulting wall-clock timestamps', () => {
    assert.equal(
      getDownloadPresentationPhase(item(1, { timeLeft: '1.02:03:04' })),
      AcquisitionPhase.DOWNLOADING
    );
  });

  it('defines deterministic active/import/Finalizing/warning/waiting/paused/unknown precedence', () => {
    const rows = [
      item(1),
      item(2, { acquisitionPhase: AcquisitionPhase.IMPORTING }),
      item(3, { acquisitionPhase: AcquisitionPhase.PROCESSING }),
      item(4, { acquisitionPhase: AcquisitionPhase.FINALIZING }),
      item(5, { acquisitionPhase: AcquisitionPhase.WARNING }),
      item(6, { status: 'queued' }),
      item(7, { acquisitionPhase: AcquisitionPhase.PAUSED }),
      item(8, { timeLeft: '' }),
    ];
    for (let index = 0; index < rows.length; index++) {
      assert.equal(
        selectRepresentativeDownload(rows.slice(index).reverse()),
        rows[index]
      );
    }
  });

  for (const [status, phase] of [
    ['paused', AcquisitionPhase.PAUSED],
    ['delay', AcquisitionPhase.DELAYED],
    ['warning', AcquisitionPhase.WARNING],
    ['failed', AcquisitionPhase.FAILED],
  ] as const) {
    it(`presents ${status} truthfully even with retained progress and a downloading phase`, () => {
      assert.equal(getDownloadPresentationPhase(item(1, { status })), phase);
    });
  }

  for (const phase of [
    AcquisitionPhase.IMPORTING,
    AcquisitionPhase.IMPORT_PENDING,
    AcquisitionPhase.PROCESSING,
    AcquisitionPhase.FINALIZING,
  ]) {
    it(`keeps ${phase} indeterminate without a synthetic percentage`, () => {
      const result = getAcquisitionPresentation([
        item(1, { acquisitionPhase: phase, sizeLeft: 0 }),
      ]);
      assert.equal(result.phase, phase);
      assert.equal(result.determinate, false);
      assert.equal(result.progress, undefined);
    });
  }

  it('preserves a pack identity/Season label while selecting its active entry', () => {
    const selected = getAcquisitionPresentation([
      item(1, { downloadId: 'pack', status: 'queued' }),
      item(2, { downloadId: 'pack', sizeLeft: 120 }),
    ]);
    assert.equal(selected.seasonPack, true);
    assert.equal(selected.item?.downloadId, 'pack');
    assert.equal(selected.item?.episode?.seasonNumber, 1);
    assert.equal(selected.progress, 88);
  });

  it('does not retain a previous representative or percentage after disappearance/replacement', () => {
    const old = item(1, { sizeLeft: 100 });
    assert.equal(
      getAcquisitionPresentation([old, item(2, { status: 'queued' })]).progress,
      90
    );
    const next = getAcquisitionPresentation([
      item(2, { size: 0, sizeLeft: 0 }),
    ]);
    assert.equal(next.item?.episode?.episodeNumber, 2);
    assert.equal(next.progress, undefined);
    assert.equal(getAcquisitionPresentation([]).item, undefined);
  });

  it('is bounded, non-mutating and stable for the configured maximum queue population', () => {
    const rows = Array.from({ length: 1000 }, (_, index) =>
      item(index + 1, { downloadId: String(index).padStart(4, '0') })
    );
    const original = JSON.stringify(rows);
    const started = performance.now();
    assert.equal(
      selectRepresentativeDownload(rows.reverse())?.downloadId,
      '0000'
    );
    assert.ok(performance.now() - started < 1000);
    rows.reverse();
    assert.equal(JSON.stringify(rows), original);
  });
});
