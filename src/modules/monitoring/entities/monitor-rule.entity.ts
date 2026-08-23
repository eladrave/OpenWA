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
import { jsonColumnType } from '../../../common/utils/column-types';
import type { MonitorActiveHours, MonitorCondition, MonitorMatchMode, MonitorPriority } from '../monitoring.types';
import { Session } from '../../session/entities/session.entity';

@Entity('monitor_rules')
@Index('IDX_monitor_rules_principal_session_group', ['principalId', 'sessionId', 'groupJid'])
@Index('IDX_monitor_rules_session_group_enabled', ['sessionId', 'groupJid', 'enabled'])
export class MonitorRule {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  principalId!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_monitor_rules_session' })
  session!: Session;

  @Column({ type: 'varchar', length: 191 })
  groupJid!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @Column({ type: 'varchar', length: 8, default: 'all' })
  matchMode!: MonitorMatchMode;

  @Column({ type: jsonColumnType() })
  conditions!: MonitorCondition[];

  @Column({ type: jsonColumnType() })
  exclusions!: MonitorCondition[];

  @Column({ type: 'varchar', length: 16, default: 'normal' })
  priority!: MonitorPriority;

  @Column({ type: jsonColumnType() })
  tags!: string[];

  @Column({ type: 'varchar', length: 64, default: 'UTC' })
  timezone!: string;

  @Column({ type: jsonColumnType(), nullable: true })
  activeHours!: MonitorActiveHours | null;

  @Column({ type: jsonColumnType(), nullable: true })
  quietHours!: MonitorActiveHours | null;

  @Column({ type: 'int', nullable: true })
  retentionDays!: number | null;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
