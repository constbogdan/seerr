import { LibraryMediaType } from '@server/constants/libraryHistory';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Check,
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('movie_collection_observation')
@Check('CHK_movie_collection_observation_type', `"mediaType" = 'movie'`)
@Check('CHK_movie_collection_observation_tmdb_id', `"tmdbId" > 0`)
@Check(
  'CHK_movie_collection_observation_collection_id',
  `"tmdbCollectionId" IS NULL OR "tmdbCollectionId" > 0`
)
@Unique('UQ_movie_collection_observation_identity', ['mediaType', 'tmdbId'])
@Index('IDX_movie_collection_observation_observed_at', ['observedAt'])
export class MovieCollectionObservation {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 8 })
  public mediaType: LibraryMediaType.MOVIE = LibraryMediaType.MOVIE;
  @Column({ type: 'int' }) public tmdbId: number;
  @Column({ type: 'int', nullable: true }) public tmdbCollectionId:
    | number
    | null;
  @DbAwareColumn({ type: 'datetime' }) public observedAt: Date;

  constructor(init?: Partial<MovieCollectionObservation>) {
    Object.assign(this, init);
  }
}
