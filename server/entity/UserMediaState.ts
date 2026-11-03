import type { MediaType } from '@server/constants/media';
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
import Media from './Media';
import { User } from './User';

@Entity()
@Unique('UQ_user_media_state_identity', ['user', 'mediaType', 'tmdbId'])
@Index('IDX_user_media_state_user_played', ['user', 'jellyfinPlayed'])
export class UserMediaState {
  @PrimaryGeneratedColumn()
  public id: number;

  @ManyToOne(() => User, (user) => user.mediaStates, {
    eager: true,
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'FK_user_media_state_user',
  })
  @Index('IDX_user_media_state_userId')
  public user: User;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column()
  @Index('IDX_user_media_state_tmdbId')
  public tmdbId: number;

  @ManyToOne(() => Media, {
    eager: true,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({
    name: 'mediaId',
    foreignKeyConstraintName: 'FK_user_media_state_media',
  })
  @Index('IDX_user_media_state_mediaId')
  public media?: Media | null;

  @Column({ type: 'boolean', nullable: true })
  public jellyfinPlayed?: boolean | null;

  // Preference-only Library observations must not expand watched-state coverage.
  @Column({ type: 'boolean', default: true })
  public jellyfinPlayStateTracked = true;

  // Nullable rating, not watched state. A null observation time means unknown.
  @Column({ type: 'boolean', nullable: true })
  public jellyfinLikes?: boolean | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public jellyfinPreferenceObservedAt?: Date | null;

  @Column({ type: 'varchar', length: 128, nullable: true, select: false })
  public jellyfinPreferenceSourceScope?: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, select: false })
  public jellyfinPreferenceUserId?: string | null;

  @Column({ type: 'text', nullable: true, select: false })
  public jellyfinPreferenceItemIds?: string | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public jellyfinLastPlayedAt?: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public jellyfinPlayStateSyncedAt?: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true, select: false })
  public jellyfinPlayStateUserId?: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<UserMediaState>) {
    Object.assign(this, init);
  }
}
