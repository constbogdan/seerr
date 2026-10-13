import { LibraryMediaType } from '@server/constants/libraryHistory';
import Media from '@server/entity/Media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('canonical_media')
@Check('CHK_canonical_media_type', `"mediaType" IN ('movie', 'series')`)
@Unique('UQ_canonical_media_id_type', ['id', 'mediaType'])
@Unique('UQ_canonical_media_current_media', ['currentMediaId'])
@Index('IDX_canonical_media_type_title', ['mediaType', 'titleSnapshot'])
export class CanonicalMedia {
  @PrimaryGeneratedColumn() public id: number;

  @Column({ type: 'varchar', length: 8 })
  public mediaType: LibraryMediaType;

  @Column({ type: 'varchar', length: 300, nullable: true })
  public titleSnapshot?: string | null;

  @Column({ type: 'int', nullable: true })
  public year?: number | null;

  @Column({ type: 'int', nullable: true })
  public currentMediaId?: number | null;

  @ManyToOne(() => Media, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'currentMediaId',
    foreignKeyConstraintName: 'FK_canonical_media_current_media',
  })
  public currentMedia?: Media | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<CanonicalMedia>) {
    Object.assign(this, init);
  }
}

@Entity('canonical_media_identity')
@Unique('UQ_canonical_media_identity_source', [
  'provider',
  'sourceScope',
  'mediaType',
  'value',
])
@Index('IDX_canonical_media_identity_media', ['canonicalMediaId'])
export class CanonicalMediaIdentity {
  @PrimaryGeneratedColumn() public id: number;

  @Column({ type: 'int' }) public canonicalMediaId: number;
  @Column({ type: 'varchar', length: 8 })
  public mediaType: LibraryMediaType;

  @ManyToOne(() => CanonicalMedia, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'canonicalMediaId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_canonical_media_identity_media',
    },
    { name: 'mediaType', referencedColumnName: 'mediaType' },
  ])
  public canonicalMedia: CanonicalMedia;

  @Column({ type: 'varchar', length: 32 }) public provider: string;
  @Column({ type: 'varchar', length: 128, default: '' })
  public sourceScope = '';
  @Column({ type: 'varchar', length: 255 }) public value: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<CanonicalMediaIdentity>) {
    Object.assign(this, init);
  }
}

@Entity('canonical_season')
@Check('CHK_canonical_season_series_type', `"mediaType" = 'series'`)
@Unique('UQ_canonical_season_identity', ['seriesId', 'seasonNumber'])
@Unique('UQ_canonical_season_id_series', ['id', 'seriesId'])
@Index('IDX_canonical_season_series', ['seriesId'])
export class CanonicalSeason {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public seriesId: number;
  @Column({
    type: 'varchar',
    length: 8,
    default: LibraryMediaType.SERIES,
  })
  public mediaType = LibraryMediaType.SERIES;

  @ManyToOne(() => CanonicalMedia, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'seriesId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_canonical_season_series',
    },
    { name: 'mediaType', referencedColumnName: 'mediaType' },
  ])
  public series: CanonicalMedia;

  @Column({ type: 'int' }) public seasonNumber: number;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<CanonicalSeason>) {
    Object.assign(this, init);
  }
}

@Entity('canonical_season_identity')
@Unique('UQ_canonical_season_identity_source', [
  'provider',
  'sourceScope',
  'value',
])
@Index('IDX_canonical_season_identity_season', ['canonicalSeasonId'])
export class CanonicalSeasonIdentity {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public canonicalSeasonId: number;
  @ManyToOne(() => CanonicalSeason, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'canonicalSeasonId',
    foreignKeyConstraintName: 'FK_canonical_season_identity_season',
  })
  public canonicalSeason: CanonicalSeason;
  @Column({ type: 'varchar', length: 32 }) public provider: string;
  @Column({ type: 'varchar', length: 128, default: '' })
  public sourceScope = '';
  @Column({ type: 'varchar', length: 255 }) public value: string;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<CanonicalSeasonIdentity>) {
    Object.assign(this, init);
  }
}

@Entity('canonical_episode')
@Unique('UQ_canonical_episode_identity', ['seasonId', 'episodeNumber'])
@Index('IDX_canonical_episode_air_date', ['airDate'])
export class CanonicalEpisode {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public seasonId: number;
  @ManyToOne(() => CanonicalSeason, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'seasonId',
    foreignKeyConstraintName: 'FK_canonical_episode_season',
  })
  public season: CanonicalSeason;
  @Column({ type: 'int' }) public episodeNumber: number;
  @Column({ type: 'date', nullable: true }) public airDate?: string | null;
  @Column({ type: 'boolean', default: false }) public isSpecial = false;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<CanonicalEpisode>) {
    Object.assign(this, init);
  }
}

@Entity('canonical_episode_identity')
@Unique('UQ_canonical_episode_identity_source', [
  'provider',
  'sourceScope',
  'value',
])
@Index('IDX_canonical_episode_identity_episode', ['canonicalEpisodeId'])
export class CanonicalEpisodeIdentity {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public canonicalEpisodeId: number;
  @ManyToOne(() => CanonicalEpisode, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'canonicalEpisodeId',
    foreignKeyConstraintName: 'FK_canonical_episode_identity_episode',
  })
  public canonicalEpisode: CanonicalEpisode;
  @Column({ type: 'varchar', length: 32 }) public provider: string;
  @Column({ type: 'varchar', length: 128, default: '' })
  public sourceScope = '';
  @Column({ type: 'varchar', length: 255 }) public value: string;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<CanonicalEpisodeIdentity>) {
    Object.assign(this, init);
  }
}
