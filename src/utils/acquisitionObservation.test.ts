import { MediaType } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import { acquisitionDownload as item } from '@server/test/acquisitionFixtures';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_ACQUISITION_OBSERVATIONS,
  observeAcquisitionDownloads,
  type AcquisitionObservation,
} from './acquisitionObservation';
import { getAcquisitionPresentation } from './acquisitionPresentation';

describe('successive acquisition observations (synthetic provider shapes)', () => {
  const queued = (number: number) =>
    item(number, {
      downloadId: number === 7 ? 'a-queued' : `z-${number}`,
      sizeLeft: 1000,
      timeLeft: '00:04:00',
    });
  const sample = (
    rows: ReturnType<typeof item>[],
    previous?: AcquisitionObservation,
    scope = 'viewer:tv:200:standard'
  ) => observeAcquisitionDownloads(rows, scope, {}, false, previous);
  const present = (
    rows: ReturnType<typeof item>[],
    observation: AcquisitionObservation
  ) => getAcquisitionPresentation(rows, observation.advancing);

  it('uses E2 byte advancement, not E7 identity or positive cumulative ETA', () => {
    const before = [queued(7), item(2, { sizeLeft: 500 })];
    const rows = [queued(7), item(2, { sizeLeft: 100 })];
    const original = JSON.stringify(rows);
    const first = sample(before);
    for (const order of [rows, [...rows].reverse()]) {
      const result = present(order, sample(order, first));
      assert.equal(result.item?.episode?.episodeNumber, 2);
      assert.equal(result.phase, AcquisitionPhase.DOWNLOADING);
      assert.equal(result.progress, 90);
    }
    assert.equal(JSON.stringify(rows), original);
  });

  it('initial and unchanged samples never claim activity from partial bytes/ETA', () => {
    const rows = [item(2, { sizeLeft: 100 }), queued(7)];
    const first = sample(rows);
    assert.equal(present(rows, first).phase, AcquisitionPhase.WAITING);
    assert.equal(sample(rows, first).advancing.size, 0);
  });

  it('chooses simultaneous advancing downloads deterministically, not by percent', () => {
    const before = [
      item(1, { downloadId: 'a', sizeLeft: 900 }),
      item(2, { downloadId: 'z', sizeLeft: 500 }),
    ];
    const rows = [
      item(1, { downloadId: 'a', sizeLeft: 800 }),
      item(2, { downloadId: 'z', sizeLeft: 100 }),
    ];
    const observation = sample(rows, sample(before));
    assert.equal(observation.advancing.size, 2);
    for (const order of [rows, [...rows].reverse()]) {
      assert.equal(present(order, observation).item?.episode?.episodeNumber, 1);
      assert.equal(present(order, observation).progress, 20);
    }
  });

  it('clears activity for a stalled partial transfer on the next unchanged validation', () => {
    const rows = [item(2, { sizeLeft: 100 })];
    const active = sample(rows, sample([item(2, { sizeLeft: 400 })]));
    assert.equal(active.advancing.size, 1);
    const validating = observeAcquisitionDownloads(
      rows,
      active.scope,
      active.sample,
      true,
      active
    );
    assert.equal(validating.advancing.size, 1);
    const unchanged = observeAcquisitionDownloads(
      rows,
      active.scope,
      active.sample,
      false,
      validating
    );
    assert.equal(present(rows, unchanged).phase, AcquisitionPhase.WAITING);
  });

  it('does not resample ordinary re-renders or filtered array recreation', () => {
    const rows = [item(2, { sizeLeft: 100 })];
    const active = sample(rows, sample([item(2, { sizeLeft: 400 })]));
    const rerender = observeAcquisitionDownloads(
      [...rows],
      active.scope,
      active.sample,
      false,
      active
    );
    assert.equal(rerender, active);
    assert.equal(rerender.advancing.size, 1);
  });

  it('does not compare fallback data with an in-flight first response', () => {
    const initial = observeAcquisitionDownloads([item(2)], 'scope', {}, true);
    const first = sample([item(2, { sizeLeft: 100 })], initial, 'scope');
    assert.equal(first.advancing.size, 0);
  });

  for (const change of [
    { downloadId: 'replacement' },
    { acquisitionPhaseStartedAt: '2026-01-02T00:00:00Z' },
    { size: 2000 },
    { externalId: 201 },
    { mediaType: MediaType.MOVIE },
    {
      episode: {
        id: 999,
        seasonNumber: 2,
        episodeNumber: 2,
        absoluteEpisodeNumber: 2,
      },
    },
  ]) {
    it(`resets generation hints on ${Object.keys(change).join(',')}`, () => {
      const previous = sample([item(2, { sizeLeft: 500 })]);
      const changed = sample([item(2, { sizeLeft: 100, ...change })], previous);
      assert.equal(changed.advancing.size, 0);
    });
  }

  it('resets after a byte counter rewind and after disappearance', () => {
    const old = sample([item(2, { sizeLeft: 100 })]);
    const rewound = sample([item(2, { sizeLeft: 900 })], old);
    assert.equal(rewound.advancing.size, 0);
    assert.equal(
      sample([item(2, { sizeLeft: 800 })], rewound).advancing.size,
      1
    );
    const empty = sample([], old);
    assert.equal(empty.remaining.size, 0);
    assert.equal(sample([item(2, { sizeLeft: 50 })], empty).advancing.size, 0);
  });

  for (const scope of [
    'other-user:tv:200:standard',
    'viewer:tv:201:standard',
    'viewer:tv:200:4k',
  ]) {
    it(`isolates ${scope}`, () => {
      const previous = sample([item(2, { sizeLeft: 500 })]);
      assert.equal(
        sample([item(2, { sizeLeft: 100 })], previous, scope).advancing.size,
        0
      );
    });
  }

  for (const phase of [
    AcquisitionPhase.PROCESSING,
    AcquisitionPhase.IMPORTING,
    AcquisitionPhase.FINALIZING,
  ]) {
    it(`preserves ${phase} precedence over unproven waiting rows`, () => {
      const rows = [
        queued(7),
        item(1, { acquisitionPhase: phase, sizeLeft: 0 }),
      ];
      const first = sample(rows);
      assert.equal(present(rows, first).phase, phase);
      assert.equal(present(rows, first).determinate, false);
      const advancing = [
        item(7, { downloadId: 'a-queued', sizeLeft: 900 }),
        rows[1],
      ];
      assert.equal(
        present(advancing, sample(advancing, first)).phase,
        AcquisitionPhase.DOWNLOADING
      );
    });
  }

  it('retains shared-pack labeling and multi-Episode rows without byte aggregation', () => {
    const before = [1, 2].map((n) =>
      item(n, { downloadId: 'pack', sizeLeft: 500 })
    );
    const rows = [1, 2].map((n) =>
      item(n, { downloadId: 'pack', sizeLeft: 100 })
    );
    const result = present(rows, sample(rows, sample(before)));
    assert.equal(result.seasonPack, true);
    assert.equal(result.progress, 90);
    assert.equal(rows.length, 2);
  });

  it('accepts observed movement without an ETA, and rejects malformed/unhealthy evidence', () => {
    const previous = sample([item(2, { sizeLeft: 500 })]);
    const rows = [item(2, { sizeLeft: 100, timeLeft: '' })];
    assert.equal(
      present(rows, sample(rows, previous)).phase,
      AcquisitionPhase.DOWNLOADING
    );
    for (const overrides of [
      { sizeLeft: NaN },
      { health: 'error' as const },
      { status: 'paused' as const },
      { downloadId: '' },
    ]) {
      assert.equal(
        sample([item(2, { sizeLeft: 100, ...overrides })], previous).advancing
          .size,
        0
      );
    }
  });

  it('bounds memory to the current visible population and drops previous routes', () => {
    const rows = Array.from({ length: 1200 }, (_, n) => item(n + 1));
    let previous = sample(rows);
    assert.equal(previous.remaining.size, MAX_ACQUISITION_OBSERVATIONS);
    for (let n = 0; n < 100; n++)
      previous = sample([item(2)], previous, `route-${n}`);
    assert.equal(previous.remaining.size, 1);
    assert.equal(previous.advancing.size, 0);
  });
});
