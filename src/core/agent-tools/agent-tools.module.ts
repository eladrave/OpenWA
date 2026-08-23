import { Global, Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { SessionModule } from '../../modules/session/session.module';
import { MessageModule } from '../../modules/message/message.module';
import { ContactModule } from '../../modules/contact/contact.module';
import { GroupModule } from '../../modules/group/group.module';
import { WebhookModule } from '../../modules/webhook/webhook.module';
import { LabelModule } from '../../modules/label/label.module';
import { AutomationModule } from '../../modules/automation/automation.module';
import { SessionService } from '../../modules/session/session.service';
import { MessageService } from '../../modules/message/message.service';
import { ContactService } from '../../modules/contact/contact.service';
import { GroupService } from '../../modules/group/group.service';
import { WebhookService } from '../../modules/webhook/webhook.service';
import { LabelService } from '../../modules/label/label.service';
import { AutomationRulesService } from '../../modules/automation/automation-rules.service';
import { allAgentTools } from './tools';
import { MonitoringModule } from '../../modules/monitoring/monitoring.module';
import { MonitoringService } from '../../modules/monitoring/monitoring.service';
import { EnrollmentService } from '../../modules/monitoring/enrollment.service';

@Global()
@Module({
  imports: [
    SessionModule,
    MessageModule,
    ContactModule,
    GroupModule,
    WebhookModule,
    LabelModule,
    AutomationModule,
    MonitoringModule,
  ],
  providers: [
    {
      provide: ToolRegistryService,
      inject: [
        SessionService,
        MessageService,
        ContactService,
        GroupService,
        WebhookService,
        LabelService,
        AutomationRulesService,
        MonitoringService,
        EnrollmentService,
      ],
      useFactory: (
        session: SessionService,
        message: MessageService,
        contact: ContactService,
        group: GroupService,
        webhook: WebhookService,
        labels: LabelService,
        automation: AutomationRulesService,
        monitoring: MonitoringService,
        enrollment: EnrollmentService,
      ) =>
        new ToolRegistryService(
          allAgentTools({ session, message, contact, group, webhook, labels, automation, monitoring, enrollment }),
        ),
    },
  ],
  exports: [ToolRegistryService],
})
export class AgentToolsModule {}
