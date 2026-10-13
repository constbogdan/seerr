import {
  IdentityResolutionState,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
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

@Entity('viewing_evidence')
@Unique('UQ_viewing_evidence_source_activity', [
  'source',
  'sourceScope',
  'sourceClass',
  'sourceActivityId',
])
@Index('IDX_viewing_evidence_viewer_time', ['viewerId', 'observedAt'])
@Index('IDX_viewing_evidence_media_time', ['canonicalMediaId', 'observedAt'])
@Index('IDX_viewing_evidence_episode_time', [
  'canonicalEpisodeId',
  'observedAt',
])
@Index('IDX_viewing_evidence_resolution', ['identityResolutionState'])
export class ViewingEvidence {
  @PrimaryGeneratedColumn() public id: number;

  @Column({ type: 'varchar', length: 32 }) public source: string;
  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 32 }) public sourceClass: string;
  @Column({ type: 'varchar', length: 255 }) public sourceActivityId: string;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public sourceGeneration?: string | null;
  @Column({ type: 'varchar', length: 32, nullable: true })
  public sourceVersion?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  public sourceUserId?: string | null;
  @Column({ type: 'varchar', length: 128, nullable: true })
  public sourceItemId?: string | null;

  @Column({ type: 'int', nullable: true }) public viewerId?: number | null;
  @ManyToOne(() => Viewer, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'viewerId',
    foreignKeyConstraintName: 'FK_viewing_evidence_viewer',
  })
  public viewer?: Viewer | null;

  @Column({ type: 'int', nullable: true })
  public canonicalMediaId?: number | null;
  @ManyToOne(() => CanonicalMedia, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'canonicalMediaId',
    foreignKeyConstraintName: 'FK_viewing_evidence_media',
  })
  public canonicalMedia?: CanonicalMedia | null;

  @Column({ type: 'int', nullable: true })
  public canonicalEpisodeId?: number | null;
  @ManyToOne(() => CanonicalEpisode, {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'canonicalEpisodeId',
    foreignKeyConstraintName: 'FK_viewing_evidence_episode',
  })
  public canonicalEpisode?: CanonicalEpisode | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public observedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public observedEndAt?: Date | null;
  @Column({ type: 'int', nullable: true })
  public playbackDurationSeconds?: number | null;
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

  @Column({ type: 'int', default: IdentityResolutionState.UNRESOLVED })
  public identityResolutionState = IdentityResolutionState.UNRESOLVED;
  @Column({ type: 'int', default: ViewingCompletionClassification.UNKNOWN })
  public completionClassification = ViewingCompletionClassification.UNKNOWN;
  @Column({ type: 'int', nullable: true })
  public completionDerivationVersion?: number | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public completionDerivedAt?: Date | null;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public provenance?: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<ViewingEvidence>) {
    Object.assign(this, init);
  }
}
