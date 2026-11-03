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
import type { DataSource, EntityManager } from 'typeorm';

export const CURRENT_LIBRARY_STAGE = 'current-library';
const DEFAULT_LEASE_MS = 10 * 60_000;
const TRANSACTION_ATTEMPTS = 5;

export class LibraryHydrationRunConflictError extends Error {}
export class LibraryHydrationRunOwnershipLostError extends Error {}

export interface LibraryHydrationRunCompletion {
  succeeded: boolean;
  completedAt: Date;
  coverageEndedAt?: Date | null;
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

export class LibraryHydrationRunHeartbeat {
  private pending = Promise.resolve();
  private failure: unknown;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly runId: number,
    private readonly coordinator: LibraryHydrationRunCoordinator,
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

  public async assert(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
    await this.coordinator.assertOwnership(this.runId);
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}

export class LibraryHydrationRunCoordinator {
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

  private async transaction<T>(
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

  private async lockCheckpoint(
    manager: EntityManager,
    source: string,
    sourceScope: string,
    create: boolean
  ): Promise<SourceCheckpoint | null> {
    const repository = manager.getRepository(SourceCheckpoint);
    if (create) {
      await repository
        .createQueryBuilder()
        .insert()
        .values({
          source,
          sourceScope,
          stage: CURRENT_LIBRARY_STAGE,
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
        .where('source = :source', { source })
        .andWhere('sourceScope = :sourceScope', { sourceScope })
        .andWhere('stage = :stage', { stage: CURRENT_LIBRARY_STAGE })
        .execute();
    }
    const query = repository
      .createQueryBuilder('checkpoint')
      .where('checkpoint.source = :source', { source })
      .andWhere('checkpoint.sourceScope = :sourceScope', { sourceScope })
      .andWhere('checkpoint.stage = :stage', {
        stage: CURRENT_LIBRARY_STAGE,
      });
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

  private expired(run: HydrationRun, now: Date): boolean {
    const expiry =
      run.leaseExpiresAt ?? new Date(run.startedAt.getTime() + this.leaseMs);
    return expiry <= now;
  }

  private async abandon(
    manager: EntityManager,
    run: HydrationRun,
    now: Date
  ): Promise<boolean> {
    if (run.status !== HydrationRunStatus.RUNNING || !this.expired(run, now)) {
      return false;
    }
    await this.cancelRun(
      manager,
      run,
      now,
      'AbandonedRun',
      'The hydration worker lease expired before completion.'
    );
    return true;
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
    const checkpoint = await this.lockCheckpoint(
      manager,
      run.source,
      run.sourceScope,
      false
    );
    if (checkpoint?.lastRunId === run.id) {
      checkpoint.status = SourceCheckpointStatus.FAILED;
      checkpoint.lastAttemptAt = now;
      await manager.getRepository(SourceCheckpoint).save(checkpoint);
    }
  }

  private async abandonSupersededGeneration(
    manager: EntityManager,
    run: HydrationRun,
    now: Date
  ): Promise<boolean> {
    if (
      run.status !== HydrationRunStatus.RUNNING ||
      run.sourceGeneration === null ||
      run.sourceGeneration === undefined
    ) {
      return false;
    }
    const expected = Number(run.sourceGeneration);
    if (!Number.isSafeInteger(expected) || expected < 0) {
      await this.cancelRun(
        manager,
        run,
        now,
        'InvalidGeneration',
        'The hydration run has an invalid Library generation.'
      );
      return true;
    }
    try {
      await this.generation.assert(manager, expected);
      return false;
    } catch (error) {
      if (!(error instanceof LibraryHydrationEpochChangedError)) throw error;
      await this.cancelRun(
        manager,
        run,
        now,
        'SupersededGeneration',
        'A newer Library generation superseded this hydration run.'
      );
      return true;
    }
  }

  public async begin(
    source: string,
    sourceScope: string,
    affectsCurrentMembership: boolean
  ): Promise<HydrationRun> {
    return this.transaction(async (manager) => {
      const now = this.now();
      const checkpoint = await this.lockCheckpoint(
        manager,
        source,
        sourceScope,
        true
      );
      if (!checkpoint) throw new Error('Hydration checkpoint was not created');
      if (checkpoint.lastRunId) {
        const prior = await this.lockRun(manager, checkpoint.lastRunId);
        if (prior.status === HydrationRunStatus.RUNNING) {
          const abandoned =
            (await this.abandon(manager, prior, now)) ||
            (await this.abandonSupersededGeneration(manager, prior, now));
          if (!abandoned) {
            throw new LibraryHydrationRunConflictError(
              'A live hydration run already owns this source checkpoint'
            );
          }
        }
      }
      const generation = affectsCurrentMembership
        ? await this.generation.advance(manager)
        : null;
      const run = await manager.getRepository(HydrationRun).save(
        new HydrationRun({
          source,
          sourceScope,
          sourceGeneration: generation === null ? null : String(generation),
          stage: CURRENT_LIBRARY_STAGE,
          status: HydrationRunStatus.RUNNING,
          startedAt: now,
          coverageStartedAt: now,
          heartbeatAt: now,
          leaseExpiresAt: this.leaseUntil(now),
        })
      );
      checkpoint.status = SourceCheckpointStatus.STALE;
      checkpoint.lastAttemptAt = now;
      checkpoint.lastRunId = run.id;
      await manager.getRepository(SourceCheckpoint).save(checkpoint);
      return run;
    });
  }

  public async assertOwnership(
    runId: number,
    manager?: EntityManager
  ): Promise<HydrationRun> {
    const assert = async (ownedManager: EntityManager) => {
      const now = this.now();
      const run = await this.lockRun(ownedManager, runId);
      const checkpoint = await this.lockCheckpoint(
        ownedManager,
        run.source,
        run.sourceScope,
        false
      );
      if (
        run.status !== HydrationRunStatus.RUNNING ||
        this.expired(run, now) ||
        checkpoint?.lastRunId !== run.id ||
        checkpoint.status !== SourceCheckpointStatus.STALE
      ) {
        throw new LibraryHydrationRunOwnershipLostError(
          'Hydration run ownership is no longer valid'
        );
      }
      if (run.sourceGeneration !== null && run.sourceGeneration !== undefined) {
        const generation = Number(run.sourceGeneration);
        if (!Number.isSafeInteger(generation) || generation < 0) {
          throw new LibraryHydrationRunOwnershipLostError(
            'Hydration run has an invalid Library generation'
          );
        }
        try {
          await this.generation.assert(ownedManager, generation);
        } catch (error) {
          if (!(error instanceof LibraryHydrationEpochChangedError))
            throw error;
          throw new LibraryHydrationRunOwnershipLostError(
            'The current Library generation changed during hydration'
          );
        }
      }
      return run;
    };
    return manager ? assert(manager) : this.transaction(assert);
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
  ): LibraryHydrationRunHeartbeat {
    return new LibraryHydrationRunHeartbeat(runId, this, intervalMs);
  }

  public async complete(
    runId: number,
    completion: LibraryHydrationRunCompletion
  ): Promise<void> {
    await this.transaction(async (manager) => {
      const run = await this.assertOwnership(runId, manager);
      const checkpoint = await this.lockCheckpoint(
        manager,
        run.source,
        run.sourceScope,
        false
      );
      if (!checkpoint || checkpoint.lastRunId !== run.id) {
        throw new LibraryHydrationRunOwnershipLostError(
          'Hydration checkpoint ownership was lost before completion'
        );
      }
      run.status = completion.succeeded
        ? HydrationRunStatus.SUCCEEDED
        : HydrationRunStatus.FAILED;
      run.completedAt = completion.completedAt;
      run.coverageEndedAt = completion.succeeded
        ? (completion.coverageEndedAt ?? completion.completedAt)
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
      checkpoint.sourceGeneration = run.sourceGeneration ?? null;
      checkpoint.lastAttemptAt = completion.completedAt;
      if (completion.succeeded) {
        checkpoint.lastSuccessfulAt = completion.completedAt;
      }
      await manager.getRepository(SourceCheckpoint).save(checkpoint);
    });
  }

  public async recoverExpiredRuns(): Promise<number> {
    const candidates = await this.connection.getRepository(HydrationRun).find({
      where: {
        stage: CURRENT_LIBRARY_STAGE,
        status: HydrationRunStatus.RUNNING,
      },
      order: { id: 'ASC' },
    });
    let recovered = 0;
    for (const candidate of candidates) {
      const changed = await this.transaction(async (manager) => {
        const run = await this.lockRun(manager, candidate.id);
        return this.abandon(manager, run, this.now());
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }
}

const libraryHydrationRunCoordinator = new LibraryHydrationRunCoordinator();
export default libraryHydrationRunCoordinator;
