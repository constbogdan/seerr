import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/** A typed human correction bound to versioned, sanitized source evidence. */
@Entity()
@Unique('UQ_fresh_manual_resolution_source', [
  'sourceEvidenceVersion',
  'sourceEvidenceKey',
])
@Index('IDX_fresh_manual_resolution_identity', ['mediaType', 'tmdbId'])
export default class FreshManualResolution {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int', default: 1 }) public sourceEvidenceVersion = 1;
  @Column({ type: 'varchar', length: 64 }) public sourceEvidenceKey: string;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'int' }) public tmdbId: number;
  @Column({ type: 'varchar', length: 300 }) public canonicalTitle: string;
  @Column({ type: 'varchar', length: 10, nullable: true })
  public canonicalDate?: string | null;
  @Column({ default: true }) public active: boolean = true;
  @Column({ type: 'int', default: 1 }) public revision = 1;
  @Column({ type: 'int', nullable: true }) public actorUserId?: number | null;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<FreshManualResolution>) {
    Object.assign(this, init);
  }
}
