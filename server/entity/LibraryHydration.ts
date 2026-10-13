import {
  HydrationRunStatus,
  SourceCheckpointStatus,
} from '@server/constants/libraryHistory';
import { LibraryPresence, StorageRoot } from '@server/entity/LibraryHistory';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import type { ValueTransformer } from 'typeorm';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('library_hydration_epoch')
export class LibraryHydrationEpoch {
  @Column({ type: 'varchar', length: 16, primary: true })
  public sourceSystem: string;
  @Column({ type: 'varchar', length: 128, primary: true })
  public sourceScope: string;
  @Column({ type: 'int', default: 0 }) public epoch = 0;

  constructor(init?: Partial<LibraryHydrationEpoch>) {
    Object.assign(this, init);
  }
}

const nullableBigintString: ValueTransformer = {
  to: (value?: string | null) => value ?? null,
  from: (value?: string | number | null) =>
    value === null || value === undefined ? null : String(value),
};

@Entity('hydration_run')
@Index('IDX_hydration_run_source_started', [
  'source',
  'sourceScope',
  'startedAt',
])
@Index('IDX_hydration_run_status_lease', ['status', 'leaseExpiresAt'])
export class HydrationRun {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 32 }) public source: string;
  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public sourceGeneration?: string | null;
  @Column({ type: 'varchar', length: 64 }) public stage: string;
  @Column({ type: 'int', default: HydrationRunStatus.RUNNING })
  public status = HydrationRunStatus.RUNNING;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public startedAt: Date;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public completedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public coverageStartedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public coverageEndedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public heartbeatAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public leaseExpiresAt?: Date | null;
  @Column({ type: 'int', default: 0 }) public rowsInspected = 0;
  @Column({ type: 'int', default: 0 }) public rowsCreated = 0;
  @Column({ type: 'int', default: 0 }) public rowsUpdated = 0;
  @Column({ type: 'int', default: 0 }) public unresolvedCount = 0;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public failureCode?: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true })
  public failureMessage?: string | null;

  constructor(init?: Partial<HydrationRun>) {
    Object.assign(this, init);
  }
}

@Entity('source_checkpoint')
@Unique('UQ_source_checkpoint_identity', ['source', 'sourceScope', 'stage'])
@Index('IDX_source_checkpoint_status', ['status', 'lastSuccessfulAt'])
export class SourceCheckpoint {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 32 }) public source: string;
  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 64 }) public stage: string;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public sourceGeneration?: string | null;
  @Column({ type: 'text', nullable: true }) public cursor?: string | null;
  @Column({ type: 'int', default: SourceCheckpointStatus.UNINITIALIZED })
  public status = SourceCheckpointStatus.UNINITIALIZED;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastAttemptAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSuccessfulAt?: Date | null;
  @Column({ type: 'int', nullable: true }) public lastRunId?: number | null;
  @ManyToOne(() => HydrationRun, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'lastRunId',
    foreignKeyConstraintName: 'FK_source_checkpoint_run',
  })
  public lastRun?: HydrationRun | null;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<SourceCheckpoint>) {
    Object.assign(this, init);
  }
}

@Entity('library_source_observation')
@Unique('UQ_library_source_observation_identity', [
  'source',
  'sourceScope',
  'sourceGeneration',
  'sourceObservationId',
])
@Index('IDX_library_source_observation_presence', [
  'libraryPresenceId',
  'observedAt',
])
export class LibrarySourceObservation {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public libraryPresenceId: number;
  @ManyToOne(() => LibraryPresence, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'libraryPresenceId',
    foreignKeyConstraintName: 'FK_library_source_observation_presence',
  })
  public libraryPresence: LibraryPresence;

  @Column({ type: 'varchar', length: 32 }) public source: string;
  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 64, default: '' })
  public sourceGeneration = '';
  @Column({ type: 'varchar', length: 255 })
  public sourceObservationId: string;
  @Column({ type: 'int', nullable: true }) public hydrationRunId?:
    | number
    | null;
  @ManyToOne(() => HydrationRun, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'hydrationRunId',
    foreignKeyConstraintName: 'FK_library_source_observation_run',
  })
  public hydrationRun?: HydrationRun | null;

  @Column({ type: 'int', nullable: true }) public storageRootId?: number | null;
  @ManyToOne(() => StorageRoot, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'storageRootId',
    foreignKeyConstraintName: 'FK_library_source_observation_root',
  })
  public storageRoot?: StorageRoot | null;
  @Column({ type: 'text', nullable: true }) public pathSnapshot?: string | null;
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: nullableBigintString,
  })
  public logicalSizeBytes?: string | null;
  @Column({ type: 'boolean', nullable: true })
  public servarrManaged?: boolean | null;
  @Column({ type: 'boolean', nullable: true })
  public servarrHasFile?: boolean | null;
  @Column({ type: 'boolean', nullable: true })
  public jellyfinVisible?: boolean | null;
  @DbAwareColumn({ type: 'datetime' }) public observedAt: Date;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<LibrarySourceObservation>) {
    Object.assign(this, init);
  }
}
