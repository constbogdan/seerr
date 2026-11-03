import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { LibraryMediaType } from '@server/constants/libraryHistory';
import {
  RemovalExecutionInitiator,
  RemovalExecutionState,
  RemovalScheduleOrigin,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import { SeriesRelocationState } from '@server/constants/seriesRelocation';
import applicationDataSource from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import {
  RemovalExecution,
  RemovalExecutionClaim,
} from '@server/entity/RemovalExecution';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import { SeriesRelocationExecution } from '@server/entity/SeriesRelocationExecution';
import {
  RemovalExecutionClaimConflictError,
  RemovalExecutionCoordinator,
  RemovalExecutionOwnershipLostError,
  RemovalExecutionStateError,
} from '@server/lib/removalExecutionCoordinator';
import {
  RemovalScheduleConflictError,
  clearAllScheduledRemovalRecords,
} from '@server/lib/removalScheduler';
import { DataSource } from 'typeorm';

const createConnections = async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'seerr-removal-claim-'));
  const databasePath = path.join(directory, 'db.sqlite3');
  const migrator = new DataSource({
    type: 'sqlite',
    database: databasePath,
    migrations: ['server/migration/sqlite/*.ts'],
    synchronize: false,
  });
  await migrator.initialize();
  await migrator.runMigrations();
  await migrator.destroy();

  const connection = () =>
    new DataSource({
      type: 'sqlite',
      database: databasePath,
      entities: applicationDataSource.options.entities,
      synchronize: false,
    });
  const first = connection();
  const second = connection();
  await first.initialize();
  await second.initialize();
  await first.query('PRAGMA busy_timeout = 5000');
  await second.query('PRAGMA busy_timeout = 5000');
  return {
    directory,
    first,
    second,
    async close() {
      if (first.isInitialized) await first.destroy();
      if (second.isInitialized) await second.destroy();
      rmSync(directory, { recursive: true, force: true });
    },
  };
};

const movie = async (connection: DataSource, title: string) =>
  connection.getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: title,
    })
  );

const series = async (connection: DataSource, title: string) =>
  connection.getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.SERIES,
      titleSnapshot: title,
    })
  );

const claimInput = (canonicalMediaId: number) => ({
  canonicalMediaId,
  targetType: RemovalTargetType.MOVIE,
  initiator: RemovalExecutionInitiator.MANUAL,
});

describe('RemovalExecutionCoordinator durable claims', () => {
  it('serializes Clear All with scheduled claim acquisition across connections', async () => {
    const fixture = await createConnections();
    try {
      const target = await movie(fixture.first, 'Clear race');
      const schedule = await fixture.first.getRepository(RemovalSchedule).save(
        new RemovalSchedule({
          canonicalMediaId: target.id,
          targetType: RemovalTargetType.MOVIE,
          sourceSystem: 'radarr',
          sourceScope: 'service:0',
          origin: RemovalScheduleOrigin.MANUAL,
          status: RemovalScheduleStatus.ACTIVE,
          activeKey: `service:0:${target.id}:movie:-`,
          scheduledAt: new Date('2026-10-01T00:00:00.000Z'),
          removeAt: new Date('2026-10-10T00:00:00.000Z'),
        })
      );
      const coordinator = new RemovalExecutionCoordinator(fixture.first);
      const acquisition = coordinator.acquire(
        {
          canonicalMediaId: target.id,
          targetType: RemovalTargetType.MOVIE,
          initiator: RemovalExecutionInitiator.SCHEDULED,
          scheduleId: schedule.id,
          scheduleRevision: schedule.revision,
        },
        async (manager) => {
          const current = await manager
            .getRepository(RemovalSchedule)
            .findOneBy({
              id: schedule.id,
              revision: schedule.revision,
              status: RemovalScheduleStatus.ACTIVE,
            });
          if (!current) throw new Error('schedule no longer actionable');
        }
      );
      const clearing = clearAllScheduledRemovalRecords(
        fixture.second,
        new Date('2026-10-11T12:00:00.000Z')
      );
      const outcomes = await Promise.allSettled([acquisition, clearing]);

      assert.equal(
        outcomes.filter(({ status }) => status === 'fulfilled').length,
        1
      );
      const stored = await fixture.first
        .getRepository(RemovalSchedule)
        .findOneByOrFail({ id: schedule.id });
      const claim = await fixture.first
        .getRepository(RemovalExecutionClaim)
        .findOneBy({ canonicalMediaId: target.id });
      if (outcomes[0].status === 'fulfilled') {
        assert.equal(stored.status, RemovalScheduleStatus.ACTIVE);
        assert.equal(claim?.executionId, outcomes[0].value.executionId);
        assert.ok(
          outcomes[1].status === 'rejected' &&
            outcomes[1].reason instanceof RemovalScheduleConflictError
        );
      } else {
        assert.equal(stored.status, RemovalScheduleStatus.CANCELLED);
        assert.equal(claim?.executionId ?? null, null);
        assert.equal(outcomes[1].status, 'fulfilled');
      }
    } finally {
      await fixture.close();
    }
  });

  it('grants one owner across independent database connections', async () => {
    const fixture = await createConnections();
    try {
      const target = await movie(fixture.first, 'Concurrent claim');
      const first = new RemovalExecutionCoordinator(fixture.first);
      const second = new RemovalExecutionCoordinator(fixture.second);

      const outcomes = await Promise.allSettled([
        first.acquire(claimInput(target.id)),
        second.acquire(claimInput(target.id)),
      ]);
      assert.equal(
        outcomes.filter(({ status }) => status === 'fulfilled').length,
        1
      );
      const rejected = outcomes.find(({ status }) => status === 'rejected');
      assert.ok(rejected && rejected.status === 'rejected');
      assert.ok(rejected.reason instanceof RemovalExecutionClaimConflictError);
      assert.equal(
        await fixture.first.getRepository(RemovalExecution).countBy({
          canonicalMediaId: target.id,
        }),
        1
      );
      const storedClaim = await fixture.first
        .getRepository(RemovalExecutionClaim)
        .findOneByOrFail({ canonicalMediaId: target.id });
      assert.equal(storedClaim.fence, 1);
      assert.ok(storedClaim.executionId);
      assert.ok(storedClaim.ownerToken);
    } finally {
      await fixture.close();
    }
  });

  it('uses one canonical claim for whole-Series and every Season initiator', async () => {
    const fixture = await createConnections();
    try {
      const target = await series(fixture.first, 'Series overlap');
      const first = new RemovalExecutionCoordinator(fixture.first);
      const second = new RemovalExecutionCoordinator(fixture.second);
      const ownership = await first.acquire({
        canonicalMediaId: target.id,
        targetType: RemovalTargetType.SEASON,
        seasonNumber: 1,
        initiator: RemovalExecutionInitiator.MANUAL,
      });

      await assert.rejects(
        second.acquire({
          canonicalMediaId: target.id,
          targetType: RemovalTargetType.SEASON,
          seasonNumber: 2,
          initiator: RemovalExecutionInitiator.BULK,
        }),
        RemovalExecutionClaimConflictError
      );
      await assert.rejects(
        second.acquire({
          canonicalMediaId: target.id,
          targetType: RemovalTargetType.SERIES,
          initiator: RemovalExecutionInitiator.SCHEDULED,
        }),
        RemovalExecutionClaimConflictError
      );
      await first.endBeforeProvider(
        ownership,
        RemovalExecutionState.CANCELLED_PRE_PROVIDER
      );
    } finally {
      await fixture.close();
    }
  });

  it('renews only current fenced ownership', async () => {
    const fixture = await createConnections();
    let now = new Date('2026-10-11T12:00:00.000Z');
    try {
      const target = await movie(fixture.first, 'Renewed claim');
      const coordinator = new RemovalExecutionCoordinator(
        fixture.first,
        () => now,
        1_000
      );
      const ownership = await coordinator.acquire(claimInput(target.id));
      now = new Date(now.getTime() + 250);
      const renewed = await coordinator.renew(ownership);
      assert.equal(
        renewed.leaseUntil.toISOString(),
        '2026-10-11T12:00:01.250Z'
      );

      now = new Date(now.getTime() + 1_001);
      await assert.rejects(
        coordinator.renew(renewed),
        RemovalExecutionOwnershipLostError
      );
    } finally {
      await fixture.close();
    }
  });

  it('uses one canonical claim for whole-Series and Season targets', async () => {
    const fixture = await createConnections();
    try {
      const target = await series(fixture.first, 'Series conflict scope');
      const first = new RemovalExecutionCoordinator(fixture.first);
      const second = new RemovalExecutionCoordinator(fixture.second);
      await first.acquire({
        canonicalMediaId: target.id,
        targetType: RemovalTargetType.SEASON,
        seasonNumber: 2,
        initiator: RemovalExecutionInitiator.MANUAL,
      });
      await assert.rejects(
        second.acquire({
          canonicalMediaId: target.id,
          targetType: RemovalTargetType.SERIES,
          initiator: RemovalExecutionInitiator.SCHEDULED,
        }),
        RemovalExecutionClaimConflictError
      );
      assert.equal(
        await fixture.first.getRepository(RemovalExecution).countBy({
          canonicalMediaId: target.id,
        }),
        1
      );
    } finally {
      await fixture.close();
    }
  });

  it('reclaims only an expired pre-provider execution and fences its stale owner', async () => {
    const fixture = await createConnections();
    let now = new Date('2026-10-11T12:00:00.000Z');
    try {
      const target = await movie(fixture.first, 'Pre-provider recovery');
      const coordinator = new RemovalExecutionCoordinator(
        fixture.first,
        () => now,
        1_000
      );
      const stale = await coordinator.acquire(claimInput(target.id));
      now = new Date(now.getTime() + 1_001);
      assert.deepEqual(await coordinator.recoverExpired(target.id), {
        outcome: 'released_pre_provider',
        executionId: stale.executionId,
        state: RemovalExecutionState.ABANDONED_PRE_PROVIDER,
      });

      const current = await coordinator.acquire(claimInput(target.id));
      assert.equal(current.fence, stale.fence + 1);
      await assert.rejects(
        coordinator.beginProvider(stale),
        RemovalExecutionOwnershipLostError
      );
      await coordinator.beginProvider(current);
    } finally {
      await fixture.close();
    }
  });

  it('quarantines expiry after the provider boundary without a destructive retry', async () => {
    const fixture = await createConnections();
    let now = new Date('2026-10-11T12:00:00.000Z');
    try {
      const target = await movie(fixture.first, 'Uncertain recovery');
      const coordinator = new RemovalExecutionCoordinator(
        fixture.first,
        () => now,
        1_000
      );
      const execution = await coordinator.acquire(claimInput(target.id));
      await coordinator.beginProvider(execution);
      now = new Date(now.getTime() + 1_001);
      const recovery = await coordinator.recoverExpired(target.id);
      assert.deepEqual(recovery, {
        outcome: 'quarantined',
        executionId: execution.executionId,
        state: RemovalExecutionState.UNCERTAIN,
      });
      await assert.rejects(
        coordinator.acquire(claimInput(target.id)),
        RemovalExecutionClaimConflictError
      );

      const reconciliation = await coordinator.acquireReconciliation(target.id);
      assert.equal(reconciliation.purpose, 'reconciliation');
      assert.equal(reconciliation.fence, execution.fence + 1);
      await coordinator.prepareReconciliation(reconciliation);
      await coordinator.complete(reconciliation, async () => undefined);

      const storedExecution = await fixture.first
        .getRepository(RemovalExecution)
        .findOneByOrFail({ id: execution.executionId });
      const storedClaim = await fixture.first
        .getRepository(RemovalExecutionClaim)
        .findOneByOrFail({ canonicalMediaId: target.id });
      assert.equal(storedExecution.state, RemovalExecutionState.COMPLETED);
      assert.equal(storedExecution.providerOutcome, 'absent');
      assert.equal(storedExecution.providerAcknowledgedAt, null);
      assert.ok(storedExecution.providerAbsentAt);
      assert.equal(storedExecution.physicalAbsenceConfirmedAt, null);
      assert.equal(storedClaim.executionId, null);
      assert.equal(storedClaim.ownerToken, null);
    } finally {
      await fixture.close();
    }
  });

  it('recovers acknowledged provider work for local reconciliation only', async () => {
    const fixture = await createConnections();
    let now = new Date('2026-10-11T12:00:00.000Z');
    try {
      const target = await movie(fixture.first, 'Acknowledged recovery');
      const coordinator = new RemovalExecutionCoordinator(
        fixture.first,
        () => now,
        1_000
      );
      const execution = await coordinator.acquire(claimInput(target.id));
      await coordinator.beginProvider(execution);
      await coordinator.recordProviderOutcome(execution, 'acknowledged');
      now = new Date(now.getTime() + 1_001);
      assert.deepEqual(await coordinator.recoverExpired(target.id), {
        outcome: 'quarantined',
        executionId: execution.executionId,
        state: RemovalExecutionState.RECONCILIATION_REQUIRED,
      });

      const reconciliation = await coordinator.acquireReconciliation(target.id);
      await coordinator.complete(reconciliation, async () => undefined);
      const stored = await fixture.first
        .getRepository(RemovalExecution)
        .findOneByOrFail({ id: execution.executionId });
      assert.equal(stored.state, RemovalExecutionState.COMPLETED);
      assert.equal(stored.providerOutcome, 'acknowledged');
      assert.ok(stored.providerAcknowledgedAt);
      assert.equal(stored.providerAbsentAt, null);
      assert.equal(stored.physicalAbsenceConfirmedAt, null);
    } finally {
      await fixture.close();
    }
  });

  it('refuses a Removal claim while a durable Series relocation owns the canonical target', async () => {
    const fixture = await createConnections();
    try {
      const target = await series(fixture.first, 'Relocation interlock');
      await fixture.first.getRepository(SeriesRelocationExecution).save(
        new SeriesRelocationExecution({
          id: '00000000-0000-4000-8000-000000000001',
          canonicalMediaId: target.id,
          state: SeriesRelocationState.VERIFYING,
          activeKey: `series:${target.id}`,
          serviceId: 1,
          sonarrSeriesId: 20,
          sourceRootFolderId: 3,
          destinationRootFolderId: 9,
          sourceVolumeId: 'physical:volume3',
          destinationVolumeId: 'physical:volume9',
          sourcePath: '/volume3/shows/Series',
          destinationPath: '/volume9/shows/Series',
          expectedEpisodeFileIds: [11],
          expectedFileCount: 1,
          expectedBytes: '100',
        })
      );
      const coordinator = new RemovalExecutionCoordinator(fixture.first);
      await assert.rejects(
        coordinator.acquire({
          canonicalMediaId: target.id,
          targetType: RemovalTargetType.SERIES,
          initiator: RemovalExecutionInitiator.MANUAL,
        }),
        RemovalExecutionStateError
      );
    } finally {
      await fixture.close();
    }
  });
});
