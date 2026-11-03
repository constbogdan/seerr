import {
  CanonicalEpisode,
  CanonicalMedia,
} from '@server/entity/CanonicalMedia';
import { Viewer } from '@server/entity/Viewer';
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

const nullableBigintString: ValueTransformer = {
  to: (value?: string | null) => value ?? null,
  from: (value?: string | number | null) =>
    value === null || value === undefined ? null : String(value),
};

@Entity('current_viewing_state')
@Unique('UQ_current_viewing_state_source_item', [
  'viewerId',
  'sourceScope',
  'sourceItemId',
])
@Index('IDX_current_viewing_state_viewer', ['viewerId', 'observedAt'])
@Index('IDX_current_viewing_state_media', ['canonicalMediaId', 'played'])
@Index('IDX_current_viewing_state_episode', ['canonicalEpisodeId', 'played'])
export class CurrentViewingState {
  @PrimaryGeneratedColumn() public id: number;

  @Column({ type: 'int' }) public viewerId: number;
  @ManyToOne(() => Viewer, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'viewerId',
    foreignKeyConstraintName: 'FK_current_viewing_state_viewer',
  })
  public viewer: Viewer;

  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 128 }) public sourceItemId: string;
  @Column({ type: 'varchar', length: 8 })
  public mediaType: 'movie' | 'episode';

  @Column({ type: 'int' }) public canonicalMediaId: number;
  @ManyToOne(() => CanonicalMedia, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'canonicalMediaId',
    foreignKeyConstraintName: 'FK_current_viewing_state_media',
  })
  public canonicalMedia: CanonicalMedia;

  @Column({ type: 'int', nullable: true })
  public canonicalEpisodeId?: number | null;
  @ManyToOne(() => CanonicalEpisode, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'canonicalEpisodeId',
    foreignKeyConstraintName: 'FK_current_viewing_state_episode',
  })
  public canonicalEpisode?: CanonicalEpisode | null;

  @Column({ type: 'boolean', default: false }) public played = false;
  @Column({ type: 'int', default: 0 }) public playCount = 0;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastPlayedAt?: Date | null;
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: nullableBigintString,
  })
  public playbackPositionTicks?: string | null;
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: nullableBigintString,
  })
  public runtimeTicks?: string | null;
  @Column({ type: 'int', nullable: true })
  public progressBasisPoints?: number | null;
  @DbAwareColumn({ type: 'datetime' }) public observedAt: Date;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<CurrentViewingState>) {
    Object.assign(this, init);
  }
}
