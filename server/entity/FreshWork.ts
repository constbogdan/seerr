import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export type FreshWorkOutcome =
  | 'pending'
  | 'resolved'
  | 'no_match'
  | 'ambiguous'
  | 'incomplete'
  | 'retry';

@Entity()
@Unique('UQ_fresh_work_source_group', ['sourceKey', 'groupKey'])
@Index('IDX_fresh_work_due', ['sourceKey', 'outcome', 'nextAttemptAt', 'id'])
export default class FreshWork {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 64 }) public sourceKey: string;
  @Column({ type: 'varchar', length: 64 }) public groupKey: string;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'varchar', length: 300 }) public title: string;
  @Column({ type: 'varchar', length: 300 }) public sourceTitle: string;
  @Column({ type: 'int', default: 0 }) public year = 0;
  @Column({ type: 'int', default: -1 }) public season = -1;
  @Column({ type: 'int', nullable: true }) public externalTmdbId:
    | number
    | null = null;
  @Column({ type: 'int', nullable: true }) public externalTvdbId:
    | number
    | null = null;
  @Column({ type: 'varchar', length: 16, nullable: true })
  public externalImdbId: string | null = null;
  @DbAwareColumn({ type: 'datetime' }) public firstObservedAt: Date;
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  public outcome: FreshWorkOutcome = 'pending';
  @Column({ type: 'int', default: 0 }) public attempts = 0;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public nextAttemptAt: Date | null = null;
  @Column({ type: 'varchar', length: 32, nullable: true }) public lastError:
    | string
    | null = null;
  @Column({ type: 'int', nullable: true }) public tmdbId: number | null = null;
  @Column({ type: 'varchar', length: 300, nullable: true })
  public canonicalTitle: string | null = null;

  constructor(init?: Partial<FreshWork>) {
    Object.assign(this, init);
  }
}
