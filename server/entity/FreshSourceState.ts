import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryColumn } from 'typeorm';

/** V2 progress only. Legacy Fresh tables are deliberately never read or written. */
@Entity()
export default class FreshSourceState {
  @PrimaryColumn({ type: 'int' }) public id = 1;
  @Column({ type: 'varchar', length: 64 }) public sourceKey: string;
  @Column({ type: 'varchar', length: 20, nullable: true }) public checkpoint:
    | string
    | null = null;
  @Column({ type: 'varchar', length: 20, nullable: true }) public scanHead:
    | string
    | null = null;
  @Column({ type: 'varchar', length: 20, nullable: true }) public scanCursor:
    | string
    | null = null;
  @Column({ type: 'varchar', length: 20, nullable: true })
  public approvalCursor: string | null = null;
  @Column({ type: 'boolean', default: false })
  public backfillComplete: boolean = false;
  @Column({ type: 'boolean', default: false }) public recovering: boolean =
    false;
  @Column({ type: 'int', default: 0 }) public attempts = 0;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public nextAttemptAt: Date | null = null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastIngestedAt: Date | null = null;
  @Column({ type: 'varchar', length: 32, nullable: true }) public lastError:
    | string
    | null = null;
  @Column({ type: 'text', default: '[]' }) public filterYears = '[]';

  constructor(init?: Partial<FreshSourceState>) {
    Object.assign(this, init);
  }
}
