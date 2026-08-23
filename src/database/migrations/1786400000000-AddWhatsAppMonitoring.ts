import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the session-owned WhatsApp monitoring data plane. JSON fields remain text on both dialects
 * to match jsonColumnType()/simple-json. Enrollment rows contain metadata only: no QR, pairing code,
 * phone number, auth-store content, or engine credential is persisted here.
 */
export class AddWhatsAppMonitoring1786400000000 implements MigrationInterface {
  name = 'AddWhatsAppMonitoring1786400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const pg = queryRunner.dataSource.options.type === 'postgres';
    const id = pg
      ? `"id" varchar PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()::varchar`
      : `"id" varchar PRIMARY KEY NOT NULL`;
    const boolTrue = pg ? 'true' : '1';
    const boolFalse = pg ? 'false' : '0';
    const created = pg ? `timestamp NOT NULL DEFAULT NOW()` : `datetime NOT NULL DEFAULT (datetime('now'))`;
    const updated = pg ? `timestamp NOT NULL DEFAULT NOW()` : `datetime NOT NULL DEFAULT (datetime('now'))`;
    const date = pg ? 'timestamp' : 'text';

    if (!(await queryRunner.hasTable('monitor_profiles'))) {
      await queryRunner.query(
        `CREATE TABLE "monitor_profiles" (` +
          `${id}, "principalId" varchar(64) NOT NULL, "sessionId" varchar(64) NOT NULL, ` +
          `"ownerJid" varchar(128), "enabled" boolean NOT NULL DEFAULT ${boolTrue}, ` +
          `"retentionDays" integer NOT NULL DEFAULT 7, "createdAt" ${created}, "updatedAt" ${updated}, ` +
          `CONSTRAINT "FK_monitor_profiles_session" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_monitor_profiles_principal_session" ON "monitor_profiles" ("principalId", "sessionId")`,
      );
    }

    if (!(await queryRunner.hasTable('monitor_groups'))) {
      await queryRunner.query(
        `CREATE TABLE "monitor_groups" (` +
          `${id}, "principalId" varchar(64) NOT NULL, "sessionId" varchar(64) NOT NULL, ` +
          `"groupJid" varchar(191) NOT NULL, "name" varchar(200) NOT NULL, ` +
          `"enabled" boolean NOT NULL DEFAULT ${boolTrue}, "lastReconciledCreatedAt" ${date}, ` +
          `"lastReconciledMessageRowId" varchar(64), "createdAt" ${created}, "updatedAt" ${updated}, ` +
          `CONSTRAINT "FK_monitor_groups_session" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_monitor_groups_principal_session_group" ON "monitor_groups" ("principalId", "sessionId", "groupJid")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_monitor_groups_session_group_enabled" ON "monitor_groups" ("sessionId", "groupJid", "enabled")`,
      );
    }
    if (!(await queryRunner.hasColumn('monitor_groups', 'lastReconciledCreatedAt'))) {
      await queryRunner.query(`ALTER TABLE "monitor_groups" ADD COLUMN "lastReconciledCreatedAt" ${date}`);
    }
    if (!(await queryRunner.hasColumn('monitor_groups', 'lastReconciledMessageRowId'))) {
      await queryRunner.query(`ALTER TABLE "monitor_groups" ADD COLUMN "lastReconciledMessageRowId" varchar(64)`);
    }
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_messages_session_chat_created_id" ON "messages" ("sessionId", "chatId", "createdAt", "id")`,
    );

    if (!(await queryRunner.hasTable('monitor_rules'))) {
      await queryRunner.query(
        `CREATE TABLE "monitor_rules" (` +
          `${id}, "principalId" varchar(64) NOT NULL, "sessionId" varchar(64) NOT NULL, ` +
          `"groupJid" varchar(191) NOT NULL, "name" varchar(100) NOT NULL, ` +
          `"enabled" boolean NOT NULL DEFAULT ${boolTrue}, "matchMode" varchar(8) NOT NULL DEFAULT 'all', ` +
          `"conditions" text NOT NULL, "exclusions" text NOT NULL, "priority" varchar(16) NOT NULL DEFAULT 'normal', ` +
          `"tags" text NOT NULL, "timezone" varchar(64) NOT NULL DEFAULT 'UTC', "activeHours" text, ` +
          `"quietHours" text, "retentionDays" integer, "version" integer NOT NULL DEFAULT 1, ` +
          `"createdAt" ${created}, "updatedAt" ${updated}, ` +
          `CONSTRAINT "FK_monitor_rules_session" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_monitor_rules_principal_session_group" ON "monitor_rules" ("principalId", "sessionId", "groupJid")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_monitor_rules_session_group_enabled" ON "monitor_rules" ("sessionId", "groupJid", "enabled")`,
      );
    }

    if (!(await queryRunner.hasTable('monitor_matches'))) {
      await queryRunner.query(
        `CREATE TABLE "monitor_matches" (` +
          `${id}, "principalId" varchar(64) NOT NULL, "sessionId" varchar(64) NOT NULL, ` +
          `"groupJid" varchar(191) NOT NULL, "groupName" varchar(200) NOT NULL, "ruleId" varchar(64) NOT NULL, ` +
          `"ruleVersion" integer NOT NULL, "matchMode" varchar(8) NOT NULL, "messageId" varchar(191) NOT NULL, ` +
          `"senderJid" varchar(191) NOT NULL, "senderLabel" varchar(200), "messageTimestamp" bigint NOT NULL, ` +
          `"messageType" varchar(32) NOT NULL, "body" text, "media" text, "evidence" text NOT NULL, ` +
          `"semanticConditions" text NOT NULL, ` +
          `"urgency" text NOT NULL, "priority" varchar(16) NOT NULL, "tags" text NOT NULL, ` +
          `"state" varchar(20) NOT NULL DEFAULT 'pending', "acknowledgedAt" ${date}, ` +
          `"expiresAt" ${date} NOT NULL, "createdAt" ${created}, ` +
          `CONSTRAINT "FK_monitor_matches_session" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_monitor_matches_rule_message_version" ON "monitor_matches" ("principalId", "sessionId", "ruleId", "messageId", "ruleVersion")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_monitor_matches_digest" ON "monitor_matches" ("principalId", "sessionId", "state", "createdAt")`,
      );
      await queryRunner.query(`CREATE INDEX "IDX_monitor_matches_expiry" ON "monitor_matches" ("expiresAt")`);
    }

    if (!(await queryRunner.hasTable('monitor_cursors'))) {
      await queryRunner.query(
        `CREATE TABLE "monitor_cursors" (` +
          `${id}, "principalId" varchar(64) NOT NULL, "sessionId" varchar(64) NOT NULL, ` +
          `"name" varchar(64) NOT NULL DEFAULT 'default', "version" integer NOT NULL DEFAULT 1, ` +
          `"lastAcknowledgedMatchId" varchar(64), "createdAt" ${created}, "updatedAt" ${updated}, ` +
          `CONSTRAINT "FK_monitor_cursors_session" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_monitor_cursors_principal_session_name" ON "monitor_cursors" ("principalId", "sessionId", "name")`,
      );
    }

    if (!(await queryRunner.hasTable('monitor_auth_flows'))) {
      await queryRunner.query(
        `CREATE TABLE "monitor_auth_flows" (` +
          `${id}, "principalId" varchar(64) NOT NULL, "sessionId" varchar(64) NOT NULL, ` +
          `"activeKey" varchar(140), "mode" varchar(24) NOT NULL, "state" varchar(32) NOT NULL, ` +
          `"expiresAt" ${date} NOT NULL, "challengeIssuedAt" ${date}, "completedAt" ${date}, ` +
          `"errorCode" varchar(64), "errorMessage" varchar(300), "createdAt" ${created}, "updatedAt" ${updated}, ` +
          `CONSTRAINT "FK_monitor_auth_flows_session" FOREIGN KEY ("sessionId") REFERENCES "sessions" ("id") ON DELETE CASCADE)`,
      );
      await queryRunner.query(
        `CREATE UNIQUE INDEX "UQ_monitor_auth_flows_active_key" ON "monitor_auth_flows" ("activeKey")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_monitor_auth_flows_principal_session" ON "monitor_auth_flows" ("principalId", "sessionId", "createdAt")`,
      );
      await queryRunner.query(
        `CREATE INDEX "IDX_monitor_auth_flows_completed" ON "monitor_auth_flows" ("completedAt")`,
      );
    }

    // Keep a literal use so both dialect branches document their boolean representation even when
    // all current defaults happen to be true.
    void boolFalse;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_session_chat_created_id"`);
    for (const table of [
      'monitor_auth_flows',
      'monitor_cursors',
      'monitor_matches',
      'monitor_rules',
      'monitor_groups',
      'monitor_profiles',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }
}
