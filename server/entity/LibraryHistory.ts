import type { LibraryRemovalSource } from '@server/constants/libraryHistory';
import { LibraryReconciliationState } from '@server/constants/libraryHistory';
import {
  CanonicalEpisode,
  CanonicalMedia,
} from '@server/entity/CanonicalMedia';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import type { ValueTransformer } from 'typeorm';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

const nullableBigintString: ValueTransformer = {
  to: (value?: string | null) => value ?? null,
  from: (value?: string | number | null) =>
    value === null || value === undefined ? null : String(value),
};

@Entity('storage_root')
@Unique('UQ_storage_root_source', ['servarrType', 'serviceId', 'sourceRootId'])
export class StorageRoot {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 16 }) public servarrType:
    | 'radarr'
    | 'sonarr';
  @Column({ type: 'int' }) public serviceId: number;
  @Column({ type: 'int' }) public sourceRootId: number;
  @Column({ type: 'varchar', length: 255, nullable: true })
  public nameSnapshot?: string | null;
  @Column({ type: 'varchar', length: 120, nullable: true })
  public displayName?: string | null;
  @Column({ type: 'boolean', default: false }) public isAnimation = false;
  @Column({ type: 'varchar', length: 7, nullable: true })
  public color?: string | null;
  @Column({ type: 'text', nullable: true })
  public pathSnapshot?: string | null;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<StorageRoot>) {
    Object.assign(this, init);
  }
}

@Entity('library_presence')
@Unique('UQ_library_presence_source_generation', [
  'sourceSystem',
  'sourceScope',
  'sourceItemId',
  'sourceGeneration',
])
@Index('IDX_library_presence_current', ['canonicalMediaId', 'isCurrent'])
@Index('IDX_library_presence_root_current', ['storageRootId', 'isCurrent'])
export class LibraryPresence {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public canonicalMediaId: number;
  @ManyToOne(() => CanonicalMedia, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'canonicalMediaId',
    foreignKeyConstraintName: 'FK_library_presence_media',
  })
  public canonicalMedia: CanonicalMedia;

  @Column({ type: 'varchar', length: 32 }) public sourceSystem: string;
  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 128 }) public sourceItemId: string;
  @Column({ type: 'varchar', length: 64, default: '' })
  public sourceGeneration = '';

  @Column({ type: 'int', nullable: true }) public storageRootId?: number | null;
  @ManyToOne(() => StorageRoot, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'storageRootId',
    foreignKeyConstraintName: 'FK_library_presence_root',
  })
  public storageRoot?: StorageRoot | null;

  @Column({ type: 'text', nullable: true }) public pathSnapshot?: string | null;
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: nullableBigintString,
  })
  public logicalSizeBytes?: string | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public addedAt?: Date | null;
  @Column({ type: 'varchar', length: 32, nullable: true })
  public addedAtSource?: string | null;
  @Column({ type: 'varchar', length: 16, nullable: true })
  public addedAtConfidence?: string | null;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public firstObservedAt: Date;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSeenAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public removedAt?: Date | null;
  @Column({ type: 'varchar', length: 16, nullable: true })
  public removalSource?: LibraryRemovalSource | null;

  @Column({ type: 'boolean', nullable: true })
  public servarrManaged?: boolean | null;
  @Column({ type: 'boolean', nullable: true })
  public servarrHasFile?: boolean | null;
  @Column({ type: 'boolean', nullable: true })
  public jellyfinVisible?: boolean | null;
  @Column({ type: 'boolean', default: true }) public isCurrent = true;
  @Column({
    type: 'int',
    default: LibraryReconciliationState.UNKNOWN,
  })
  public reconciliationState = LibraryReconciliationState.UNKNOWN;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<LibraryPresence>) {
    Object.assign(this, init);
  }
}

@Entity('library_file')
@Unique('UQ_library_file_source', [
  'sourceSystem',
  'sourceScope',
  'sourceFileId',
  'sourceGeneration',
])
@Index('IDX_library_file_presence_current', ['libraryPresenceId', 'isCurrent'])
export class LibraryFile {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public libraryPresenceId: number;
  @ManyToOne(() => LibraryPresence, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'libraryPresenceId',
    foreignKeyConstraintName: 'FK_library_file_presence',
  })
  public libraryPresence: LibraryPresence;

  @Column({ type: 'varchar', length: 32 }) public sourceSystem: string;
  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 128 }) public sourceFileId: string;
  @Column({ type: 'varchar', length: 64, default: '' })
  public sourceGeneration = '';

  @Column({ type: 'int', nullable: true }) public storageRootId?: number | null;
  @ManyToOne(() => StorageRoot, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'storageRootId',
    foreignKeyConstraintName: 'FK_library_file_root',
  })
  public storageRoot?: StorageRoot | null;

  @Column({ type: 'text', nullable: true }) public pathSnapshot?: string | null;
  @Column({
    type: 'bigint',
    nullable: true,
    transformer: nullableBigintString,
  })
  public sizeBytes?: string | null;
  @Column({ type: 'int', nullable: true })
  public resolution?: number | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public importedAt?: Date | null;
  @Column({ type: 'varchar', length: 32, nullable: true })
  public importedAtSource?: string | null;
  @Column({ type: 'varchar', length: 16, nullable: true })
  public importedAtConfidence?: string | null;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public firstObservedAt: Date;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSeenAt?: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public removedAt?: Date | null;
  @Column({ type: 'varchar', length: 16, nullable: true })
  public removalSource?: LibraryRemovalSource | null;
  @Column({ type: 'boolean', default: true }) public isCurrent = true;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<LibraryFile>) {
    Object.assign(this, init);
  }
}

@Entity('library_file_episode')
@Index('IDX_library_file_episode_episode', ['canonicalEpisodeId'])
export class LibraryFileEpisode {
  @PrimaryColumn({ type: 'int' }) public libraryFileId: number;
  @PrimaryColumn({ type: 'int' }) public canonicalEpisodeId: number;

  @ManyToOne(() => LibraryFile, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'libraryFileId',
    foreignKeyConstraintName: 'FK_library_file_episode_file',
  })
  public libraryFile: LibraryFile;
  @ManyToOne(() => CanonicalEpisode, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'canonicalEpisodeId',
    foreignKeyConstraintName: 'FK_library_file_episode_episode',
  })
  public canonicalEpisode: CanonicalEpisode;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<LibraryFileEpisode>) {
    Object.assign(this, init);
  }
}
