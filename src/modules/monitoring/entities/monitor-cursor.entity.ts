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

@Entity('monitor_cursors')
@Index('UQ_monitor_cursors_principal_session_name', ['principalId', 'sessionId', 'name'], { unique: true })
export class MonitorCursor {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  principalId!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_monitor_cursors_session' })
  session!: Session;

  @Column({ type: 'varchar', length: 64, default: 'default' })
  name!: string;

  @Column({ type: 'int', default: 1 })
  version!: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastAcknowledgedMatchId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
