import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MonitoringPersistenceModule } from '../monitoring/monitoring-persistence.module';

@Module({
  imports: [MonitoringPersistenceModule],
  controllers: [HealthController],
})
export class HealthModule {}
