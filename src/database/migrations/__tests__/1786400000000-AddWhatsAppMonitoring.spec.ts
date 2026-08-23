import { DataSource } from 'typeorm';
import { AddWhatsAppMonitoring1786400000000 } from '../1786400000000-AddWhatsAppMonitoring';

describe('AddWhatsAppMonitoring1786400000000', () => {
  it('creates the complete SQLite monitoring schema with session cascades and active-flow uniqueness', async () => {
    const dataSource = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await dataSource.initialize();
    const runner = dataSource.createQueryRunner();
    try {
      await runner.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL)`);
      await runner.query(
        `CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, "createdAt" datetime NOT NULL)`,
      );
      const migration = new AddWhatsAppMonitoring1786400000000();
      await migration.up(runner);

      for (const table of [
        'monitor_profiles',
        'monitor_groups',
        'monitor_rules',
        'monitor_matches',
        'monitor_cursors',
        'monitor_auth_flows',
      ]) {
        expect(await runner.hasTable(table)).toBe(true);
      }

      const matchTable = await runner.getTable('monitor_matches');
      expect(matchTable?.columns.map(column => column.name)).toEqual(
        expect.arrayContaining([
          'id',
          'principalId',
          'sessionId',
          'groupJid',
          'groupName',
          'ruleId',
          'ruleVersion',
          'matchMode',
          'messageId',
          'senderJid',
          'senderLabel',
          'messageTimestamp',
          'messageType',
          'body',
          'media',
          'evidence',
          'semanticConditions',
          'urgency',
          'priority',
          'tags',
          'state',
          'acknowledgedAt',
          'expiresAt',
          'createdAt',
        ]),
      );

      await runner.query(`INSERT INTO "sessions" ("id") VALUES ('session-1')`);
      await runner.query(
        `INSERT INTO "monitor_profiles" ("id", "principalId", "sessionId", "enabled", "retentionDays") VALUES ('p1', 'owner-1', 'session-1', 1, 7)`,
      );
      await runner.query(
        `INSERT INTO "monitor_auth_flows" ("id", "principalId", "sessionId", "activeKey", "mode", "state", "expiresAt") VALUES ('f1', 'owner-1', 'session-1', 'session:session-1', 'qr', 'starting', '2026-08-23T12:00:00.000Z')`,
      );
      await expect(
        runner.query(
          `INSERT INTO "monitor_auth_flows" ("id", "principalId", "sessionId", "activeKey", "mode", "state", "expiresAt") VALUES ('f2', 'owner-2', 'session-1', 'session:session-1', 'qr', 'starting', '2026-08-23T12:00:00.000Z')`,
        ),
      ).rejects.toThrow();

      await runner.query(`DELETE FROM "sessions" WHERE "id" = 'session-1'`);
      expect(await runner.query(`SELECT * FROM "monitor_profiles"`)).toEqual([]);
      expect(await runner.query(`SELECT * FROM "monitor_auth_flows"`)).toEqual([]);

      await migration.down(runner);
      expect(await runner.hasTable('monitor_profiles')).toBe(false);
    } finally {
      await runner.release();
      await dataSource.destroy();
    }
  });
});
