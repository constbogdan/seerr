import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Seed 0 is the per-origin claim row; positive seeds track page progress. */
@Entity('similar_collection_seed_progress')
@Check('CHK_similar_seed_origin', '"originCollectionId" > 0')
@Check('CHK_similar_seed_movie', '"seedMovieId" >= 0')
@Check('CHK_similar_seed_page', '"nextPage" BETWEEN 1 AND 4')
@Index('IDX_similar_seed_retry', ['originCollectionId', 'retryAfter'])
export class SimilarCollectionSeedProgress {
  @PrimaryColumn({ type: 'int' }) public originCollectionId: number;
  @PrimaryColumn({ type: 'int' }) public seedMovieId: number;
  @Column({ type: 'int', default: 1 }) public nextPage = 1;
  @Column({ type: 'int', nullable: true }) public reportedTotalPages:
    | number
    | null = null;
  @Column({ type: 'int', default: 0 }) public failureCount = 0;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastAttemptAt: Date | null = null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public retryAfter: Date | null = null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public completedAt: Date | null = null;
  @Column({ type: 'varchar', length: 64, nullable: true }) public claimToken:
    | string
    | null = null;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public lastVisitToken: string | null = null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public claimExpiresAt: Date | null = null;

  constructor(init?: Partial<SimilarCollectionSeedProgress>) {
    Object.assign(this, init);
  }
}
