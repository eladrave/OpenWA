import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Session } from '../../session/entities/session.entity';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

@Entity('monitor_groups')
@Index('UQ_monitor_groups_principal_session_group', ['principalId', 'sessionId', 'groupJid'], { unique: true })
@Index('IDX_monitor_groups_session_group_enabled', ['sessionId', 'groupJid', 'enabled'])
export class MonitorGroup {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  principalId!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_monitor_groups_session' })
  session!: Session;

  @Column({ type: 'varchar', length: 191 })
  groupJid!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastReconciledCreatedAt!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastReconciledMessageRowId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
