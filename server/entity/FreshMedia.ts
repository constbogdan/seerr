import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

const numberArray = {
  to: (value?: number[]) => JSON.stringify(value ?? []),
  from: (value?: string) => (value ? (JSON.parse(value) as number[]) : []),
};
const stringArray = {
  to: (value?: string[]) => JSON.stringify(value ?? []),
  from: (value?: string | string[]) =>
    Array.isArray(value) ? value : value ? (JSON.parse(value) as string[]) : [],
};

@Entity()
@Unique('UQ_fresh_media_identity', ['mediaType', 'tmdbId'])
@Index('IDX_fresh_media_active_first_seen', ['active', 'firstSeenAt'])
@Index('IDX_fresh_media_active_type_first_seen', [
  'active',
  'mediaType',
  'firstSeenAt',
])
@Index('IDX_fresh_media_active_sort_title', ['active', 'sortTitle'])
@Index('IDX_fresh_media_active_date', ['active', 'mediaDate'])
@Index('IDX_fresh_media_active_vote', ['active', 'voteAverage'])
@Index('IDX_fresh_media_membership_reason', ['membershipReason'])
export default class FreshMedia {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'int' }) public tmdbId: number;
  @Column({ default: false }) public active: boolean = false;
  @Column({ default: false }) public admitted: boolean = false;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public membershipReason?: string | null;
  @Column({ type: 'text', default: () => "'[]'", transformer: stringArray })
  public automaticReasons: string[] = [];
  @Column({ type: 'int', default: 0 }) public lastMatchedGeneration = 0;
  @DbAwareColumn({ type: 'datetime' }) public firstSeenAt: Date;
  @DbAwareColumn({ type: 'datetime' }) public lastSeenAt: Date;
  @DbAwareColumn({ type: 'datetime' }) public resolvedAt: Date;
  @DbAwareColumn({ type: 'datetime' }) public metadataRefreshedAt: Date;
  @Column({ type: 'varchar', length: 300 }) public displayTitle: string;
  @Column({ type: 'varchar', length: 300 }) public sortTitle: string;
  @Column({ type: 'varchar', length: 300 }) public originalTitle: string;
  @Column({ type: 'varchar', length: 10, nullable: true })
  public mediaDate?: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true })
  public digitalReleaseDate?: string | null;
  @Column({ type: 'varchar', length: 10, nullable: true })
  public physicalReleaseDate?: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true })
  public posterPath?: string | null;
  @Column({ type: 'varchar', length: 500, nullable: true })
  public backdropPath?: string | null;
  @Column({ type: 'text', default: '' }) public overview = '';
  @Column({ type: 'varchar', length: 20, default: '' })
  public originalLanguage = '';
  @Column({ type: 'float', default: 0 }) public popularity = 0;
  @Column({ type: 'float', default: 0 }) public voteAverage = 0;
  @Column({ type: 'int', default: 0 }) public voteCount = 0;
  @Column({ type: 'text', transformer: numberArray })
  public genreIds: number[] = [];
  @Column({ type: 'varchar', length: 32, default: '' })
  public contentRating = '';
  @Column({ type: 'varchar', length: 8, default: '' })
  public contentRatingRegion = '';
  @Column({ type: 'boolean', nullable: true }) public adult?: boolean | null;
  @Column({ type: 'boolean', nullable: true }) public video?: boolean | null;
  @Column({ type: 'text', transformer: stringArray })
  public originCountries: string[] = [];
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;
  constructor(init?: Partial<FreshMedia>) {
    Object.assign(this, init);
  }
}
