import type { MediaType } from '@server/constants/media';
import {
  UserMediaIntentState,
  UserMediaIntentType,
} from '@server/constants/watchlist';
import { User } from '@server/entity/User';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('user_media_intent_occurrence')
@Check('CHK_user_media_intent_type', `"intentType" IN ('WATCHLIST')`)
@Check(
  'CHK_user_media_intent_state',
  `"state" IN ('ACTIVE', 'SATISFIED', 'REMOVED')`
)
@Index(
  'UQ_user_media_intent_active',
  ['userId', 'intentType', 'mediaType', 'tmdbId'],
  { unique: true, where: `"state" = 'ACTIVE'` }
)
@Index('IDX_user_media_intent_user_started', ['userId', 'startedAt'])
@Index('IDX_user_media_intent_identity_state', ['mediaType', 'tmdbId', 'state'])
export class UserMediaIntentOccurrence {
  @PrimaryGeneratedColumn() public id: number;

  @Column({ type: 'int' }) public userId: number;
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'FK_user_media_intent_user',
  })
  public user: User;

  @Column({
    type: 'varchar',
    length: 16,
    default: UserMediaIntentType.WATCHLIST,
  })
  public intentType = UserMediaIntentType.WATCHLIST;
  @Column({ type: 'varchar', length: 8 }) public mediaType: MediaType;
  @Column({ type: 'int' }) public tmdbId: number;
  @Column({
    type: 'varchar',
    length: 16,
    default: UserMediaIntentState.ACTIVE,
  })
  public state = UserMediaIntentState.ACTIVE;

  @DbAwareColumn({ type: 'datetime' }) public startedAt: Date;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public endedAt?: Date | null;
  @Column({ type: 'varchar', length: 32, nullable: true })
  public endReason?: string | null;

  @Column({ type: 'int', nullable: true })
  public completionEvidenceId?: number | null;
  @ManyToOne(() => ViewingEvidence, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'completionEvidenceId',
    foreignKeyConstraintName: 'FK_user_media_intent_completion_evidence',
  })
  public completionEvidence?: ViewingEvidence | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<UserMediaIntentOccurrence>) {
    Object.assign(this, init);
  }
}
