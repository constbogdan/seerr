import {
  FRESH_SYNC_STATE_ID,
  FreshContinuityStatus,
} from '@server/constants/fresh';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity()
export class FreshSyncState {
  @PrimaryColumn({ type: 'int', default: FRESH_SYNC_STATE_ID })
  public id = FRESH_SYNC_STATE_ID;
  @Column({ type: 'varchar', length: 64, default: '' })
  public sourceFingerprint = '';
  @Column({ type: 'int', default: 0 }) public filterId = 0;
  @Column({ type: 'int', default: 0 }) public generation = 0;
  @Column({ type: 'varchar', length: 20, nullable: true })
  public checkpointReleaseId?: string | null;
  @Column({ type: 'int', default: FreshContinuityStatus.UNINITIALIZED })
  public continuityStatus = FreshContinuityStatus.UNINITIALIZED;
  @Column({ type: 'int', default: 90 }) public mediaEligibilityDays = 90;
  @Column({ type: 'int', default: 7 }) public freshVisibilityDays = 7;
  @Column({ type: 'int', default: 0 }) public eligibilitySchemaVersion = 0;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSuccessfulSyncAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSuccessfulReconciliationAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;
  constructor(init?: Partial<FreshSyncState>) {
    Object.assign(this, init);
  }
}
