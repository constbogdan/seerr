import { User } from '@server/entity/User';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('viewer')
@Unique('UQ_viewer_source_identity', ['source', 'sourceScope', 'sourceUserId'])
@Index('IDX_viewer_user', ['userId'])
export class Viewer {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar', length: 32 }) public source: string;
  @Column({ type: 'varchar', length: 128 }) public sourceScope: string;
  @Column({ type: 'varchar', length: 128 }) public sourceUserId: string;

  @Column({ type: 'int', nullable: true }) public userId?: number | null;
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'FK_viewer_user',
  })
  public user?: User | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<Viewer>) {
    Object.assign(this, init);
  }
}
