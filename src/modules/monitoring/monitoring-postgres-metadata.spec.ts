import { DataSource } from 'typeorm';
import { Session } from '../session/entities/session.entity';
import { Message } from '../message/entities/message.entity';
import { MonitorAuthFlow, MonitorCursor, MonitorGroup, MonitorMatch, MonitorProfile, MonitorRule } from './entities';

describe('monitoring PostgreSQL metadata', () => {
  it('builds every monitoring entity without dialect-invalid relation column options', async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      host: 'invalid.example',
      entities: [
        Session,
        Message,
        MonitorProfile,
        MonitorGroup,
        MonitorRule,
        MonitorMatch,
        MonitorCursor,
        MonitorAuthFlow,
      ],
    });
    await (
      dataSource as unknown as {
        buildMetadatas(): Promise<void>;
      }
    ).buildMetadatas();
    expect(dataSource.getMetadata(MonitorProfile).findColumnWithPropertyName('sessionId')?.length).toBe('');
  });
});
