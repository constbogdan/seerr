import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** Administrator-controlled diagnostics visibility bound to stable source evidence. */
@Entity()
@Unique('UQ_fresh_candidate_visibility_source', [
  'sourceEvidenceVersion',
  'mediaType',
  'sourceEvidenceKey',
])
export default class FreshCandidateVisibility {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int', default: 1 }) public sourceEvidenceVersion = 1;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'varchar', length: 64 }) public sourceEvidenceKey: string;
  @Column({ default: true }) public show: boolean = true;

  constructor(init?: Partial<FreshCandidateVisibility>) {
    Object.assign(this, init);
  }
}
