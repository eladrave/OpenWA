import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { dateColumnType, jsonColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import { bigintToNumberTransformer } from '../../message/entities/message.entity';
import type {
  MonitorMatchMode,
  MonitorPriority,
  MonitorSemanticCondition,
  MonitorUrgencyResult,
} from '../monitoring.types';
import { Session } from '../../session/entities/session.entity';

export type MonitorMatchState = 'pending' | 'acknowledged' | 'dismissed' | 'expired';

@Entity('monitor_matches')
@Index('UQ_monitor_matches_rule_message_version', ['principalId', 'sessionId', 'ruleId', 'messageId', 'ruleVersion'], {
  unique: true,
})
@Index('IDX_monitor_matches_digest', ['principalId', 'sessionId', 'state', 'createdAt'])
@Index('IDX_monitor_matches_expiry', ['expiresAt'])
export class MonitorMatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  principalId!: string;

  @Column({ type: 'varchar', length: 64 })
  sessionId!: string;

  @ManyToOne(() => Session, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'sessionId', foreignKeyConstraintName: 'FK_monitor_matches_session' })
  session!: Session;

  @Column({ type: 'varchar', length: 191 })
  groupJid!: string;

  @Column({ type: 'varchar', length: 200 })
  groupName!: string;

  @Column({ type: 'varchar', length: 64 })
  ruleId!: string;

  @Column({ type: 'int' })
  ruleVersion!: number;

  @Column({ type: 'varchar', length: 8 })
  matchMode!: MonitorMatchMode;

  @Column({ type: 'varchar', length: 191 })
  messageId!: string;

  @Column({ type: 'varchar', length: 191 })
  senderJid!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  senderLabel!: string | null;

  @Column({ type: 'bigint', transformer: bigintToNumberTransformer })
  messageTimestamp!: number;

  @Column({ type: 'varchar', length: 32 })
  messageType!: string;

  @Column({ type: 'text', nullable: true })
  body!: string | null;

  @Column({ type: jsonColumnType(), nullable: true })
  media!: Record<string, unknown> | null;

  @Column({ type: jsonColumnType() })
  evidence!: string[];

  @Column({ type: jsonColumnType() })
  semanticConditions!: MonitorSemanticCondition[];

  @Column({ type: jsonColumnType() })
  urgency!: MonitorUrgencyResult;

  @Column({ type: 'varchar', length: 16 })
  priority!: MonitorPriority;

  @Column({ type: jsonColumnType() })
  tags!: string[];

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  state!: MonitorMatchState;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  acknowledgedAt!: Date | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}
