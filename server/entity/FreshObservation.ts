import type { FreshAvailabilityType } from '@server/api/autobrr';
import FreshCandidate from '@server/entity/FreshCandidate';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity()
@Unique('UQ_fresh_observation_release', ['sourceGeneration', 'releaseId'])
@Index('IDX_fresh_observation_candidate', ['candidateId'])
@Index('IDX_fresh_observation_generation_time', [
  'sourceGeneration',
  'observedAt',
])
export default class FreshObservation {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public sourceGeneration: number;
  @Column({ type: 'varchar', length: 20 }) public releaseId: string;
  @Column({ type: 'int' }) public filterId: number;
  @Column({ type: 'int' }) public candidateId: number;
  @ManyToOne(() => FreshCandidate, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'candidateId' })
  public candidate: FreshCandidate;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'varchar', length: 300 }) public title: string;
  @Column({ type: 'varchar', length: 300, default: '' }) public sourceTitle =
    '';
  @Column({ type: 'varchar', length: 300 }) public normalizedTitle: string;
  @Column({ type: 'int', default: 0 }) public year = 0;
  @Column({ type: 'int', default: -1 }) public seasonNumber = -1;
  @Column({ type: 'int', default: -1 }) public episodeNumber = -1;
  @Column({ default: false }) public explicitSeason: boolean = false;
  @Column({ default: false }) public explicitSpecial: boolean = false;
  @Column({ type: 'int', default: 1 }) public comparisonVersion = 1;
  @Column({ type: 'varchar', length: 64, default: '' })
  public sourceEvidenceKey = '';
  @Column({ type: 'varchar', length: 16, default: 'unknown' })
  public availabilityType: FreshAvailabilityType = 'unknown';
  @DbAwareColumn({ type: 'datetime' }) public observedAt: Date;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  constructor(init?: Partial<FreshObservation>) {
    Object.assign(this, init);
  }
}
