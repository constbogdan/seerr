import type { SeriesRelocationState } from '@server/constants/seriesRelocation';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import type { ValueTransformer } from 'typeorm';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

const bigintString: ValueTransformer = {
  to: (value?: string | null) => value ?? null,
  from: (value?: string | number | null) =>
    value === null || value === undefined ? null : String(value),
};

const integerArray: ValueTransformer = {
  to: (value?: number[] | null) => JSON.stringify(value ?? []),
  from: (value?: string | number[] | null) => {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(Number.isSafeInteger)
      ? parsed
      : [];
  },
};

@Entity('series_relocation_execution')
@Unique('UQ_series_relocation_active', ['activeKey'])
@Check(
  'CHK_series_relocation_state',
  `"state" IN ('claimed', 'provider_in_flight', 'verifying', 'completed', 'reconciliation_required')`
)
@Index('IDX_series_relocation_media_created', ['canonicalMediaId', 'createdAt'])
@Index('IDX_series_relocation_state_updated', ['state', 'updatedAt'])
export class SeriesRelocationExecution {
  @PrimaryColumn({ type: 'varchar', length: 36 }) public id: string;

  @Column({ type: 'int' }) public canonicalMediaId: number;
  @ManyToOne(() => CanonicalMedia, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'canonicalMediaId',
    foreignKeyConstraintName: 'FK_series_relocation_media',
  })
  public canonicalMedia: CanonicalMedia;

  @Column({ type: 'varchar', length: 32 }) public state: SeriesRelocationState;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public activeKey?: string | null;
  @Column({ type: 'int' }) public serviceId: number;
  @Column({ type: 'int' }) public sonarrSeriesId: number;
  @Column({ type: 'int' }) public sourceRootFolderId: number;
  @Column({ type: 'int' }) public destinationRootFolderId: number;
  @Column({ type: 'varchar', length: 255 }) public sourceVolumeId: string;
  @Column({ type: 'varchar', length: 255 }) public destinationVolumeId: string;
  @Column({ type: 'text' }) public sourcePath: string;
  @Column({ type: 'text' }) public destinationPath: string;
  @Column({ type: 'text', transformer: integerArray })
  public expectedEpisodeFileIds: number[];
  @Column({ type: 'int' }) public expectedFileCount: number;
  @Column({ type: 'bigint', transformer: bigintString })
  public expectedBytes: string;
  @Column({ type: 'varchar', length: 64, nullable: true })
  public failureCode?: string | null;
  @Column({ type: 'text', nullable: true })
  public failureMessage?: string | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public providerStartedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public providerAcceptedAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public verifiedAt?: Date | null;

  @CreateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<SeriesRelocationExecution>) {
    Object.assign(this, init);
  }
}
