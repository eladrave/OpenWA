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
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import type { MonitorEnrollmentMode, MonitorEnrollmentState } from '../monitoring.types';
import { Session } from '../../session/entities/session.entity';

@Entity('monitor_auth_flows')
@Index('UQ_monitor_auth_flows_active_key', ['activeKey'], { unique: true })
@Index('IDX_monitor_auth_flows_principal_session', ['principalId', 'sessionId', 'createdAt'])
@Index('IDX_monitor_auth_flows_completed', ['completedAt'])
export class MonitorAuthFlow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  principalId!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_monitor_auth_flows_session' })
  session!: Session;

  @Column({ type: 'varchar', length: 140, nullable: true })
  activeKey!: string | null;

  @Column({ type: 'varchar', length: 24 })
  mode!: MonitorEnrollmentMode;

  @Column({ type: 'varchar', length: 32 })
  state!: MonitorEnrollmentState;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  expiresAt!: Date;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  challengeIssuedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode!: string | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
