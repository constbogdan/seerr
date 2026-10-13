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
  CurrentLibraryGenerationService,
  LibraryHydrationEpochChangedError,
  LibraryHydrationEpochService,
} from '@server/lib/libraryHydrationEpoch';
import { In, type DataSource, type EntityManager } from 'typeorm';

export const CURRENT_VIEWING_SOURCE = 'jellyfin';
export const CURRENT_VIEWING_STAGE = 'current-viewing';
export const CURRENT_VIEWING_USER_STAGE = 'current-viewing-user';
const CURRENT_LIBRARY_STAGE = 'current-library';
const DEFAULT_LEASE_MS = 10 * 60_000;
const TRANSACTION_ATTEMPTS = 5;

export class CurrentViewingLibraryIncompleteError extends Error {}
export class CurrentViewingRunConflictError extends Error {}
export class CurrentViewingRunOwnershipLostError extends Error {}

export interface CurrentViewingRunSnapshot<T> {
  run: HydrationRun;
  libraryGeneration: number;
  value: T;
}

export interface CurrentViewingRunCompletion {
  succeeded: boolean;
  completedAt: Date;
  rowsInspected: number;
  rowsCreated: number;
  rowsUpdated: number;
  unresolvedCount: number;
  failureCode?: string | null;
  failureMessage?: string | null;
}

const databaseErrorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;

const retryableDatabaseContention = (error: unknown): boolean => {
  const code = databaseErrorCode(error);
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    code === '40001' ||
    code === '40P01'
  );
};

export class CurrentViewingRunHeartbeat {
  private pending = Promise.resolve();
  private failure: unknown;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly runId: number,
    private readonly coordinator: CurrentViewingRunCoordinator,
    intervalMs: number
  ) {
    this.timer = setInterval(() => {
      this.pending = this.pending.then(async () => {
        if (this.failure) return;
        try {
          await this.coordinator.renew(this.runId);
        } catch (error) {
          this.failure = error;
        }
      });
    }, intervalMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }

  public assertHealthy(): void {
    if (this.failure) {
      throw new CurrentViewingRunOwnershipLostError(
        'Current-viewing run heartbeat renewal failed'
      );
    }
  }
}

export class CurrentViewingRunCoordinator {
  private readonly generation: CurrentLibraryGenerationService;

  constructor(
    private readonly connection: DataSource = dataSource,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = DEFAULT_LEASE_MS
  ) {
    this.generation = new CurrentLibraryGenerationService(
      new LibraryHydrationEpochService(connection)
    );
  }

  public async transaction<T>(
    work: (manager: EntityManager) => Promise<T>
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.connection.transaction('SERIALIZABLE', work);
      } catch (error) {
        if (!retryableDatabaseContention(error)) throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  private leaseUntil(now: Date): Date {
    return new Date(now.getTime() + this.leaseMs);
  }

  private expired(run: HydrationRun, now: Date): boolean {
    const expiry =
      run.leaseExpiresAt ?? new Date(run.startedAt.getTime() + this.leaseMs);
    return expiry <= now;
  }

  private async lockCheckpoint(
    manager: EntityManager,
    sourceScope: string,
    stage: string,
    create: boolean
  ): Promise<SourceCheckpoint | null> {
    const repository = manager.getRepository(SourceCheckpoint);
    if (create) {
      await repository
        .createQueryBuilder()
        .insert()
        .values({
          source: CURRENT_VIEWING_SOURCE,
          sourceScope,
          stage,
          status: SourceCheckpointStatus.UNINITIALIZED,
        })
        .orIgnore()
        .updateEntity(false)
        .execute();
    }
    if (this.connection.options.type !== 'postgres') {
      await repository
        .createQueryBuilder()
        .update(SourceCheckpoint)
        .set({ status: () => '"status"' })
        .where('source = :source', { source: CURRENT_VIEWING_SOURCE })
        .andWhere('sourceScope = :sourceScope', { sourceScope })
        .andWhere('stage = :stage', { stage })
        .execute();
    }
    const query = repository
      .createQueryBuilder('checkpoint')
      .where('checkpoint.source = :source', {
        source: CURRENT_VIEWING_SOURCE,
      })
      .andWhere('checkpoint.sourceScope = :sourceScope', { sourceScope })
      .andWhere('checkpoint.stage = :stage', { stage });
    if (this.connection.options.type === 'postgres') {
      query.setLock('pessimistic_write');
    }
    return query.getOne();
  }

  private async lockRun(
    manager: EntityManager,
    runId: number
  ): Promise<HydrationRun> {
    const repository = manager.getRepository(HydrationRun);
    if (this.connection.options.type !== 'postgres') {
      await repository
        .createQueryBuilder()
        .update(HydrationRun)
        .set({ status: () => '"status"' })
        .where('id = :runId', { runId })
        .execute();
    }
    const query = repository
      .createQueryBuilder('run')
      .where('run.id = :runId', { runId });
    if (this.connection.options.type === 'postgres') {
      query.setLock('pessimistic_write');
    }
    return query.getOneOrFail();
  }

  private async markOwnedCheckpointsFailed(
    manager: EntityManager,
    run: HydrationRun,
    now: Date
  ): Promise<void> {
    const checkpoints = await manager.getRepository(SourceCheckpoint).findBy({
      source: CURRENT_VIEWING_SOURCE,
      stage: In([CURRENT_VIEWING_STAGE, CURRENT_VIEWING_USER_STAGE]),
      lastRunId: run.id,
      status: SourceCheckpointStatus.STALE,
    });
    checkpoints.forEach((checkpoint) => {
      checkpoint.status = SourceCheckpointStatus.FAILED;
      checkpoint.lastAttemptAt = now;
    });
    if (checkpoints.length > 0) {
      await manager.getRepository(SourceCheckpoint).save(checkpoints);
    }
  }

  private async cancelRun(
    manager: EntityManager,
    run: HydrationRun,
    now: Date,
    failureCode: string,
    failureMessage: string
  ): Promise<void> {
    run.status = HydrationRunStatus.CANCELLED;
    run.completedAt = now;
    run.coverageEndedAt = null;
    run.failureCode = failureCode;
    run.failureMessage = failureMessage;
    run.heartbeatAt = now;
    run.leaseExpiresAt = null;
    await manager.getRepository(HydrationRun).save(run);
    await this.markOwnedCheckpointsFailed(manager, run, now);
  }

  private async recoverPrior(
    manager: EntityManager,
    run: HydrationRun,
    currentGeneration: number,
    now: Date
  ): Promise<boolean> {
    if (run.status !== HydrationRunStatus.RUNNING) return true;
    if (this.expired(run, now)) {
      await this.cancelRun(
        manager,
        run,
        now,
        'AbandonedRun',
        'The current-viewing worker lease expired before completion.'
      );
      return true;
    }
    if (Number(run.sourceGeneration) !== currentGeneration) {
      await this.cancelRun(
        manager,
        run,
        now,
        'SupersededGeneration',
        'A newer Library generation superseded this viewing run.'
      );
      return true;
    }
    return false;
  }

  private async assertLibraryComplete(
    manager: EntityManager,
    sourceScope: string
  ): Promise<void> {
    const sourceCheckpoint = await this.lockCheckpoint(
      manager,
      sourceScope,
      CURRENT_LIBRARY_STAGE,
      false
    );
    const query = manager
      .getRepository(SourceCheckpoint)
      .createQueryBuilder('checkpoint')
      .where('checkpoint.stage = :stage', { stage: CURRENT_LIBRARY_STAGE });
    if (this.connection.options.type === 'postgres') {
      query.setLock('pessimistic_read');
    }
    const requiredCheckpoints = await query.getMany();
    if (
      sourceCheckpoint?.status !== SourceCheckpointStatus.CURRENT ||
      requiredCheckpoints.length === 0 ||
      requiredCheckpoints.some(
        ({ status }) => status !== SourceCheckpointStatus.CURRENT
      )
    ) {
      throw new CurrentViewingLibraryIncompleteError(
        'Required current Library hydration is not complete'
      );
    }
  }

  public async begin<T>(
    sourceScope: string,
    capture: (
      manager: EntityManager
    ) => Promise<{ value: T; sourceUserIds: string[] }>
  ): Promise<CurrentViewingRunSnapshot<T>> {
    return this.transaction(async (manager) => {
      const now = this.now();
      const libraryGeneration = await this.generation.capture(manager);
      await this.assertLibraryComplete(manager, sourceScope);
      const checkpoint = await this.lockCheckpoint(
        manager,
        sourceScope,
        CURRENT_VIEWING_STAGE,
        true
      );
      if (!checkpoint) throw new Error('Viewing checkpoint was not created');
      if (checkpoint.lastRunId) {
        const prior = await this.lockRun(manager, checkpoint.lastRunId);
        if (
          !(await this.recoverPrior(manager, prior, libraryGeneration, now))
        ) {
          throw new CurrentViewingRunConflictError(
            'A live viewing run already owns this source checkpoint'
          );
        }
      }

      const captured = await capture(manager);
      await this.generation.assert(manager, libraryGeneration);
      const run = await manager.getRepository(HydrationRun).save(
        new HydrationRun({
          source: CURRENT_VIEWING_SOURCE,
          sourceScope,
          sourceGeneration: String(libraryGeneration),
          stage: CURRENT_VIEWING_STAGE,
          status: HydrationRunStatus.RUNNING,
          startedAt: now,
          coverageStartedAt: now,
          heartbeatAt: now,
          leaseExpiresAt: this.leaseUntil(now),
        })
      );

      checkpoint.sourceGeneration = String(libraryGeneration);
      checkpoint.status = SourceCheckpointStatus.STALE;
      checkpoint.lastAttemptAt = now;
      checkpoint.lastRunId = run.id;
      await manager.getRepository(SourceCheckpoint).save(checkpoint);

      for (const sourceUserId of [...new Set(captured.sourceUserIds)]) {
        const userCheckpoint = await this.lockCheckpoint(
          manager,
          `${sourceScope}:${sourceUserId}`,
          CURRENT_VIEWING_USER_STAGE,
          true
        );
        if (!userCheckpoint) {
          throw new Error('Viewing user checkpoint was not created');
        }
        userCheckpoint.sourceGeneration = String(libraryGeneration);
        userCheckpoint.status = SourceCheckpointStatus.STALE;
        userCheckpoint.lastAttemptAt = now;
        userCheckpoint.lastRunId = run.id;
        await manager.getRepository(SourceCheckpoint).save(userCheckpoint);
      }
      return { run, libraryGeneration, value: captured.value };
    });
  }

  public async assertOwnership(
    runId: number,
    manager?: EntityManager
  ): Promise<HydrationRun> {
    const assertion = async (ownedManager: EntityManager) => {
      const now = this.now();
      const run = await this.lockRun(ownedManager, runId);
      const checkpoint = await this.lockCheckpoint(
        ownedManager,
        run.sourceScope,
        CURRENT_VIEWING_STAGE,
        false
      );
      if (
        run.source !== CURRENT_VIEWING_SOURCE ||
        run.stage !== CURRENT_VIEWING_STAGE ||
        run.status !== HydrationRunStatus.RUNNING ||
        this.expired(run, now) ||
        checkpoint?.lastRunId !== run.id ||
        checkpoint.status !== SourceCheckpointStatus.STALE
      ) {
        throw new CurrentViewingRunOwnershipLostError(
          'Current-viewing run ownership is no longer valid'
        );
      }
      const generation = Number(run.sourceGeneration);
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new CurrentViewingRunOwnershipLostError(
          'Current-viewing run has an invalid Library generation'
        );
      }
      try {
        await this.generation.assert(ownedManager, generation);
      } catch (error) {
        if (!(error instanceof LibraryHydrationEpochChangedError)) throw error;
        throw new CurrentViewingRunOwnershipLostError(
          'The current Library generation changed during viewing sync'
        );
      }
      try {
        await this.assertLibraryComplete(ownedManager, run.sourceScope);
      } catch (error) {
        if (!(error instanceof CurrentViewingLibraryIncompleteError)) {
          throw error;
        }
        throw new CurrentViewingRunOwnershipLostError(
          'Current Library completeness changed during viewing sync'
        );
      }
      return run;
    };
    return manager ? assertion(manager) : this.transaction(assertion);
  }

  public async assertUserOwnership(
    manager: EntityManager,
    run: HydrationRun,
    sourceUserId: string
  ): Promise<SourceCheckpoint> {
    await this.assertOwnership(run.id, manager);
    const checkpoint = await this.lockCheckpoint(
      manager,
      `${run.sourceScope}:${sourceUserId}`,
      CURRENT_VIEWING_USER_STAGE,
      false
    );
    if (
      checkpoint?.lastRunId !== run.id ||
      checkpoint.status !== SourceCheckpointStatus.STALE
    ) {
      throw new CurrentViewingRunOwnershipLostError(
        'Current-viewing user checkpoint ownership was lost'
      );
    }
    return checkpoint;
  }

  public async renew(runId: number): Promise<HydrationRun> {
    return this.transaction(async (manager) => {
      const run = await this.assertOwnership(runId, manager);
      const now = this.now();
      run.heartbeatAt = now;
      run.leaseExpiresAt = this.leaseUntil(now);
      return manager.getRepository(HydrationRun).save(run);
    });
  }

  public heartbeat(
    runId: number,
    intervalMs = Math.max(1_000, Math.floor(this.leaseMs / 3))
  ): CurrentViewingRunHeartbeat {
    return new CurrentViewingRunHeartbeat(runId, this, intervalMs);
  }

  public async complete(
    runId: number,
    completion: CurrentViewingRunCompletion
  ): Promise<void> {
    await this.transaction(async (manager) => {
      const run = await this.assertOwnership(runId, manager);
      const checkpoint = await this.lockCheckpoint(
        manager,
        run.sourceScope,
        CURRENT_VIEWING_STAGE,
        false
      );
      if (!checkpoint || checkpoint.lastRunId !== run.id) {
        throw new CurrentViewingRunOwnershipLostError(
          'Current-viewing checkpoint ownership was lost before completion'
        );
      }
      run.status = completion.succeeded
        ? HydrationRunStatus.SUCCEEDED
        : HydrationRunStatus.FAILED;
      run.completedAt = completion.completedAt;
      run.coverageEndedAt = completion.succeeded
        ? completion.completedAt
        : null;
      run.rowsInspected = completion.rowsInspected;
      run.rowsCreated = completion.rowsCreated;
      run.rowsUpdated = completion.rowsUpdated;
      run.unresolvedCount = completion.unresolvedCount;
      run.failureCode = completion.failureCode ?? null;
      run.failureMessage = completion.failureMessage ?? null;
      run.heartbeatAt = completion.completedAt;
      run.leaseExpiresAt = null;
      await manager.getRepository(HydrationRun).save(run);

      checkpoint.status = completion.succeeded
        ? SourceCheckpointStatus.CURRENT
        : SourceCheckpointStatus.FAILED;
      checkpoint.sourceGeneration = run.sourceGeneration;
      checkpoint.lastAttemptAt = completion.completedAt;
      if (completion.succeeded) {
        checkpoint.lastSuccessfulAt = completion.completedAt;
      }
      await manager.getRepository(SourceCheckpoint).save(checkpoint);
      if (!completion.succeeded) {
        await this.markOwnedCheckpointsFailed(
          manager,
          run,
          completion.completedAt
        );
      }
    });
  }

  public async recoverExpiredRuns(): Promise<number> {
    const candidates = await this.connection.getRepository(HydrationRun).find({
      where: {
        source: CURRENT_VIEWING_SOURCE,
        stage: CURRENT_VIEWING_STAGE,
        status: HydrationRunStatus.RUNNING,
      },
      order: { id: 'ASC' },
    });
    let recovered = 0;
    for (const candidate of candidates) {
      const changed = await this.transaction(async (manager) => {
        const run = await this.lockRun(manager, candidate.id);
        if (
          run.status !== HydrationRunStatus.RUNNING ||
          !this.expired(run, this.now())
        ) {
          return false;
        }
        await this.cancelRun(
          manager,
          run,
          this.now(),
          'AbandonedRun',
          'The current-viewing worker lease expired before completion.'
        );
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }
}

const currentViewingRunCoordinator = new CurrentViewingRunCoordinator();
export default currentViewingRunCoordinator;
