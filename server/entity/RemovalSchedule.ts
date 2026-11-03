import type {
  RemovalScheduleOrigin,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('removal_schedule')
@Check(
  'CHK_removal_schedule_target',
  `"targetType" IN ('movie', 'series', 'season')`
)
@Check('CHK_removal_schedule_origin', `"origin" IN ('manual', 'automatic')`)
@Check(
  'CHK_removal_schedule_status',
  `"status" IN ('active', 'deferred', 'completed', 'cancelled', 'failed')`
)
@Check(
  'CHK_removal_schedule_season',
  `("targetType" = 'season' AND "seasonNumber" IS NOT NULL) OR ("targetType" <> 'season' AND "seasonNumber" IS NULL)`
)
@Unique('UQ_removal_schedule_active_key', ['activeKey'])
@Index('IDX_removal_schedule_due', ['status', 'removeAt'])
@Index('IDX_removal_schedule_media', ['canonicalMediaId', 'status'])
export class RemovalSchedule {
  @PrimaryGeneratedColumn() public id: number;

  @Column({ type: 'int' }) public canonicalMediaId: number;
  @ManyToOne(() => CanonicalMedia, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'canonicalMediaId',
    foreignKeyConstraintName: 'FK_removal_schedule_media',
  })
  public canonicalMedia: CanonicalMedia;

  @Column({ type: 'varchar', length: 8 })
  public targetType: RemovalTargetType;
  @Column({ type: 'int', nullable: true }) public seasonNumber?: number | null;
  @Column({ type: 'varchar', length: 16 }) public sourceSystem:
    | 'radarr'
    | 'sonarr';
  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 16 })
  public origin: RemovalScheduleOrigin;
  @Column({ type: 'varchar', length: 16 })
  public status: RemovalScheduleStatus;

  /** Non-null only while active/deferred; provides portable uniqueness. */
  @Column({ type: 'varchar', length: 320, nullable: true })
  public activeKey?: string | null;

  @DbAwareColumn({ type: 'datetime' }) public scheduledAt: Date;
  @DbAwareColumn({ type: 'datetime' }) public removeAt: Date;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public activityBaselineAt?: Date | null;
  @Column({ type: 'int', default: 1 }) public revision = 1;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public failureCode?: string | null;
  @Column({ type: 'text', nullable: true }) public failureMessage?:
    | string
    | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastAttemptAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public completedAt?: Date | null;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public leaseToken?: string | null;
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

  constructor(init?: Partial<RemovalSchedule>) {
    Object.assign(this, init);
  }
}
