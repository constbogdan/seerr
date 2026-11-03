import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/** Human admission policy, separate from automatic eligibility and identity. */
@Entity()
@Unique('UQ_fresh_admission_override_identity', [
  'mediaType',
  'tmdbId',
  'identityKind',
  'seasonKey',
  'specialEpisodeKey',
])
@Index('IDX_fresh_admission_override_active', ['active'])
export default class FreshAdmissionOverride {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'int' }) public tmdbId: number;
  @Column({ type: 'varchar', length: 16 })
  public identityKind: 'movie' | 'season' | 'special' | 'legacy_tv';
  @Column({ type: 'int', default: -1 }) public seasonKey = -1;
  @Column({ type: 'int', default: -1 }) public specialEpisodeKey = -1;
  @Column({ default: true }) public active: boolean = true;
  @Column({ type: 'int', default: 1 }) public revision = 1;
  @Column({ type: 'int', nullable: true }) public actorUserId?: number | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public firstAdmittedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<FreshAdmissionOverride>) {
    Object.assign(this, init);
  }
}
