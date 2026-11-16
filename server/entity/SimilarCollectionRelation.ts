import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Check, Entity, Index, PrimaryColumn } from 'typeorm';

/** Directional TMDB discovery evidence, independent of Library ownership. */
@Entity('similar_collection_relation')
@Check('CHK_similar_relation_origin', '"originCollectionId" > 0')
@Check('CHK_similar_relation_seed', '"seedMovieId" > 0')
@Check('CHK_similar_relation_related', '"relatedCollectionId" > 0')
@Check(
  'CHK_similar_relation_not_self',
  '"originCollectionId" <> "relatedCollectionId"'
)
@Index('IDX_similar_relation_origin_related', [
  'originCollectionId',
  'relatedCollectionId',
])
export class SimilarCollectionRelation {
  @PrimaryColumn({ type: 'int' }) public originCollectionId: number;
  @PrimaryColumn({ type: 'int' }) public seedMovieId: number;
  @PrimaryColumn({ type: 'int' }) public relatedCollectionId: number;
  @DbAwareColumn({ type: 'datetime' }) public discoveredAt: Date;

  constructor(init?: Partial<SimilarCollectionRelation>) {
    Object.assign(this, init);
  }
}
