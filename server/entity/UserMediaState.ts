import type { MediaType } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
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
    onDelete: 'CASCADE',
  })
  @Index()
  public user: User;

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column()
  @Index()
  public tmdbId: number;

  @ManyToOne(() => Media, {
    eager: true,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @Index()
  public media?: Media | null;

  @Column({ type: 'boolean', nullable: true })
  public jellyfinPlayed?: boolean | null;

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
