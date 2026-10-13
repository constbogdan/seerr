import type { LibraryBulkActionTarget } from '@server/interfaces/api/libraryInterfaces';
import {
  LibraryBulkActionService,
  LibraryBulkActionValidationError,
} from '@server/lib/libraryBulkActions';
import { MediaRemovalError } from '@server/lib/mediaRemoval';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const targets: LibraryBulkActionTarget[] = [
  { canonicalMediaId: 1, targetType: 'movie' },
  { canonicalMediaId: 2, targetType: 'season', seasonNumber: 1 },
  { canonicalMediaId: 3, targetType: 'series' },
];

const dependencies = (overrides: Record<string, unknown> = {}) => ({
  scheduler: {
    hasLiveProcessingLease: async () => false,
    createManualWithResult: async () => ({
      schedule: {},
      created: true,
      affectedSchedules: 1,
    }),
    cancelExactTarget: async () => ({
      affectedSchedules: 1,
      inProgress: false,
    }),
    completeForTarget: async () => 1,
  },
  validateTargets: async () => undefined,
  resolveTarget: async (target: LibraryBulkActionTarget) =>
    ({ sourceScope: `service:${target.canonicalMediaId}` }) as never,
  refreshAcquisitionState: async () => undefined,
  assertAcquisitionInactive: () => undefined,
  acquireExecutionGuard: () => () => undefined,
  removeTarget: async () => ({
    targetType: 'movie',
    providerResult: 'removed' as const,
  }),
  loadActionableSchedules: async () => [],
  isExecutionActive: () => false,
  now: () => new Date('2026-10-09T12:00:00.000Z'),
  ...overrides,
});

describe('LibraryBulkActionService', () => {
  it('previews fully unscheduled, fully scheduled, and mixed targets without mutation', async () => {
    const service = new LibraryBulkActionService(
      dependencies({
        loadActionableSchedules: async () => [
          {
            id: 10,
            canonicalMediaId: 2,
            targetType: 'season',
            seasonNumber: 1,
            status: 'active',
            leaseToken: null,
            leaseUntil: null,
          },
          {
            id: 11,
            canonicalMediaId: 3,
            targetType: 'series',
            seasonNumber: null,
            status: 'deferred',
            leaseToken: null,
            leaseUntil: null,
          },
        ],
      }) as never
    );

    const preview = await service.previewEligibility(targets);

    assert.deepEqual(
      preview.results.map(({ eligibility }) => eligibility),
      ['schedule', 'cancel_schedule', 'cancel_schedule']
    );
    assert.deepEqual(
      preview.results.map(({ reason }) => reason),
      ['unscheduled', 'scheduled', 'scheduled']
    );
  });

  it('keeps leases, execution guards, whole-Series schedules, and ambiguous sources unavailable', async () => {
    const previewTargets: LibraryBulkActionTarget[] = [
      { canonicalMediaId: 1, targetType: 'movie' },
      { canonicalMediaId: 2, targetType: 'season', seasonNumber: 1 },
      { canonicalMediaId: 3, targetType: 'season', seasonNumber: 2 },
      { canonicalMediaId: 4, targetType: 'movie' },
    ];
    const service = new LibraryBulkActionService(
      dependencies({
        loadActionableSchedules: async () => [
          {
            id: 10,
            canonicalMediaId: 1,
            targetType: 'movie',
            seasonNumber: null,
            status: 'active',
            leaseToken: 'lease',
            leaseUntil: new Date('2026-10-09T12:05:00.000Z'),
          },
          {
            id: 11,
            canonicalMediaId: 3,
            targetType: 'series',
            seasonNumber: null,
            status: 'active',
            leaseToken: null,
            leaseUntil: null,
          },
        ],
        isExecutionActive: (canonicalMediaId: number) => canonicalMediaId === 2,
        resolveTarget: async (target: LibraryBulkActionTarget) => {
          if (target.canonicalMediaId === 4) {
            throw new MediaRemovalError(
              'AMBIGUOUS_SOURCE',
              'Multiple current sources.'
            );
          }
          return { sourceScope: 'service:1' } as never;
        },
      }) as never
    );

    const preview = await service.previewEligibility(previewTargets);

    assert.deepEqual(
      preview.results.map(({ eligibility }) => eligibility),
      ['conflict', 'conflict', 'conflict', 'conflict']
    );
    assert.deepEqual(
      preview.results.map(({ reason }) => reason),
      [
        'processing_lease',
        'execution_in_progress',
        'whole_series_scheduled',
        'ambiguous_source',
      ]
    );
  });

  it('treats durable execution claims as authoritative preview conflicts', async () => {
    let resolutions = 0;
    const service = new LibraryBulkActionService(
      dependencies({
        loadClaimedCanonicalMediaIds: async () => new Set([2]),
        resolveTargets: async (resolutionTargets: LibraryBulkActionTarget[]) =>
          resolutionTargets.map((target) => {
            resolutions += 1;
            return {
              status: 'fulfilled' as const,
              value: {
                sourceScope: `service:${target.canonicalMediaId}`,
              } as never,
            };
          }),
      }) as never
    );

    const preview = await service.previewEligibility(targets);

    assert.deepEqual(
      preview.results.map(({ reason }) => reason),
      ['unscheduled', 'execution_in_progress', 'unscheduled']
    );
    assert.equal(resolutions, 2);
  });

  it('preserves per-target active-acquisition eligibility decisions after batched resolution', async () => {
    const service = new LibraryBulkActionService(
      dependencies({
        resolveTargets: async (resolutionTargets: LibraryBulkActionTarget[]) =>
          resolutionTargets.map((target) => ({
            status: 'fulfilled' as const,
            value: {
              canonicalMediaId: target.canonicalMediaId,
              sourceScope: `service:${target.canonicalMediaId}`,
            } as never,
          })),
        assertAcquisitionInactive: (resolved: { canonicalMediaId: number }) => {
          if (resolved.canonicalMediaId === 2) {
            throw new MediaRemovalError(
              'ACTIVE_ACQUISITION',
              'Media has an active acquisition.'
            );
          }
        },
      }) as never
    );

    const preview = await service.previewEligibility(targets);

    assert.deepEqual(
      preview.results.map(({ reason }) => reason),
      ['unscheduled', 'active_acquisition', 'unscheduled']
    );
  });

  it('does not guess eligibility when current target resolution is unavailable', async () => {
    const service = new LibraryBulkActionService(
      dependencies({
        resolveTarget: async ({
          canonicalMediaId,
        }: LibraryBulkActionTarget) => {
          if (canonicalMediaId === 1) {
            throw new MediaRemovalError('NOT_CURRENT', 'Not current.');
          }
          throw new Error('Database unavailable.');
        },
      }) as never
    );

    const preview = await service.previewEligibility(targets.slice(0, 2));

    assert.deepEqual(
      preview.results.map(({ eligibility }) => eligibility),
      ['unavailable', 'unknown']
    );
  });

  it('performs request validation before any mutation', async () => {
    let mutations = 0;
    const service = new LibraryBulkActionService(
      dependencies({
        validateTargets: async () => {
          throw new LibraryBulkActionValidationError('Invalid target.');
        },
        scheduler: {
          hasLiveProcessingLease: async () => false,
          createManualWithResult: async () => {
            mutations += 1;
          },
          cancelExactTarget: async () => {
            mutations += 1;
          },
        },
      }) as never
    );
    await assert.rejects(
      service.execute({ action: 'schedule', targets }),
      LibraryBulkActionValidationError
    );
    assert.equal(mutations, 0);
  });

  it('isolates per-target schedule failures and preserves request order', async () => {
    const attempted: number[] = [];
    const service = new LibraryBulkActionService(
      dependencies({
        scheduler: {
          hasLiveProcessingLease: async () => false,
          createManualWithResult: async ({
            canonicalMediaId,
          }: {
            canonicalMediaId: number;
          }) => {
            attempted.push(canonicalMediaId);
            return {
              schedule: {},
              created: canonicalMediaId !== 3,
              affectedSchedules: canonicalMediaId === 3 ? 0 : 1,
            };
          },
          cancelExactTarget: async () => ({
            affectedSchedules: 0,
            inProgress: false,
          }),
        },
        assertAcquisitionInactive: (target: { sourceScope: string }) => {
          if (target.sourceScope === 'service:2') {
            throw new MediaRemovalError(
              'ACTIVE_ACQUISITION',
              'Media has an active acquisition.'
            );
          }
        },
      }) as never
    );
    const response = await service.execute({ action: 'schedule', targets });
    assert.deepEqual(
      response.results.map(({ target }) => target.canonicalMediaId),
      [1, 2, 3]
    );
    assert.deepEqual(
      response.results.map(({ outcome }) => outcome),
      ['scheduled', 'active_acquisition', 'already_scheduled']
    );
    assert.deepEqual(attempted, [1, 3]);
    assert.deepEqual(
      [
        response.succeeded,
        response.unchanged,
        response.skipped,
        response.failed,
      ],
      [1, 1, 1, 0]
    );
  });

  it('reports exact-target cancellation outcomes and active leases', async () => {
    const service = new LibraryBulkActionService(
      dependencies({
        scheduler: {
          hasLiveProcessingLease: async () => false,
          createManualWithResult: async () => {
            throw new Error('not used');
          },
          cancelExactTarget: async ({
            canonicalMediaId,
          }: {
            canonicalMediaId: number;
          }) =>
            canonicalMediaId === 1
              ? { affectedSchedules: 2, inProgress: false }
              : canonicalMediaId === 2
                ? { affectedSchedules: 0, inProgress: true }
                : { affectedSchedules: 0, inProgress: false },
        },
      }) as never
    );
    const response = await service.execute({
      action: 'cancel_schedule',
      targets,
    });
    assert.deepEqual(
      response.results.map(({ outcome }) => outcome),
      ['cancelled', 'in_progress', 'not_scheduled']
    );
    assert.equal(response.results[0].affectedSchedules, 2);
  });

  it('marks every target not attempted after a batch-wide acquisition refresh failure', async () => {
    let mutations = 0;
    const service = new LibraryBulkActionService(
      dependencies({
        refreshAcquisitionState: async () => {
          throw new Error('provider unavailable');
        },
        scheduler: {
          hasLiveProcessingLease: async () => false,
          createManualWithResult: async () => {
            mutations += 1;
          },
          cancelExactTarget: async () => ({
            affectedSchedules: 0,
            inProgress: false,
          }),
        },
      }) as never
    );
    const response = await service.execute({ action: 'schedule', targets });
    assert.deepEqual(
      response.results.map(({ outcome }) => outcome),
      ['not_attempted', 'not_attempted', 'not_attempted']
    );
    assert.equal(response.failed, 3);
    assert.equal(mutations, 0);
  });

  it('removes targets sequentially, reconciles schedules, and reports provider results', async () => {
    const order: string[] = [];
    const service = new LibraryBulkActionService(
      dependencies({
        removeTarget: async (target: LibraryBulkActionTarget) => {
          order.push(`remove:${target.canonicalMediaId}`);
          if (target.canonicalMediaId === 2) {
            throw new MediaRemovalError(
              'CROSS_SEASON_FILE',
              'A shared EpisodeFile crosses the requested season boundary'
            );
          }
          return {
            targetType: target.targetType,
            providerResult:
              target.canonicalMediaId === 3 ? 'absent' : 'removed',
            affectedSchedules: target.canonicalMediaId === 3 ? 2 : 1,
          } as never;
        },
        scheduler: {
          hasLiveProcessingLease: async () => false,
          createManualWithResult: async () => {
            throw new Error('not used');
          },
          cancelExactTarget: async () => {
            throw new Error('not used');
          },
        },
      }) as never
    );

    const response = await service.execute({ action: 'remove_now', targets });

    assert.deepEqual(order, ['remove:1', 'remove:2', 'remove:3']);
    assert.deepEqual(
      response.results.map(({ outcome }) => outcome),
      [
        'provider_acknowledged',
        'cross_season_file',
        'provider_absent_reconciled',
      ]
    );
    assert.deepEqual(
      [
        response.succeeded,
        response.unchanged,
        response.skipped,
        response.failed,
      ],
      [2, 0, 1, 0]
    );
    assert.equal(response.results[2].affectedSchedules, 2);
  });

  it('does not retry uncertain remote success and stops the remaining batch', async () => {
    let calls = 0;
    const service = new LibraryBulkActionService(
      dependencies({
        removeTarget: async () => {
          calls += 1;
          throw new MediaRemovalError(
            'REMOTE_REMOVED_LOCAL_FAILED',
            'Provider removal succeeded but local reconciliation failed',
            true
          );
        },
      }) as never
    );

    const response = await service.execute({ action: 'remove_now', targets });

    assert.deepEqual(
      response.results.map(({ outcome }) => outcome),
      ['remote_removed_local_failed', 'not_attempted', 'not_attempted']
    );
    assert.equal(response.results[0].retryable, false);
    assert.match(response.results[0].message, /may have completed/i);
    assert.equal(calls, 1);
  });

  it('continues after an ordinary provider failure but stops on unknown infrastructure failure', async () => {
    let calls = 0;
    const service = new LibraryBulkActionService(
      dependencies({
        removeTarget: async () => {
          calls += 1;
          if (calls === 1) {
            throw new MediaRemovalError(
              'TRANSIENT_PROVIDER',
              'Provider removal failed',
              true
            );
          }
          throw new Error('database unavailable');
        },
      }) as never
    );

    const response = await service.execute({ action: 'remove_now', targets });

    assert.deepEqual(
      response.results.map(({ outcome }) => outcome),
      ['failed', 'failed', 'not_attempted']
    );
    assert.equal(response.results[0].code, 'transient_provider');
    assert.equal(response.results[0].retryable, true);
    assert.equal(calls, 2);
  });

  it('maps authoritative removal conflicts without stopping later targets', async () => {
    const errors = [
      new MediaRemovalError('NOT_CURRENT', 'Not current.'),
      new MediaRemovalError('AMBIGUOUS_SOURCE', 'Ambiguous source.'),
      new MediaRemovalError('ACTIVE_ACQUISITION', 'Active acquisition.'),
      new MediaRemovalError('EXECUTION_CONFLICT', 'In progress.', true),
      new MediaRemovalError('IDENTITY_CONFLICT', 'Identity conflict.'),
    ];
    let call = 0;
    const conflictTargets = errors.map((_, index) => ({
      canonicalMediaId: index + 1,
      targetType: 'movie' as const,
    }));
    const service = new LibraryBulkActionService(
      dependencies({
        removeTarget: async () => {
          throw errors[call++];
        },
      }) as never
    );

    const response = await service.execute({
      action: 'remove_now',
      targets: conflictTargets,
    });

    assert.deepEqual(
      response.results.map(({ outcome }) => outcome),
      [
        'not_current',
        'ambiguous_source',
        'active_acquisition',
        'in_progress',
        'identity_conflict',
      ]
    );
    assert.equal(call, errors.length);
    assert.deepEqual(
      response.results.map(({ retryable }) => retryable),
      [false, true, true, true, false]
    );
  });

  it('rejects more than ten Remove Now targets before validation or mutation', async () => {
    let validations = 0;
    let removals = 0;
    const service = new LibraryBulkActionService(
      dependencies({
        validateTargets: async () => {
          validations += 1;
        },
        removeTarget: async () => {
          removals += 1;
          return { targetType: 'movie', providerResult: 'removed' } as never;
        },
      }) as never
    );
    await assert.rejects(
      service.execute({
        action: 'remove_now',
        targets: Array.from({ length: 11 }, (_, index) => ({
          canonicalMediaId: index + 1,
          targetType: 'movie' as const,
        })),
      }),
      LibraryBulkActionValidationError
    );
    assert.equal(validations, 0);
    assert.equal(removals, 0);
  });
});
