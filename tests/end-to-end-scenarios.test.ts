import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SyncService } from '../src/sync-service.js';
import { SalesforceWebhookPayload } from '../src/models/index.js';

const TEST_DATA_DIR = path.resolve('./data/test-e2e');
const TEST_JOURNAL = path.join(TEST_DATA_DIR, 'e2e_journal.jsonl');

function cleanDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

describe('Mandatory Assignment Scenarios (All 4 Evaluation Checks)', () => {
  beforeEach(() => {
    cleanDir();
  });

  afterEach(() => {
    cleanDir();
  });

  it('Scenario 1: A duplicate webhook is handled safely and idempotently', async () => {
    const service = new SyncService({ storageFilePath: TEST_JOURNAL, autoStartDispatcher: false });
    await service.start();

    const webhook: SalesforceWebhookPayload = {
      eventId: 'evt_mand_001',
      recordId: '003_contact_dup',
      objectType: 'Contact',
      occurredAt: '2026-11-02T11:30:04.000Z',
      changedBy: 'sales.user@client.example',
      changedFields: {
        phone: '+919876543210',
      },
    };

    // First arrival
    const res1 = await service.handleInboundWebhook(webhook);
    assert.equal(res1.status, 'PROCESSED');
    assert.equal(res1.applied, true);

    const contactAfterFirst = await service.storage.getContact('003_contact_dup');
    assert.ok(contactAfterFirst);
    assert.equal(contactAfterFirst.phone, '+919876543210');

    const auditAfterFirst = await service.storage.getAuditLogs('003_contact_dup');
    assert.equal(auditAfterFirst.length, 1);

    // Duplicate arrival of same webhook
    const res2 = await service.handleInboundWebhook(webhook);
    assert.equal(res2.status, 'DUPLICATE', 'Must report DUPLICATE on second arrival');
    assert.equal(res2.ignored, true);

    // State and history must remain unchanged
    const contactAfterSecond = await service.storage.getContact('003_contact_dup');
    assert.equal(contactAfterSecond?.phone, '+919876543210');

    const auditAfterSecond = await service.storage.getAuditLogs('003_contact_dup');
    assert.equal(auditAfterSecond.length, 1, 'Duplicate event must not duplicate audit entries');

    await service.stop();
  });

  it('Scenario 2: A change that arrives out of order preserves current state and records history', async () => {
    const service = new SyncService({ storageFilePath: TEST_JOURNAL, autoStartDispatcher: false });
    await service.start();

    // Event 2 (occurred at 12:00:05) arrives FIRST due to network delay
    const newerWebhook: SalesforceWebhookPayload = {
      eventId: 'evt_newer_t2',
      recordId: '003_contact_ooo',
      objectType: 'Contact',
      occurredAt: '2026-11-02T12:00:05.000Z',
      changedBy: 'sales.user2@client.example',
      changedFields: {
        phone: '+912222222222',
      },
    };

    await service.handleInboundWebhook(newerWebhook);

    const contactT2 = await service.storage.getContact('003_contact_ooo');
    assert.equal(contactT2?.phone, '+912222222222');

    // Event 1 (occurred earlier at 12:00:01) arrives SECOND
    const olderWebhook: SalesforceWebhookPayload = {
      eventId: 'evt_older_t1',
      recordId: '003_contact_ooo',
      objectType: 'Contact',
      occurredAt: '2026-11-02T12:00:01.000Z',
      changedBy: 'sales.user1@client.example',
      changedFields: {
        phone: '+911111111111',
      },
    };

    await service.handleInboundWebhook(olderWebhook);

    // Current projection MUST retain newer phone (+912222222222)
    const contactFinal = await service.storage.getContact('003_contact_ooo');
    assert.equal(
      contactFinal?.phone,
      '+912222222222',
      'Older out-of-order event must not regress the current field value'
    );

    // Complete audit history MUST contain both events
    const auditLogs = await service.storage.getAuditLogs('003_contact_ooo');
    assert.equal(auditLogs.length, 2, 'Audit trail must record both events');

    const olderAudit = auditLogs.find((a) => a.eventId === 'evt_older_t1');
    assert.ok(olderAudit);
    assert.equal(olderAudit.appliedToCurrent, false, 'Delayed older event must be flagged as not applied to current');
    assert.equal(olderAudit.newValue, '+911111111111');

    const newerAudit = auditLogs.find((a) => a.eventId === 'evt_newer_t2');
    assert.ok(newerAudit);
    assert.equal(newerAudit.appliedToCurrent, true, 'Newer event was applied to current');

    await service.stop();
  });

  it('Scenario 3: A sync loop where our own update comes back is prevented (echo suppression)', async () => {
    const service = new SyncService({ storageFilePath: TEST_JOURNAL, autoStartDispatcher: false });
    await service.start();

    // Finance user edits city in the Portal
    const portalMutation = await service.handlePortalEdit({
      recordId: '003_contact_loop',
      objectType: 'Contact',
      editedBy: 'finance.user@client.example',
      changedFields: {
        city: 'Noida',
      },
    });

    const pendingJobs = await service.storage.getPendingOutboxJobs();
    assert.equal(pendingJobs.length, 1);
    const correlationId = pendingJobs[0].correlationId;

    // Outbox dispatcher dispatches job to Salesforce API
    await service.drainOutbox();

    // Verify Salesforce received the update
    const crmRecord = await service.salesforceApi.getRecord('Contact', '003_contact_loop');
    assert.ok(crmRecord);
    assert.equal(crmRecord.city, 'Noida');

    // Simulate Salesforce emitting a webhook as a consequence of this update
    // The webhook carries our integration user email and correlationId
    const webhookEcho: SalesforceWebhookPayload = {
      eventId: 'evt_echo_from_sf_99',
      recordId: '003_contact_loop',
      objectType: 'Contact',
      occurredAt: new Date().toISOString(),
      changedBy: 'integration-portal@client.example',
      changedFields: {
        city: 'Noida',
      },
      correlationId,
    };

    const echoResult = await service.handleInboundWebhook(webhookEcho);
    assert.equal(echoResult.status, 'ECHO_SUPPRESSED', 'Incoming echo must be suppressed');

    // CRITICAL: Ensure NO new outbound job was enqueued in the outbox!
    const outboxJobsAfterEcho = await service.storage.getPendingOutboxJobs();
    assert.equal(outboxJobsAfterEcho.length, 0, 'No loop! Outbox must remain empty');

    await service.stop();
  });

  it('Scenario 4: 6-hour Salesforce outage with crash/restart recovery and backlog drain', async () => {
    // 1. Initialize service with fake Salesforce CRM OFFLINE (simulating 6-hour outage)
    const serviceInstance1 = new SyncService({
      storageFilePath: TEST_JOURNAL,
      maxRequestsPerSecond: 50,
      baseRetryDelayMs: 20,
      autoStartDispatcher: false,
    });
    serviceInstance1.salesforceApi.setOnline(false); // CRM IS DOWN
    await serviceInstance1.start();

    // 2. Portal users make edits during the outage
    const editCount = 10;
    for (let i = 0; i < editCount; i++) {
      await serviceInstance1.handlePortalEdit({
        recordId: `003_outage_${i}`,
        objectType: 'Contact',
        editedBy: 'finance.user@client.example',
        changedFields: {
          city: `OutageCity_${i}`,
        },
      });
    }

    // Attempt to drain queue while CRM is offline -> all attempts fail and back off
    await serviceInstance1.drainOutbox();

    const pendingDuringOutage = await serviceInstance1.storage.getPendingOutboxJobs();
    assert.equal(pendingDuringOutage.length, editCount, 'All edits must remain pending in durable queue');

    // 3. Simulate sudden Node.js crash and shutdown while CRM is still offline
    await serviceInstance1.stop();

    // 4. Restart Node.js application with a brand new SyncService instance from disk
    const serviceInstance2 = new SyncService({
      storageFilePath: TEST_JOURNAL,
      maxRequestsPerSecond: 50,
      baseRetryDelayMs: 20,
      autoStartDispatcher: false,
    });
    // CRM is STILL OFFLINE upon restart
    serviceInstance2.salesforceApi.setOnline(false);
    await serviceInstance2.start();

    // Verify all pending jobs survived restart and are ready in outbox
    const pendingAfterRestart = await serviceInstance2.storage.getPendingOutboxJobs();
    assert.equal(pendingAfterRestart.length, editCount, '100% of pending jobs must survive process restart');

    // 5. Salesforce CRM comes back ONLINE after outage!
    serviceInstance2.salesforceApi.setOnline(true);

    // Drain the backlog through the rate-limited dispatcher
    let totalDrained = 0;
    while (totalDrained < editCount) {
      const batchDrained = await serviceInstance2.drainOutbox();
      totalDrained += batchDrained;
      if (batchDrained === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    assert.equal(totalDrained, editCount);

    // Verify all pending jobs are completed
    const pendingFinal = await serviceInstance2.storage.getPendingOutboxJobs();
    assert.equal(pendingFinal.length, 0, 'Outbox must be completely drained');

    // Verify all 10 records were synchronized to Salesforce CRM
    for (let i = 0; i < editCount; i++) {
      const crmRec = await serviceInstance2.salesforceApi.getRecord('Contact', `003_outage_${i}`);
      assert.ok(crmRec);
      assert.equal(crmRec.city, `OutageCity_${i}`);
    }

    await serviceInstance2.stop();
  });
});
