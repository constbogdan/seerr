import {
  HydrationRunStatus,
  LibraryMediaType,
  SourceCheckpointStatus,
} from '@server/constants/libraryHistory';
import dataSource from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import {
  HydrationRun,
  LibraryHydrationEpoch,
  SourceCheckpoint,
} from '@server/entity/LibraryHydration';
import {
  CurrentLibraryGenerationService,
  LibraryHydrationEpochService,
} from '@server/lib/libraryHydrationEpoch';
import {
  LibraryHydrationRunConflictError,
  LibraryHydrationRunCoordinator,
  LibraryHydrationRunOwnershipLostError,
} from '@server/lib/libraryHydrationRunCoordinator';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('LibraryHydrationRunCoordinator', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'seerr-hydration-runs-'));
  const databasePath = path.join(directory, 'db.sqlite3');
  let first: DataSource;
  let second: DataSource;
  let now = new Date('2026-10-11T12:00:00.000Z');
  const clock = () => new Date(now);
  const complete = (
    coordinator: LibraryHydrationRunCoordinator,
    runId: number
  ) =>
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

  it('atomically starts a run, invalidates its checkpoint, and advances the global generation', async () => {
    const coordinator = new LibraryHydrationRunCoordinator(first, clock, 100);
    const generation = new CurrentLibraryGenerationService(
      new LibraryHydrationEpochService(first)
    );
    const beforeGeneration = await generation.capture();
    const run = await coordinator.begin('radarr', 'service:atomic', true);

    assert.equal(Number(run.sourceGeneration), beforeGeneration + 1);
    assert.equal(await generation.capture(), beforeGeneration + 1);
    assert.equal(run.heartbeatAt?.toISOString(), now.toISOString());
    assert.equal(
      run.leaseExpiresAt?.toISOString(),
      new Date(now.getTime() + 100).toISOString()
    );
    const checkpoint = await first
      .getRepository(SourceCheckpoint)
      .findOneByOrFail({
        source: 'radarr',
        sourceScope: 'service:atomic',
        stage: 'current-library',
      });
    assert.equal(checkpoint.status, SourceCheckpointStatus.STALE);
    assert.equal(checkpoint.lastRunId, run.id);
    await complete(coordinator, run.id);
  });

  it('allows only one of two database connections to own a source checkpoint', async () => {
    const left = new LibraryHydrationRunCoordinator(first, clock, 100);
    const right = new LibraryHydrationRunCoordinator(second, clock, 100);
    const results = await Promise.allSettled([
      left.begin('sonarr', 'service:race', true),
      right.begin('sonarr', 'service:race', true),
    ]);

    assert.equal(
      results.filter(({ status }) => status === 'fulfilled').length,
      1
    );
    const rejection = results.find(({ status }) => status === 'rejected');
    assert.equal(rejection?.status, 'rejected');
    if (rejection?.status === 'rejected') {
      assert.ok(
        rejection.reason instanceof LibraryHydrationRunConflictError,
        String(rejection.reason?.stack ?? rejection.reason)
      );
    }
    const winner = results.find(({ status }) => status === 'fulfilled');
    if (winner?.status === 'fulfilled') await complete(left, winner.value.id);
  });

  it('fences an older membership run when another source advances the logical Library generation', async () => {
    const coordinator = new LibraryHydrationRunCoordinator(first, clock, 100);
    const older = await coordinator.begin(
      'radarr',
      'service:cross-source',
      true
    );
    const newer = await coordinator.begin(
      'sonarr',
      'service:cross-source',
      true
    );

    await assert.rejects(
      complete(coordinator, older.id),
      LibraryHydrationRunOwnershipLostError
    );
    assert.equal(
      (
        await first.getRepository(SourceCheckpoint).findOneByOrFail({
          source: 'radarr',
          sourceScope: 'service:cross-source',
          stage: 'current-library',
        })
      ).status,
      SourceCheckpointStatus.STALE
    );
    await complete(coordinator, newer.id);

    const retry = await coordinator.begin(
      'radarr',
      'service:cross-source',
      true
    );
    assert.equal(
      (
        await first
          .getRepository(HydrationRun)
          .findOneByOrFail({ id: older.id })
      ).failureCode,
      'SupersededGeneration'
    );
    await complete(coordinator, retry.id);
  });

  it('abandons an expired owner before granting a replacement and fences the stale worker', async () => {
    const coordinator = new LibraryHydrationRunCoordinator(first, clock, 100);
    const original = await coordinator.begin(
      'jellyfin',
      'server:superseded',
      true
    );
    now = new Date(now.getTime() + 101);
    const replacement = await coordinator.begin(
      'jellyfin',
      'server:superseded',
      true
    );

    assert.notEqual(replacement.id, original.id);
    assert.equal(
      (
        await first
          .getRepository(HydrationRun)
          .findOneByOrFail({ id: original.id })
      ).status,
      HydrationRunStatus.CANCELLED
    );
    await assert.rejects(
      coordinator.assertOwnership(original.id),
      LibraryHydrationRunOwnershipLostError
    );
    await assert.rejects(
      complete(coordinator, original.id),
      LibraryHydrationRunOwnershipLostError
    );
    assert.equal(
      (
        await first.getRepository(SourceCheckpoint).findOneByOrFail({
          source: 'jellyfin',
          sourceScope: 'server:superseded',
          stage: 'current-library',
        })
      ).lastRunId,
      replacement.id
    );
    await complete(coordinator, replacement.id);
  });

  it('renews leases and recovers abandoned current-library runs conditionally', async () => {
    const coordinator = new LibraryHydrationRunCoordinator(first, clock, 100);
    const run = await coordinator.begin('radarr', 'service:renew', true);
    now = new Date(now.getTime() + 50);
    await coordinator.renew(run.id);
    now = new Date(now.getTime() + 60);
    assert.equal(await coordinator.recoverExpiredRuns(), 0);
    now = new Date(now.getTime() + 41);
    assert.equal(await coordinator.recoverExpiredRuns(), 1);
    assert.equal(
      (await first.getRepository(HydrationRun).findOneByOrFail({ id: run.id }))
        .failureCode,
      'AbandonedRun'
    );
  });

  it('invalidates ownership when fenced removal advances the global generation without changing source epochs', async () => {
    const coordinator = new LibraryHydrationRunCoordinator(first, clock, 100);
    const epochs = new LibraryHydrationEpochService(first);
    const generation = new CurrentLibraryGenerationService(epochs);
    const run = await coordinator.begin('sonarr', 'service:barrier', true);
    const sourceEpoch = await epochs.capture('sonarr', 'service:barrier');

    await first.transaction('SERIALIZABLE', async (manager) => {
      await generation.advance(manager);
    });

    assert.equal(
      await epochs.capture('sonarr', 'service:barrier'),
      sourceEpoch
    );
    await assert.rejects(
      coordinator.assertOwnership(run.id),
      LibraryHydrationRunOwnershipLostError
    );
    const replacement = await coordinator.begin(
      'sonarr',
      'service:barrier',
      true
    );
    const superseded = await first
      .getRepository(HydrationRun)
      .findOneByOrFail({ id: run.id });
    assert.equal(superseded.status, HydrationRunStatus.CANCELLED);
    assert.equal(superseded.failureCode, 'SupersededGeneration');
    await complete(coordinator, replacement.id);
  });

  it('recovers an abandoned incremental write without claiming complete coverage and converges on retry', async () => {
    const coordinator = new LibraryHydrationRunCoordinator(first, clock, 100);
    const run = await coordinator.begin('radarr', 'service:partial', true);
    let presenceId = 0;
    await first.transaction('SERIALIZABLE', async (manager) => {
      await coordinator.assertOwnership(run.id, manager);
      const canonical = await manager.getRepository(CanonicalMedia).save(
        new CanonicalMedia({
          mediaType: LibraryMediaType.MOVIE,
          titleSnapshot: 'Partial',
        })
      );
      const presence = await manager.getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId: canonical.id,
          sourceSystem: 'radarr',
          sourceScope: 'service:partial',
          sourceItemId: 'movie:1',
          firstObservedAt: clock(),
          lastSeenAt: clock(),
          isCurrent: true,
        })
      );
      presenceId = presence.id;
    });

    now = new Date(now.getTime() + 101);
    assert.equal(await coordinator.recoverExpiredRuns(), 1);
    assert.equal(
      (await first.getRepository(HydrationRun).findOneByOrFail({ id: run.id }))
        .status,
      HydrationRunStatus.CANCELLED
    );
    const failedCheckpoint = await first
      .getRepository(SourceCheckpoint)
      .findOneByOrFail({
        source: 'radarr',
        sourceScope: 'service:partial',
        stage: 'current-library',
      });
    assert.equal(failedCheckpoint.status, SourceCheckpointStatus.FAILED);
    assert.equal(
      (
        await first.getRepository(LibraryPresence).findOneByOrFail({
          id: presenceId,
        })
      ).isCurrent,
      true
    );

    const retry = await coordinator.begin('radarr', 'service:partial', true);
    await first.transaction('SERIALIZABLE', async (manager) => {
      await coordinator.assertOwnership(retry.id, manager);
      const presence = await manager
        .getRepository(LibraryPresence)
        .findOneByOrFail({ id: presenceId });
      presence.lastSeenAt = clock();
      await manager.getRepository(LibraryPresence).save(presence);
    });
    await complete(coordinator, retry.id);
    assert.equal(
      (
        await first.getRepository(SourceCheckpoint).findOneByOrFail({
          source: 'radarr',
          sourceScope: 'service:partial',
          stage: 'current-library',
        })
      ).status,
      SourceCheckpointStatus.CURRENT
    );
  });

  it('does not recover historical-import runs', async () => {
    const repository = first.getRepository(HydrationRun);
    const historical = await repository.save(
      new HydrationRun({
        source: 'jellystat',
        sourceScope: 'artifact',
        stage: 'historical-viewing',
        status: HydrationRunStatus.RUNNING,
        startedAt: new Date(now.getTime() - 1_000),
        heartbeatAt: new Date(now.getTime() - 1_000),
        leaseExpiresAt: new Date(now.getTime() - 500),
      })
    );
    const coordinator = new LibraryHydrationRunCoordinator(first, clock, 100);

    await coordinator.recoverExpiredRuns();

    assert.equal(
      (await repository.findOneByOrFail({ id: historical.id })).status,
      HydrationRunStatus.RUNNING
    );
    assert.equal(
      await first.getRepository(LibraryHydrationEpoch).countBy({
        sourceSystem: 'library',
        sourceScope: 'current-membership',
      }),
      1
    );
  });
});
