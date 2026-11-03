import {
  HydrationRunStatus,
  SourceCheckpointStatus,
} from '@server/constants/libraryHistory';
import dataSource from '@server/datasource';
import {
  HydrationRun,
  SourceCheckpoint,
} from '@server/entity/LibraryHydration';
import {
  CurrentViewingLibraryIncompleteError,
  CurrentViewingRunConflictError,
  CurrentViewingRunCoordinator,
  CurrentViewingRunOwnershipLostError,
} from '@server/lib/currentViewingRunCoordinator';
import {
  CurrentLibraryGenerationService,
  LibraryHydrationEpochService,
} from '@server/lib/libraryHydrationEpoch';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('CurrentViewingRunCoordinator', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'seerr-viewing-runs-'));
  const databasePath = path.join(directory, 'db.sqlite3');
  let first: DataSource;
  let second: DataSource;
  let now = new Date('2026-10-11T12:00:00.000Z');
  const clock = () => new Date(now);

  const createCurrentLibraryCheckpoint = async (scope: string) => {
    await first.getRepository(SourceCheckpoint).save(
      new SourceCheckpoint({
        source: 'jellyfin',
        sourceScope: scope,
        stage: 'current-library',
        status: SourceCheckpointStatus.CURRENT,
        lastSuccessfulAt: clock(),
      })
    );
  };

  const complete = (coordinator: CurrentViewingRunCoordinator, runId: number) =>
    coordinator.complete(runId, {
      succeeded: true,
      completedAt: clock(),
      rowsInspected: 0,
      rowsCreated: 0,
      rowsUpdated: 0,
      unresolvedCount: 0,
    });

  before(async () => {
    first = new DataSource({
      type: 'sqlite',
      database: databasePath,
      entities: dataSource.options.entities,
      migrations: ['server/migration/sqlite/*.ts'],
      synchronize: false,
    });
    await first.initialize();
    await first.runMigrations();
    second = new DataSource({
      type: 'sqlite',
      database: databasePath,
      entities: dataSource.options.entities,
      synchronize: false,
    });
    await second.initialize();
  });

  after(async () => {
    if (second?.isInitialized) await second.destroy();
    if (first?.isInitialized) await first.destroy();
    rmSync(directory, { recursive: true, force: true });
  });

  it('captures work and creates owned stale checkpoints in one transaction', async () => {
    const scope = 'viewing:atomic';
    await createCurrentLibraryCheckpoint(scope);
    const coordinator = new CurrentViewingRunCoordinator(first, clock, 100);
    const generation = new CurrentLibraryGenerationService(
      new LibraryHydrationEpochService(first)
    );
    const expectedGeneration = await generation.capture();
    const snapshot = await coordinator.begin(scope, async (manager) => ({
      value: await manager.getRepository(SourceCheckpoint).countBy({
        source: 'jellyfin',
        sourceScope: scope,
        stage: 'current-library',
      }),
      sourceUserIds: ['viewer-a', 'viewer-b'],
    }));

    assert.equal(snapshot.libraryGeneration, expectedGeneration);
    assert.equal(snapshot.value, 1);
    assert.equal(snapshot.run.status, HydrationRunStatus.RUNNING);
    assert.equal(
      snapshot.run.leaseExpiresAt?.toISOString(),
      new Date(now.getTime() + 100).toISOString()
    );
    const checkpoints = await first.getRepository(SourceCheckpoint).findBy({
      source: 'jellyfin',
      lastRunId: snapshot.run.id,
    });
    assert.deepEqual(
      checkpoints.map(({ stage, status }) => [stage, status]).sort(),
      [
        ['current-viewing', SourceCheckpointStatus.STALE],
        ['current-viewing-user', SourceCheckpointStatus.STALE],
        ['current-viewing-user', SourceCheckpointStatus.STALE],
      ].sort()
    );
    await complete(coordinator, snapshot.run.id);
  });

  it('refuses to capture targets while the current Library is incomplete', async () => {
    const scope = 'viewing:incomplete';
    const coordinator = new CurrentViewingRunCoordinator(first, clock, 100);
    let captured = false;
    await assert.rejects(
      coordinator.begin(scope, async () => {
        captured = true;
        return { value: null, sourceUserIds: [] };
      }),
      CurrentViewingLibraryIncompleteError
    );
    assert.equal(captured, false);
  });

  it('requires every established current-Library source checkpoint to be current', async () => {
    const scope = 'viewing:required-sources';
    await createCurrentLibraryCheckpoint(scope);
    await first.getRepository(SourceCheckpoint).save(
      new SourceCheckpoint({
        source: 'sonarr',
        sourceScope: 'service:required-sources',
        stage: 'current-library',
        status: SourceCheckpointStatus.STALE,
      })
    );
    const coordinator = new CurrentViewingRunCoordinator(first, clock, 100);

    await assert.rejects(
      coordinator.begin(scope, async () => ({
        value: null,
        sourceUserIds: [],
      })),
      CurrentViewingLibraryIncompleteError
    );
    await first.getRepository(SourceCheckpoint).update(
      {
        source: 'sonarr',
        sourceScope: 'service:required-sources',
        stage: 'current-library',
      },
      { status: SourceCheckpointStatus.CURRENT }
    );
  });

  it('allows only one connection to own a source generation', async () => {
    const scope = 'viewing:race';
    await createCurrentLibraryCheckpoint(scope);
    const left = new CurrentViewingRunCoordinator(first, clock, 100);
    const right = new CurrentViewingRunCoordinator(second, clock, 100);
    const results = await Promise.allSettled([
      left.begin(scope, async () => ({ value: 'left', sourceUserIds: [] })),
      right.begin(scope, async () => ({ value: 'right', sourceUserIds: [] })),
    ]);

    assert.equal(
      results.filter(({ status }) => status === 'fulfilled').length,
      1
    );
    const rejected = results.find(({ status }) => status === 'rejected');
    assert.equal(rejected?.status, 'rejected');
    if (rejected?.status === 'rejected') {
      assert.ok(rejected.reason instanceof CurrentViewingRunConflictError);
    }
    const winner = results.find(({ status }) => status === 'fulfilled');
    if (winner?.status === 'fulfilled') {
      await complete(left, winner.value.run.id);
    }
  });

  it('fences a stale generation and lets a newer run supersede it', async () => {
    const scope = 'viewing:generation';
    await createCurrentLibraryCheckpoint(scope);
    const coordinator = new CurrentViewingRunCoordinator(first, clock, 100);
    const generation = new CurrentLibraryGenerationService(
      new LibraryHydrationEpochService(first)
    );
    const stale = await coordinator.begin(scope, async () => ({
      value: null,
      sourceUserIds: ['viewer-a'],
    }));
    const epochs = new LibraryHydrationEpochService(first);
    const sourceEpoch = await epochs.capture('sonarr', 'service:unchanged');
    await first.transaction('SERIALIZABLE', async (manager) => {
      await generation.advance(manager);
    });
    assert.equal(
      await epochs.capture('sonarr', 'service:unchanged'),
      sourceEpoch
    );

    await assert.rejects(
      coordinator.assertOwnership(stale.run.id),
      CurrentViewingRunOwnershipLostError
    );
    await assert.rejects(
      complete(coordinator, stale.run.id),
      CurrentViewingRunOwnershipLostError
    );
    const replacement = await coordinator.begin(scope, async () => ({
      value: null,
      sourceUserIds: ['viewer-a'],
    }));
    const superseded = await first
      .getRepository(HydrationRun)
      .findOneByOrFail({ id: stale.run.id });
    assert.equal(superseded.status, HydrationRunStatus.CANCELLED);
    assert.equal(superseded.failureCode, 'SupersededGeneration');
    await complete(coordinator, replacement.run.id);
  });

  it('renews ownership and recovers only expired current-viewing runs', async () => {
    const scope = 'viewing:recovery';
    await createCurrentLibraryCheckpoint(scope);
    const coordinator = new CurrentViewingRunCoordinator(first, clock, 100);
    const snapshot = await coordinator.begin(scope, async () => ({
      value: null,
      sourceUserIds: ['viewer-a', 'viewer-b'],
    }));
    const historical = await first.getRepository(HydrationRun).save(
      new HydrationRun({
        source: 'jellystat',
        sourceScope: 'artifact',
        sourceGeneration: 'october-4',
        stage: 'historical-viewing',
        status: HydrationRunStatus.RUNNING,
        startedAt: new Date(now.getTime() - 1_000),
        heartbeatAt: new Date(now.getTime() - 1_000),
        leaseExpiresAt: new Date(now.getTime() - 500),
      })
    );

    const committedUser = await first
      .getRepository(SourceCheckpoint)
      .findOneByOrFail({
        source: 'jellyfin',
        sourceScope: `${scope}:viewer-a`,
        stage: 'current-viewing-user',
      });
    committedUser.status = SourceCheckpointStatus.CURRENT;
    committedUser.lastSuccessfulAt = clock();
    await first.getRepository(SourceCheckpoint).save(committedUser);

    now = new Date(now.getTime() + 50);
    await coordinator.renew(snapshot.run.id);
    now = new Date(now.getTime() + 60);
    assert.equal(await coordinator.recoverExpiredRuns(), 0);
    now = new Date(now.getTime() + 41);
    assert.equal(await coordinator.recoverExpiredRuns(), 1);
    const abandoned = await first
      .getRepository(HydrationRun)
      .findOneByOrFail({ id: snapshot.run.id });
    assert.equal(abandoned.status, HydrationRunStatus.CANCELLED);
    assert.equal(abandoned.failureCode, 'AbandonedRun');
    await assert.rejects(
      complete(coordinator, snapshot.run.id),
      CurrentViewingRunOwnershipLostError
    );
    assert.equal(
      (
        await first
          .getRepository(HydrationRun)
          .findOneByOrFail({ id: historical.id })
      ).status,
      HydrationRunStatus.RUNNING
    );
    assert.equal(
      (
        await first.getRepository(SourceCheckpoint).findOneByOrFail({
          source: 'jellyfin',
          sourceScope: `${scope}:viewer-b`,
          stage: 'current-viewing-user',
        })
      ).status,
      SourceCheckpointStatus.FAILED
    );
    assert.equal(
      (
        await first.getRepository(SourceCheckpoint).findOneByOrFail({
          source: 'jellyfin',
          sourceScope: `${scope}:viewer-a`,
          stage: 'current-viewing-user',
        })
      ).status,
      SourceCheckpointStatus.CURRENT
    );
  });
});
