import { FreshCandidateStatus } from '@server/constants/fresh';
import FreshMedia from '@server/entity/FreshMedia';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
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

@Entity()
@Unique('UQ_fresh_candidate_identity', [
  'sourceGeneration',
  'mediaType',
  'normalizedTitle',
  'matchYear',
])
@Index('IDX_fresh_candidate_due', [
  'sourceGeneration',
  'status',
  'nextAttemptAt',
])
@Index('IDX_fresh_candidate_media', ['freshMediaId'])
export default class FreshCandidate {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public sourceGeneration: number;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'varchar', length: 300 }) public normalizedTitle: string;
  @Column({ type: 'varchar', length: 300 }) public displayTitle: string;
  @Column({ type: 'int', default: 0 }) public matchYear = 0;
  @Column({ type: 'int', default: FreshCandidateStatus.UNRESOLVED })
  public status = FreshCandidateStatus.UNRESOLVED;
  @Column({ type: 'int', nullable: true }) public tmdbId?: number | null;
  @Column({ type: 'int', nullable: true }) public freshMediaId?: number | null;
  @ManyToOne(() => FreshMedia, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'freshMediaId' })
  public freshMedia?: FreshMedia | null;
  @DbAwareColumn({ type: 'datetime' }) public firstObservedAt: Date;
  @DbAwareColumn({ type: 'datetime' }) public lastObservedAt: Date;
  @Column({ type: 'int', default: 0 }) public attemptCount = 0;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastAttemptAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public nextAttemptAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolutionStartedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolvedAt?: Date | null;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public lastFailureReason?: string | null;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;
  constructor(init?: Partial<FreshCandidate>) {
    Object.assign(this, init);
  }
}
