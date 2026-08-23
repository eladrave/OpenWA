import { Module } from '@nestjs/common';
import { GroupModule } from '../group/group.module';
import { SessionModule } from '../session/session.module';
import { MonitoringPersistenceModule } from './monitoring-persistence.module';
import { MonitoringService } from './monitoring.service';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentExpiryService } from './enrollment-expiry.service';

@Module({
  imports: [MonitoringPersistenceModule, GroupModule, SessionModule],
  providers: [MonitoringService, EnrollmentService, EnrollmentExpiryService],
  exports: [MonitoringService, EnrollmentService, MonitoringPersistenceModule],
})
export class MonitoringModule {}
