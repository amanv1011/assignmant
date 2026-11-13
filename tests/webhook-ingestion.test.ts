import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JsonlStorageEngine } from '../src/storage/index.js';
import { ConflictResolver } from '../src/sync/conflict-resolver.js';
import { WebhookHandler } from '../src/webhook/webhook-handler.js';
import { SalesforceWebhookPayload } from '../src/models/index.js';

const TEST_DATA_DIR = path.resolve('./data/test-webhook');
const TEST_JOURNAL = path.join(TEST_DATA_DIR, 'webhook_journal.jsonl');

function cleanDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

describe('Milestone 3: Webhook Ingestion, Idempotency & Loop Suppression', () => {
  let storage: JsonlStorageEngine;
  let resolver: ConflictResolver;
  let handler: WebhookHandler;

  beforeEach(async () => {
    cleanDir();
    storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL });
    await storage.init();
    resolver = new ConflictResolver();
    handler = new WebhookHandler(storage, resolver, {
      integrationUserEmail: 'integration-portal@client.example',
    });
  });

  afterEach(async () => {
    await storage.close();
    cleanDir();
  });

  it('processes a valid inbound webhook and stores Customer state and audit entry', async () => {
    const payload: SalesforceWebhookPayload = {
      eventId: 'evt_cust_001',
      recordId: '001A0000001',
      objectType: 'Customer',
      occurredAt: '2026-11-02T10:00:00.000Z',
      changedBy: 'sales.user@client.example',
      changedFields: {
        name: 'Tequity Client',
        status: 'Active',
        owner: 'sales.user@client.example',
      },
    };

    const result = await handler.handleWebhook(payload);
    assert.equal(result.status, 'PROCESSED');
    assert.equal(result.applied, true);

    const saved = await storage.getCustomer('001A0000001');
    assert.ok(saved);
    assert.equal(saved.name, 'Tequity Client');
    assert.equal(saved.status, 'Active');

    const auditLogs = await storage.getAuditLogs('001A0000001');
    assert.equal(auditLogs.length, 3, 'Should record audit log for each changed field');

    const pendingJobs = await storage.getPendingOutboxJobs();
    assert.equal(pendingJobs.length, 0, 'Inbound webhook must never create an outbound outbox job');
  });

  it('safely handles duplicate webhook delivery idempotently without creating duplicate state or audit logs', async () => {
    const payload: SalesforceWebhookPayload = {
      eventId: 'evt_dup_001',
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:30:04.000Z',
      changedBy: 'sales.user@client.example',
      changedFields: {
        phone: '+919876543210',
      },
    };

    // First arrival
    const res1 = await handler.handleWebhook(payload);
    assert.equal(res1.status, 'PROCESSED');
    assert.equal(res1.applied, true);

    const auditLogsFirst = await storage.getAuditLogs('0031A00000Abc');
    assert.equal(auditLogsFirst.length, 1);

    // Duplicate delivery of the EXACT same webhook event
    const res2 = await handler.handleWebhook(payload);
    assert.equal(res2.status, 'DUPLICATE', 'Second delivery must be identified as duplicate');
    assert.equal(res2.ignored, true);

    // Verify audit logs did NOT grow from duplicate event
    const auditLogsSecond = await storage.getAuditLogs('0031A00000Abc');
    assert.equal(auditLogsSecond.length, 1, 'Duplicate webhook delivery must not duplicate audit history');

    const pendingOutbox = await storage.getPendingOutboxJobs();
    assert.equal(pendingOutbox.length, 0);
  });

  it('suppresses echo loop when incoming webhook matches integration user', async () => {
    const echoPayload: SalesforceWebhookPayload = {
      eventId: 'evt_echo_001',
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      occurredAt: '2026-11-02T12:00:00.000Z',
      changedBy: 'integration-portal@client.example', // Matches portal integration account!
      changedFields: {
        city: 'Noida',
      },
    };

    const res = await handler.handleWebhook(echoPayload);
    assert.equal(res.status, 'ECHO_SUPPRESSED');
    assert.equal(res.applied, true);

    // Verify no outbox job was enqueued (loop broken!)
    const outboxJobs = await storage.getPendingOutboxJobs();
    assert.equal(outboxJobs.length, 0, 'Echo webhook must never be re-enqueued to outbox');
  });

  it('suppresses echo loop when incoming webhook carries registered correlationId', async () => {
    const correlationId = 'corr_test_uuid_999';
    handler.registerOutboundCorrelation(correlationId);

    const echoPayload: SalesforceWebhookPayload = {
      eventId: 'evt_echo_corr_001',
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      occurredAt: '2026-11-02T12:00:00.000Z',
      changedBy: 'sales.user@client.example', // Even if changedBy is third-party, correlation matches
      changedFields: {
        city: 'Gurgaon',
      },
      correlationId,
    };

    const res = await handler.handleWebhook(echoPayload);
    assert.equal(res.status, 'ECHO_SUPPRESSED');

    const outboxJobs = await storage.getPendingOutboxJobs();
    assert.equal(outboxJobs.length, 0, 'Correlation match must suppress loop');
  });
});
