import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

@Entity()
@Unique('UQ_fresh_discovery_event', [
  'sourceKey',
  'mediaType',
  'tmdbId',
  'eventKey',
])
@Index('IDX_fresh_discovery_feed', [
  'sourceKey',
  'discoveredAt',
  'mediaType',
  'tmdbId',
])
export default class FreshDiscovery {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 64 }) public sourceKey: string;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'int' }) public tmdbId: number;
  // Season numbers are source coordinates, not assertions about TMDB Seasons.
  @Column({ type: 'varchar', length: 32 }) public eventKey: string;
  @DbAwareColumn({ type: 'datetime' }) public discoveredAt: Date;
  @DbAwareColumn({ type: 'datetime' }) public visibleUntil: Date;
  @Column({ type: 'varchar', length: 300 }) public title: string;

  constructor(init?: Partial<FreshDiscovery>) {
    Object.assign(this, init);
  }
}
