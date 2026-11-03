import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

const normalizedStringArray = (value?: string | string[]): string[] => {
  const parsed = Array.isArray(value)
    ? value
    : value
      ? (JSON.parse(value) as unknown)
      : [];

  if (
    !Array.isArray(parsed) ||
    parsed.some((reason) => typeof reason !== 'string')
  ) {
    throw new TypeError('Fresh discovery reasons must be an array of strings.');
  }

  return parsed;
};

const stringArray = {
  to: (value?: string[]) => JSON.stringify(normalizedStringArray(value)),
  from: (value?: string | string[]) => normalizedStringArray(value),
};

export type FreshHistoryIdentityKind =
  | 'movie'
  | 'season'
  | 'special'
  | 'legacy_tv';

/** Durable, irreversible Fresh admission history. */
@Entity()
@Unique('UQ_fresh_discovery_history_identity', [
  'mediaType',
  'tmdbId',
  'identityKind',
  'seasonKey',
  'specialEpisodeKey',
])
@Index('IDX_fresh_discovery_history_projection', [
  'mediaType',
  'tmdbId',
  'visibleUntil',
])
export default class FreshDiscoveryHistory {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 8 }) public mediaType: 'movie' | 'tv';
  @Column({ type: 'int' }) public tmdbId: number;
  @Column({ type: 'varchar', length: 16 })
  public identityKind: FreshHistoryIdentityKind;
  @Column({ type: 'int', default: -1 }) public seasonKey = -1;
  @Column({ type: 'int', default: -1 }) public specialEpisodeKey = -1;
  @Column({ default: false }) public admitted: boolean = false;
  @Column({ default: false }) public legacyProjection: boolean = false;
  @DbAwareColumn({ type: 'datetime' }) public firstObservedAt: Date;
  @DbAwareColumn({ type: 'datetime' }) public lastObservedAt: Date;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public firstFreshAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public visibleUntil?: Date | null;
  @Column({ type: 'varchar', length: 10, nullable: true })
  public activityDate?: string | null;
  @Column({ type: 'varchar', length: 32, default: 'unavailable' })
  public activitySource = 'unavailable';
  @Column({ type: 'varchar', length: 64, default: 'not_evaluated' })
  public admissionReason = 'not_evaluated';
  @Column({
    type: 'text',
    default: () => "'[]'",
    transformer: stringArray,
  })
  public automaticReasons: string[] = [];
  @Column({ type: 'int', default: 0 }) public firstSeenGeneration = 0;
  @Column({ type: 'int', default: 0 }) public lastSeenGeneration = 0;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<FreshDiscoveryHistory>) {
    Object.assign(this, init);
  }
}
