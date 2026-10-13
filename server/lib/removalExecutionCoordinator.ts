import { randomUUID } from 'crypto';

import { LibraryMediaType } from '@server/constants/libraryHistory';
import {
  RemovalExecutionInitiator,
  RemovalExecutionPhase,
  RemovalExecutionState,
  RemovalTargetType,
  type RemovalExecutionInitiator as RemovalExecutionInitiatorType,
  type RemovalProviderOutcome,
} from '@server/constants/removal';
import dataSource from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import {
  RemovalExecution,
  RemovalExecutionClaim,
} from '@server/entity/RemovalExecution';
import { LessThanOrEqual, type DataSource, type EntityManager } from 'typeorm';

const DEFAULT_LEASE_MS = 10 * 60_000;
const TRANSACTION_ATTEMPTS = 5;

const ACTIVE_EXECUTION_STATES = new Set([
  RemovalExecutionState.CLAIMED,
  RemovalExecutionState.PROVIDER_IN_FLIGHT,
  RemovalExecutionState.PROVIDER_ACKNOWLEDGED,
  RemovalExecutionState.PROVIDER_ABSENT,
  RemovalExecutionState.RECONCILIATION_REQUIRED,
  RemovalExecutionState.UNCERTAIN,
]);

const RECONCILIATION_STATES = new Set([
  RemovalExecutionState.UNCERTAIN,
  RemovalExecutionState.RECONCILIATION_REQUIRED,
]);

export class RemovalExecutionClaimConflictError extends Error {
  constructor(public readonly execution: RemovalExecution) {
    super('A removal execution already owns this canonical media target');
  }
}

export class RemovalExecutionOwnershipLostError extends Error {}
export class RemovalExecutionStateError extends Error {}

export interface RemovalExecutionClaimInput {
  canonicalMediaId: number;
  targetType: RemovalTargetType;
  seasonNumber?: number;
  initiator: RemovalExecutionInitiatorType;
  sourceSystem?: 'radarr' | 'sonarr';
  sourceScope?: string;
  sourceItemId?: string;
  sourceGeneration?: string;
  libraryPresenceId?: number;
  scheduleId?: number;
  scheduleRevision?: number;
}

export interface RemovalExecutionOwnership {
  canonicalMediaId: number;
  executionId: string;
  fence: number;
  ownerToken: string;
  leaseUntil: Date;
  purpose: 'execution' | 'reconciliation';
}

export class RemovalExecutionHeartbeat {
  private pending = Promise.resolve();
  private failure: unknown;
  private timer?: NodeJS.Timeout;

  constructor(
    private ownership: RemovalExecutionOwnership,
    private readonly coordinator: RemovalExecutionCoordinator,
    intervalMs: number
  ) {
    this.timer = setInterval(() => {
      this.pending = this.pending.then(async () => {
        if (this.failure) return;
        try {
          this.ownership = await this.coordinator.renew(this.ownership);
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
    await this.coordinator.assertOwnership(this.ownership);
  }

  public async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}

export type RemovalExecutionRecoveryResult =
  | { outcome: 'not_found' | 'not_expired' | 'already_quarantined' }
  | {
      outcome: 'released_pre_provider' | 'quarantined';
      executionId: string;
      state: RemovalExecutionState;
    };

const validTarget = (input: RemovalExecutionClaimInput): boolean =>
  (input.targetType === RemovalTargetType.SEASON &&
    Number.isInteger(input.seasonNumber) &&
    input.seasonNumber! >= 0) ||
  (input.targetType !== RemovalTargetType.SEASON &&
    input.seasonNumber === undefined);

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

export class RemovalExecutionCoordinator {
  constructor(
    private readonly connection: DataSource = dataSource,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = DEFAULT_LEASE_MS,
    private readonly uuid: () => string = randomUUID
  ) {}

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

  private async lockCanonicalMedia(
    manager: EntityManager,
    canonicalMediaId: number
  ): Promise<CanonicalMedia> {
    const query = manager
      .getRepository(CanonicalMedia)
      .createQueryBuilder('canonical')
      .where('canonical.id = :canonicalMediaId', { canonicalMediaId });
    if (this.connection.options.type === 'postgres') {
      query.setLock('pessimistic_write');
    }
    return query.getOneOrFail();
  }

  private async lockClaim(
    manager: EntityManager,
    canonicalMediaId: number,
    create: boolean
  ): Promise<RemovalExecutionClaim | null> {
    const repository = manager.getRepository(RemovalExecutionClaim);
    if (create) {
      await repository
        .createQueryBuilder()
        .insert()
        .values({ canonicalMediaId, fence: 0 })
        .orIgnore()
        .execute();
    }
    if (this.connection.options.type !== 'postgres') {
      await repository
        .createQueryBuilder()
        .update(RemovalExecutionClaim)
        .set({ fence: () => '"fence"' })
        .where('canonicalMediaId = :canonicalMediaId', { canonicalMediaId })
        .execute();
    }
    const query = repository
      .createQueryBuilder('claim')
      .where('claim.canonicalMediaId = :canonicalMediaId', {
        canonicalMediaId,
      });
    if (this.connection.options.type === 'postgres') {
      query.setLock('pessimistic_write');
    }
    return query.getOne();
  }

  private leaseUntil(): Date {
    return new Date(this.now().getTime() + this.leaseMs);
  }

  private async loadExecution(
    manager: EntityManager,
    executionId: string
  ): Promise<RemovalExecution> {
    return manager
      .getRepository(RemovalExecution)
      .findOneByOrFail({ id: executionId });
  }

  private async requireOwnership(
    manager: EntityManager,
    ownership: RemovalExecutionOwnership,
    states: ReadonlySet<RemovalExecutionState>
  ): Promise<{
    claim: RemovalExecutionClaim;
    execution: RemovalExecution;
  }> {
    const claim = await this.lockClaim(
      manager,
      ownership.canonicalMediaId,
      false
    );
    const current = this.now();
    if (
      !claim ||
      claim.executionId !== ownership.executionId ||
      claim.fence !== ownership.fence ||
      claim.ownerToken !== ownership.ownerToken ||
      !claim.leaseUntil ||
      claim.leaseUntil <= current
    ) {
      throw new RemovalExecutionOwnershipLostError(
        'Removal execution ownership is no longer valid'
      );
    }
    const execution = await this.loadExecution(manager, ownership.executionId);
    if (execution.fence !== ownership.fence || !states.has(execution.state)) {
      throw new RemovalExecutionStateError(
        `Removal execution cannot transition from ${execution.state}`
      );
    }
    return { claim, execution };
  }

  private async releaseClaim(
    manager: EntityManager,
    claim: RemovalExecutionClaim
  ): Promise<void> {
    claim.executionId = null;
    claim.ownerToken = null;
    claim.phase = null;
    claim.leaseUntil = null;
    await manager.getRepository(RemovalExecutionClaim).save(claim);
  }

  public async acquire(
    input: RemovalExecutionClaimInput,
    verify?: (manager: EntityManager) => Promise<void>
  ): Promise<RemovalExecutionOwnership> {
    if (!validTarget(input)) {
      throw new RemovalExecutionStateError(
        'Removal execution target coordinates are invalid'
      );
    }
    return this.transaction(async (manager) => {
      const canonical = await this.lockCanonicalMedia(
        manager,
        input.canonicalMediaId
      );
      const canonicalType =
        canonical.mediaType === LibraryMediaType.MOVIE
          ? RemovalTargetType.MOVIE
          : RemovalTargetType.SERIES;
      if (
        (canonicalType === RemovalTargetType.MOVIE &&
          input.targetType !== RemovalTargetType.MOVIE) ||
        (canonicalType === RemovalTargetType.SERIES &&
          input.targetType === RemovalTargetType.MOVIE)
      ) {
        throw new RemovalExecutionStateError(
          'Removal execution target does not match canonical media type'
        );
      }

      await verify?.(manager);

      const claim = await this.lockClaim(manager, input.canonicalMediaId, true);
      if (!claim) throw new Error('Removal execution claim was not created');
      if (claim.executionId) {
        throw new RemovalExecutionClaimConflictError(
          await this.loadExecution(manager, claim.executionId)
        );
      }

      const executionId = this.uuid();
      const ownerToken = this.uuid();
      const fence = claim.fence + 1;
      const leaseUntil = this.leaseUntil();
      const execution = manager.getRepository(RemovalExecution).create({
        id: executionId,
        canonicalMediaId: input.canonicalMediaId,
        targetType: input.targetType,
        seasonNumber: input.seasonNumber ?? null,
        initiator: input.initiator,
        state: RemovalExecutionState.CLAIMED,
        fence,
        sourceSystem: input.sourceSystem ?? null,
        sourceScope: input.sourceScope ?? null,
        sourceItemId: input.sourceItemId ?? null,
        sourceGeneration: input.sourceGeneration ?? null,
        libraryPresenceId: input.libraryPresenceId ?? null,
        scheduleId: input.scheduleId ?? null,
        scheduleRevision: input.scheduleRevision ?? null,
      });
      await manager.getRepository(RemovalExecution).save(execution);

      claim.executionId = executionId;
      claim.fence = fence;
      claim.ownerToken = ownerToken;
      claim.phase = RemovalExecutionPhase.PRE_PROVIDER;
      claim.leaseUntil = leaseUntil;
      await manager.getRepository(RemovalExecutionClaim).save(claim);
      return {
        canonicalMediaId: input.canonicalMediaId,
        executionId,
        fence,
        ownerToken,
        leaseUntil,
        purpose: 'execution',
      };
    });
  }

  public async renew(
    ownership: RemovalExecutionOwnership
  ): Promise<RemovalExecutionOwnership> {
    return this.transaction(async (manager) => {
      const { claim } = await this.requireOwnership(
        manager,
        ownership,
        ACTIVE_EXECUTION_STATES
      );
      const leaseUntil = this.leaseUntil();
      claim.leaseUntil = leaseUntil;
      await manager.getRepository(RemovalExecutionClaim).save(claim);
      return { ...ownership, leaseUntil };
    });
  }

  public async beginProvider(
    ownership: RemovalExecutionOwnership,
    verify?: (
      manager: EntityManager,
      execution: RemovalExecution
    ) => Promise<void>
  ): Promise<void> {
    if (ownership.purpose !== 'execution') {
      throw new RemovalExecutionStateError(
        'Reconciliation ownership cannot execute a provider command'
      );
    }
    await this.transaction(async (manager) => {
      const { claim, execution } = await this.requireOwnership(
        manager,
        ownership,
        new Set([RemovalExecutionState.CLAIMED])
      );
      await verify?.(manager, execution);
      execution.state = RemovalExecutionState.PROVIDER_IN_FLIGHT;
      execution.providerStartedAt = this.now();
      claim.phase = RemovalExecutionPhase.PROVIDER;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
    });
  }

  public async assertOwnership(
    ownership: RemovalExecutionOwnership,
    states: ReadonlySet<RemovalExecutionState> = ACTIVE_EXECUTION_STATES
  ): Promise<void> {
    await this.transaction(async (manager) => {
      await this.requireOwnership(manager, ownership, states);
    });
  }

  public async recordProviderOutcome(
    ownership: RemovalExecutionOwnership,
    outcome: RemovalProviderOutcome
  ): Promise<void> {
    await this.transaction(async (manager) => {
      const { claim, execution } = await this.requireOwnership(
        manager,
        ownership,
        new Set([RemovalExecutionState.PROVIDER_IN_FLIGHT])
      );
      execution.state =
        outcome === 'acknowledged'
          ? RemovalExecutionState.PROVIDER_ACKNOWLEDGED
          : RemovalExecutionState.PROVIDER_ABSENT;
      execution.providerOutcome = outcome;
      if (outcome === 'acknowledged') {
        execution.providerAcknowledgedAt = this.now();
      } else {
        execution.providerAbsentAt = this.now();
        execution.physicalAbsenceConfirmedAt = this.now();
      }
      claim.phase = RemovalExecutionPhase.RECONCILIATION;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
    });
  }

  public async markUncertain(
    ownership: RemovalExecutionOwnership,
    failureCode: string,
    failureMessage: string
  ): Promise<void> {
    await this.transaction(async (manager) => {
      const { claim, execution } = await this.requireOwnership(
        manager,
        ownership,
        new Set([RemovalExecutionState.PROVIDER_IN_FLIGHT])
      );
      execution.state = RemovalExecutionState.UNCERTAIN;
      execution.failureCode = failureCode;
      execution.failureMessage = failureMessage;
      claim.ownerToken = null;
      claim.leaseUntil = null;
      claim.phase = RemovalExecutionPhase.UNCERTAIN;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
    });
  }

  /**
   * Quarantines a provider-bound execution only while its fence and token still
   * match. Unlike normal transitions this deliberately permits an expired
   * lease: expiry cannot make a potentially executed provider command safe to
   * retry, but a newer fence must always win.
   */
  public async quarantineProviderOutcomeIfOwned(
    ownership: RemovalExecutionOwnership,
    failureCode: string,
    failureMessage: string
  ): Promise<boolean> {
    return this.transaction(async (manager) => {
      const claim = await this.lockClaim(
        manager,
        ownership.canonicalMediaId,
        false
      );
      if (
        !claim ||
        claim.executionId !== ownership.executionId ||
        claim.fence !== ownership.fence ||
        claim.ownerToken !== ownership.ownerToken
      ) {
        return false;
      }
      const execution = await this.loadExecution(
        manager,
        ownership.executionId
      );
      if (
        execution.fence !== ownership.fence ||
        execution.state !== RemovalExecutionState.PROVIDER_IN_FLIGHT
      ) {
        return false;
      }
      execution.state = RemovalExecutionState.UNCERTAIN;
      execution.failureCode = failureCode;
      execution.failureMessage = failureMessage;
      claim.ownerToken = null;
      claim.leaseUntil = null;
      claim.phase = RemovalExecutionPhase.UNCERTAIN;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
      return true;
    });
  }

  public async requireReconciliationIfOwned(
    ownership: RemovalExecutionOwnership,
    failureCode: string,
    failureMessage: string
  ): Promise<boolean> {
    return this.transaction(async (manager) => {
      const claim = await this.lockClaim(
        manager,
        ownership.canonicalMediaId,
        false
      );
      if (
        !claim ||
        claim.executionId !== ownership.executionId ||
        claim.fence !== ownership.fence ||
        claim.ownerToken !== ownership.ownerToken
      ) {
        return false;
      }
      const execution = await this.loadExecution(
        manager,
        ownership.executionId
      );
      if (
        execution.fence !== ownership.fence ||
        (execution.state !== RemovalExecutionState.PROVIDER_ACKNOWLEDGED &&
          execution.state !== RemovalExecutionState.PROVIDER_ABSENT)
      ) {
        return false;
      }
      execution.state = RemovalExecutionState.RECONCILIATION_REQUIRED;
      execution.failureCode = failureCode;
      execution.failureMessage = failureMessage;
      claim.ownerToken = null;
      claim.leaseUntil = null;
      claim.phase = RemovalExecutionPhase.RECONCILIATION;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
      return true;
    });
  }

  public async endBeforeProvider(
    ownership: RemovalExecutionOwnership,
    state:
      | RemovalExecutionState.FAILED_PRE_PROVIDER
      | RemovalExecutionState.CANCELLED_PRE_PROVIDER,
    failureCode?: string,
    failureMessage?: string
  ): Promise<void> {
    await this.transaction(async (manager) => {
      const { claim, execution } = await this.requireOwnership(
        manager,
        ownership,
        new Set([RemovalExecutionState.CLAIMED])
      );
      execution.state = state;
      execution.failureCode = failureCode ?? null;
      execution.failureMessage = failureMessage ?? null;
      await manager.getRepository(RemovalExecution).save(execution);
      await this.releaseClaim(manager, claim);
    });
  }

  public async complete<T>(
    ownership: RemovalExecutionOwnership,
    reconcile: (
      manager: EntityManager,
      execution: RemovalExecution
    ) => Promise<T>
  ): Promise<T> {
    return this.transaction(async (manager) => {
      const { claim, execution } = await this.requireOwnership(
        manager,
        ownership,
        new Set([
          RemovalExecutionState.PROVIDER_ACKNOWLEDGED,
          RemovalExecutionState.PROVIDER_ABSENT,
          RemovalExecutionState.RECONCILIATION_REQUIRED,
        ])
      );
      const result = await reconcile(manager, execution);
      execution.state = RemovalExecutionState.COMPLETED;
      execution.reconciledAt = this.now();
      await manager.getRepository(RemovalExecution).save(execution);
      await this.releaseClaim(manager, claim);
      return result;
    });
  }

  public async recoverExpired(
    canonicalMediaId: number
  ): Promise<RemovalExecutionRecoveryResult> {
    return this.transaction(async (manager) => {
      const claim = await this.lockClaim(manager, canonicalMediaId, false);
      if (!claim?.executionId) return { outcome: 'not_found' };
      if (!claim.ownerToken || !claim.leaseUntil) {
        return { outcome: 'already_quarantined' };
      }
      if (claim.leaseUntil > this.now()) return { outcome: 'not_expired' };
      const execution = await this.loadExecution(manager, claim.executionId);

      if (execution.state === RemovalExecutionState.CLAIMED) {
        execution.state = RemovalExecutionState.ABANDONED_PRE_PROVIDER;
        await manager.getRepository(RemovalExecution).save(execution);
        await this.releaseClaim(manager, claim);
        return {
          outcome: 'released_pre_provider',
          executionId: execution.id,
          state: execution.state,
        };
      }

      if (execution.state === RemovalExecutionState.PROVIDER_IN_FLIGHT) {
        execution.state = RemovalExecutionState.UNCERTAIN;
        claim.phase = RemovalExecutionPhase.UNCERTAIN;
      } else if (
        execution.state === RemovalExecutionState.PROVIDER_ACKNOWLEDGED ||
        execution.state === RemovalExecutionState.PROVIDER_ABSENT
      ) {
        execution.state = RemovalExecutionState.RECONCILIATION_REQUIRED;
        claim.phase = RemovalExecutionPhase.RECONCILIATION;
      } else if (!RECONCILIATION_STATES.has(execution.state)) {
        throw new RemovalExecutionStateError(
          `Expired removal execution has invalid state ${execution.state}`
        );
      }
      claim.ownerToken = null;
      claim.leaseUntil = null;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
      return {
        outcome: 'quarantined',
        executionId: execution.id,
        state: execution.state,
      };
    });
  }

  public async recoverExpiredClaims(limit = 100): Promise<{
    released: number;
    quarantined: number;
  }> {
    const current = this.now();
    const claims = await this.connection
      .getRepository(RemovalExecutionClaim)
      .find({
        where: { leaseUntil: LessThanOrEqual(current) },
        order: { canonicalMediaId: 'ASC' },
        take: limit,
      });
    let released = 0;
    let quarantined = 0;
    for (const claim of claims) {
      const result = await this.recoverExpired(claim.canonicalMediaId);
      if (result.outcome === 'released_pre_provider') released += 1;
      if (result.outcome === 'quarantined') quarantined += 1;
    }
    return { released, quarantined };
  }

  public async acquireReconciliation(
    canonicalMediaId: number
  ): Promise<RemovalExecutionOwnership> {
    return this.transaction(async (manager) => {
      const claim = await this.lockClaim(manager, canonicalMediaId, false);
      if (!claim?.executionId) {
        throw new RemovalExecutionStateError(
          'No removal execution requires reconciliation'
        );
      }
      if (claim.ownerToken || claim.leaseUntil) {
        throw new RemovalExecutionClaimConflictError(
          await this.loadExecution(manager, claim.executionId)
        );
      }
      const execution = await this.loadExecution(manager, claim.executionId);
      if (!RECONCILIATION_STATES.has(execution.state)) {
        throw new RemovalExecutionStateError(
          `Removal execution cannot be reconciled from ${execution.state}`
        );
      }
      const ownerToken = this.uuid();
      const leaseUntil = this.leaseUntil();
      const fence = claim.fence + 1;
      claim.fence = fence;
      claim.ownerToken = ownerToken;
      claim.leaseUntil = leaseUntil;
      claim.phase = RemovalExecutionPhase.RECONCILIATION;
      execution.fence = fence;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
      return {
        canonicalMediaId,
        executionId: execution.id,
        fence,
        ownerToken,
        leaseUntil,
        purpose: 'reconciliation',
      };
    });
  }

  public async releaseReconciliation(
    ownership: RemovalExecutionOwnership
  ): Promise<void> {
    if (ownership.purpose !== 'reconciliation') {
      throw new RemovalExecutionStateError(
        'Only reconciliation ownership can be released this way'
      );
    }
    await this.transaction(async (manager) => {
      const { claim } = await this.requireOwnership(
        manager,
        ownership,
        RECONCILIATION_STATES
      );
      claim.ownerToken = null;
      claim.leaseUntil = null;
      await manager.getRepository(RemovalExecutionClaim).save(claim);
    });
  }

  public async listReconciliationRequired(
    limit = 100
  ): Promise<RemovalExecution[]> {
    return this.connection.getRepository(RemovalExecution).find({
      where: [
        {
          state: RemovalExecutionState.UNCERTAIN,
        },
        {
          state: RemovalExecutionState.RECONCILIATION_REQUIRED,
        },
      ],
      order: { updatedAt: 'ASC', id: 'ASC' },
      take: limit,
    });
  }

  public async listScheduledReconciliationRequired(
    limit = 100
  ): Promise<RemovalExecution[]> {
    const executions = await this.listReconciliationRequired(limit);
    return executions.filter(
      ({ initiator }) => initiator === RemovalExecutionInitiator.SCHEDULED
    );
  }

  public async prepareReconciliation(
    ownership: RemovalExecutionOwnership
  ): Promise<void> {
    if (ownership.purpose !== 'reconciliation') {
      throw new RemovalExecutionStateError(
        'Execution ownership cannot resolve an uncertain provider outcome'
      );
    }
    await this.transaction(async (manager) => {
      const { claim, execution } = await this.requireOwnership(
        manager,
        ownership,
        new Set([RemovalExecutionState.UNCERTAIN])
      );
      execution.state = RemovalExecutionState.RECONCILIATION_REQUIRED;
      execution.providerOutcome = 'absent';
      execution.providerAbsentAt = this.now();
      claim.phase = RemovalExecutionPhase.RECONCILIATION;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
    });
  }

  public async confirmPhysicalAbsence(
    ownership: RemovalExecutionOwnership
  ): Promise<void> {
    if (ownership.purpose !== 'reconciliation') {
      throw new RemovalExecutionStateError(
        'Execution ownership cannot confirm physical absence'
      );
    }
    await this.transaction(async (manager) => {
      const { claim, execution } = await this.requireOwnership(
        manager,
        ownership,
        RECONCILIATION_STATES
      );
      execution.state = RemovalExecutionState.RECONCILIATION_REQUIRED;
      execution.physicalAbsenceConfirmedAt = this.now();
      if (!execution.providerOutcome) {
        execution.providerOutcome = 'absent';
        execution.providerAbsentAt = this.now();
      }
      claim.phase = RemovalExecutionPhase.RECONCILIATION;
      await manager.getRepository(RemovalExecution).save(execution);
      await manager.getRepository(RemovalExecutionClaim).save(claim);
    });
  }
}

const removalExecutionCoordinator = new RemovalExecutionCoordinator();
export default removalExecutionCoordinator;
