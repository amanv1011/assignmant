import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JsonlStorageEngine } from '../src/storage/index.js';
import { ConflictResolver } from '../src/sync/conflict-resolver.js';
import { PortalService } from '../src/sync/portal-service.js';
import { MockSalesforceApi } from '../src/mock-salesforce/mock-salesforce-api.js';
import { RateLimiter } from '../src/workers/rate-limiter.js';
import { OutboxDispatcher } from '../src/workers/outbox-dispatcher.js';

const TEST_DATA_DIR = path.resolve('./data/test-outbox');
const TEST_JOURNAL = path.join(TEST_DATA_DIR, 'outbox_journal.jsonl');

function cleanDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

describe('Milestone 4: Transactional Outbox, Rate Limiting & Reliable Delivery', () => {
  let storage: JsonlStorageEngine;
  let resolver: ConflictResolver;
  let portalService: PortalService;
  let mockCrm: MockSalesforceApi;
  let rateLimiter: RateLimiter;
  let dispatcher: OutboxDispatcher;

  beforeEach(async () => {
    cleanDir();
    storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL });
    await storage.init();
    resolver = new ConflictResolver();
    portalService = new PortalService(storage, resolver);
    mockCrm = new MockSalesforceApi({ maxRequestsPerSecond: 100 });
    rateLimiter = new RateLimiter({ maxRequestsPerSecond: 100 });
    dispatcher = new OutboxDispatcher(storage, mockCrm, rateLimiter, undefined, {
      baseRetryDelayMs: 20,
    });
  });

  afterEach(async () => {
    dispatcher.stop();
    await storage.close();
    cleanDir();
  });

  it('atomically creates entity, audit entries, and outbox job on portal edit', async () => {
    const editResult = await portalService.editContact({
      recordId: '003_contact_atom',
      objectType: 'Contact',
      editedBy: 'finance.user@client.example',
      changedFields: { city: 'Bengaluru' },
    });

    assert.ok(editResult.record);
    assert.equal((editResult.record as any).city, 'Bengaluru');

    const pendingJobs = await storage.getPendingOutboxJobs();
    assert.equal(pendingJobs.length, 1);
    assert.equal(pendingJobs[0].recordId, '003_contact_atom');
    assert.equal(pendingJobs[0].status, 'PENDING');
    assert.equal(pendingJobs[0].payload.city, 'Bengaluru');

    const audit = await storage.getAuditLogs('003_contact_atom');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].newValue, 'Bengaluru');
  });

  it('drains pending outbox jobs and marks them COMPLETED upon successful CRM call', async () => {
    await portalService.editCustomer({
      recordId: '001_cust_sync',
      objectType: 'Customer',
      editedBy: 'finance.user@client.example',
      changedFields: { name: 'Acme Cloud' },
    });

    const pendingBefore = await storage.getPendingOutboxJobs();
    assert.equal(pendingBefore.length, 1);

    const drained = await dispatcher.drainQueueOnce();
    assert.equal(drained, 1);

    const pendingAfter = await storage.getPendingOutboxJobs();
    assert.equal(pendingAfter.length, 0, 'Completed job must no longer be pending');

    const crmRecord = await mockCrm.getRecord('Customer', '001_cust_sync');
    assert.ok(crmRecord);
    assert.equal(crmRecord.name, 'Acme Cloud');
  });

  it('handles CRM failure with exponential backoff and retries until max attempts reached', async () => {
    // Take mock CRM offline
    mockCrm.setOnline(false);

    await portalService.editContact({
      recordId: '003_retry_contact',
      objectType: 'Contact',
      editedBy: 'finance.user@client.example',
      changedFields: { phone: '+918888888888' },
    });

    // Attempt 1 -> fails because CRM is offline
    await dispatcher.drainQueueOnce();

    const jobsAfterAttempt1 = await storage.getPendingOutboxJobs();
    assert.equal(jobsAfterAttempt1.length, 1);
    assert.equal(jobsAfterAttempt1[0].attempts, 1);
    assert.ok(jobsAfterAttempt1[0].lastError?.includes('ETIMEDOUT'));

    // Wait for backoff window
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Attempt 2
    await dispatcher.drainQueueOnce();
    const jobsAfterAttempt2 = await storage.getPendingOutboxJobs();
    assert.equal(jobsAfterAttempt2[0].attempts, 2);

    // Bring CRM back online!
    mockCrm.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Attempt 3 -> succeeds!
    await dispatcher.drainQueueOnce();

    const pendingFinal = await storage.getPendingOutboxJobs();
    assert.equal(pendingFinal.length, 0, 'Job should successfully complete once CRM is restored');

    const synced = await mockCrm.getRecord('Contact', '003_retry_contact');
    assert.ok(synced);
    assert.equal(synced.phone, '+918888888888');
  });

  it('marks job FAILED when exceeding max attempts', async () => {
    mockCrm.setOnline(false);
    const fastRetryDispatcher = new OutboxDispatcher(storage, mockCrm, rateLimiter, undefined, {
      baseRetryDelayMs: 2,
    });

    await portalService.editContact({
      recordId: '003_fail_contact',
      objectType: 'Contact',
      editedBy: 'finance.user@client.example',
      changedFields: { phone: '+910000000000' },
    });

    const pending = await storage.getPendingOutboxJobs();
    const jobId = pending[0].id;

    // Run 5 failed attempts with enough wait time for exponential backoff (2, 4, 8, 16, 32ms)
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fastRetryDispatcher.drainQueueOnce();
    }

    const job = await storage.getOutboxJob(jobId);
    assert.ok(job);
    assert.equal(job.status, 'FAILED');
    assert.equal(job.attempts, 5);

    const pendingLeft = await storage.getPendingOutboxJobs();
    assert.equal(pendingLeft.length, 0, 'FAILED job is removed from pending queue');
  });

  it('enforces configured rate limiter cap across dispatched requests', async () => {
    // Configure rate limiter with cap of 20 req/s and 0 initial burst tokens to strictly measure refill pacing
    const tightLimiter = new RateLimiter({ maxRequestsPerSecond: 20, initialTokens: 0 });
    const tightDispatcher = new OutboxDispatcher(storage, mockCrm, tightLimiter);

    for (let i = 0; i < 8; i++) {
      await portalService.editContact({
        recordId: `003_rate_${i}`,
        objectType: 'Contact',
        editedBy: 'finance.user@client.example',
        changedFields: { city: `City_${i}` },
      });
    }

    const start = Date.now();
    await tightDispatcher.drainQueueOnce(8);
    const elapsed = Date.now() - start;

    // At 20 req/s with 0 initial burst, 8 requests should take at least 350ms (8 * 50ms = 400ms)
    assert.ok(elapsed >= 350, `Rate limiter should meter requests; elapsed was ${elapsed}ms`);
  });
});
