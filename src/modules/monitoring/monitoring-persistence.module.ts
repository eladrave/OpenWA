import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { MonitorAuthFlow, MonitorCursor, MonitorGroup, MonitorMatch, MonitorProfile, MonitorRule } from './entities';
import { MonitoringIngestService } from './monitoring-ingest.service';
import { MonitoringReconcilerService } from './monitoring-reconciler.service';
import { MonitoringRetentionService } from './monitoring-retention.service';
import { MonitoringWorkerHealthService } from './monitoring-worker-health.service';

const entities = [
  MonitorProfile,
  MonitorGroup,
  MonitorRule,
  MonitorMatch,
  MonitorCursor,
  MonitorAuthFlow,
  Session,
  Message,
];

@Module({
  imports: [TypeOrmModule.forFeature(entities, 'data')],
  providers: [
    MonitoringWorkerHealthService,
    MonitoringIngestService,
    MonitoringReconcilerService,
    MonitoringRetentionService,
  ],
  exports: [
    TypeOrmModule,
    MonitoringWorkerHealthService,
    MonitoringIngestService,
    MonitoringReconcilerService,
    MonitoringRetentionService,
  ],
})
export class MonitoringPersistenceModule {}
