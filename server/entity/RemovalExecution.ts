import type {
  RemovalExecutionInitiator,
  RemovalExecutionPhase,
  RemovalExecutionState,
  RemovalProviderOutcome,
  RemovalTargetType,
} from '@server/constants/removal';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('removal_execution')
@Check(
  'CHK_removal_execution_target',
  `"targetType" IN ('movie', 'series', 'season')`
)
@Check(
  'CHK_removal_execution_season',
  `("targetType" = 'season' AND "seasonNumber" IS NOT NULL) OR ("targetType" <> 'season' AND "seasonNumber" IS NULL)`
)
@Check(
  'CHK_removal_execution_initiator',
  `"initiator" IN ('manual', 'bulk', 'scheduled')`
)
@Check(
  'CHK_removal_execution_state',
  `"state" IN ('claimed', 'provider_in_flight', 'provider_acknowledged', 'provider_absent', 'reconciliation_required', 'uncertain', 'completed', 'failed_pre_provider', 'failed_provider', 'cancelled_pre_provider', 'abandoned_pre_provider')`
)
@Check(
  'CHK_removal_execution_provider_outcome',
  `"providerOutcome" IS NULL OR "providerOutcome" IN ('acknowledged', 'absent')`
)
@Index('IDX_removal_execution_media_created', ['canonicalMediaId', 'createdAt'])
@Index('IDX_removal_execution_state_updated', ['state', 'updatedAt'])
@Index('IDX_removal_execution_schedule', ['scheduleId'])
export class RemovalExecution {
  @PrimaryColumn({ type: 'varchar', length: 36 }) public id: string;

  @Column({ type: 'int' }) public canonicalMediaId: number;
  @ManyToOne(() => CanonicalMedia, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'canonicalMediaId',
    foreignKeyConstraintName: 'FK_removal_execution_media',
  })
  public canonicalMedia: CanonicalMedia;

  @Column({ type: 'varchar', length: 8 })
  public targetType: RemovalTargetType;
  @Column({ type: 'int', nullable: true }) public seasonNumber?: number | null;
  @Column({ type: 'varchar', length: 16 })
  public initiator: RemovalExecutionInitiator;
  @Column({ type: 'varchar', length: 32 })
  public state: RemovalExecutionState;
  @Column({ type: 'int' }) public fence: number;

  @Column({ type: 'varchar', length: 16, nullable: true })
  public sourceSystem?: 'radarr' | 'sonarr' | null;
  @Column({ type: 'varchar', length: 128, nullable: true })
  public sourceScope?: string | null;
  @Column({ type: 'varchar', length: 128, nullable: true })
  public sourceItemId?: string | null;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public sourceGeneration?: string | null;
  @Column({ type: 'int', nullable: true })
  public libraryPresenceId?: number | null;
  @ManyToOne(() => LibraryPresence, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'libraryPresenceId',
    foreignKeyConstraintName: 'FK_removal_execution_presence',
  })
  public libraryPresence?: LibraryPresence | null;

  @Column({ type: 'int', nullable: true }) public scheduleId?: number | null;
  @Column({ type: 'int', nullable: true })
  public scheduleRevision?: number | null;
  @Column({ type: 'varchar', length: 16, nullable: true })
  public providerOutcome?: RemovalProviderOutcome | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public providerStartedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public providerAcknowledgedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public providerAbsentAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public physicalAbsenceConfirmedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public reconciledAt?: Date | null;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public failureCode?: string | null;
  @Column({ type: 'text', nullable: true })
  public failureMessage?: string | null;

  @CreateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<RemovalExecution>) {
    Object.assign(this, init);
  }
}

@Entity('removal_execution_claim')
@Unique('UQ_removal_execution_claim_execution', ['executionId'])
@Check(
  'CHK_removal_execution_claim_phase',
  `"phase" IS NULL OR "phase" IN ('pre_provider', 'provider', 'reconciliation', 'uncertain')`
)
@Index('IDX_removal_execution_claim_lease', ['leaseUntil'])
export class RemovalExecutionClaim {
  @PrimaryColumn({ type: 'int' }) public canonicalMediaId: number;
  @ManyToOne(() => CanonicalMedia, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'canonicalMediaId',
    foreignKeyConstraintName: 'FK_removal_execution_claim_media',
  })
  public canonicalMedia: CanonicalMedia;

  @Column({ type: 'varchar', length: 36, nullable: true })
  public executionId?: string | null;
  @ManyToOne(() => RemovalExecution, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'executionId',
    foreignKeyConstraintName: 'FK_removal_execution_claim_execution',
  })
  public execution?: RemovalExecution | null;

  @Column({ type: 'int', default: 0 }) public fence = 0;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public ownerToken?: string | null;
  @Column({ type: 'varchar', length: 24, nullable: true })
  public phase?: RemovalExecutionPhase | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public leaseUntil?: Date | null;

  @CreateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<RemovalExecutionClaim>) {
    Object.assign(this, init);
  }
}
