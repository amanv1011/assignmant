import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  JsonlStorageEngine,
  Customer,
  Contact,
  AuditLogEntry,
  OutboxJob,
  AtomicCommit,
} from '../src/index.js';

const TEST_DATA_DIR = path.resolve('./data/test-storage');
const TEST_JOURNAL_FILE = path.join(TEST_DATA_DIR, 'test_journal.jsonl');

function cleanTestDir() {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

describe('JsonlStorageEngine - Milestone 1 Foundation', () => {
  beforeEach(() => {
    cleanTestDir();
  });

  afterEach(() => {
    cleanTestDir();
  });

  it('persists Customer, Contact, Audit, and Outbox in an atomic transaction', async () => {
    const storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await storage.init();

    const timestamp = new Date().toISOString();
    const customer: Customer = {
      id: 'cust_001',
      name: 'Acme Corp',
      status: 'Active',
      owner: 'sales.rep@client.example',
      createdAt: timestamp,
      updatedAt: timestamp,
      fieldTimestamps: {
        name: timestamp,
        status: timestamp,
        owner: timestamp,
      },
    };

    const contact: Contact = {
      id: 'cont_001',
      customerId: 'cust_001',
      fullName: 'Alice Smith',
      phone: '+15550199',
      email: 'alice@acme.example',
      city: 'San Francisco',
      owner: 'sales.rep@client.example',
      createdAt: timestamp,
      updatedAt: timestamp,
      fieldTimestamps: {
        fullName: timestamp,
        phone: timestamp,
        email: timestamp,
        city: timestamp,
        owner: timestamp,
        customerId: timestamp,
      },
    };

    const auditEntry: AuditLogEntry = {
      id: randomUUID(),
      recordId: 'cont_001',
      objectType: 'Contact',
      fieldName: 'city',
      oldValue: null,
      newValue: 'San Francisco',
      changedBy: 'sales.rep@client.example',
      eventTimestamp: timestamp,
      receivedAt: timestamp,
      eventSource: 'SALESFORCE_WEBHOOK',
      eventId: 'evt_init_001',
      appliedToCurrent: true,
    };

    const outboxJob: OutboxJob = {
      id: randomUUID(),
      recordId: 'cont_001',
      objectType: 'Contact',
      operation: 'UPDATE',
      payload: { city: 'San Francisco' },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      correlationId: 'corr_init_001',
      createdAt: timestamp,
      updatedAt: timestamp,
      nextAttemptAt: timestamp,
      lastError: null,
    };

    const commit: AtomicCommit = {
      commitId: randomUUID(),
      timestamp,
      customers: [customer],
      contacts: [contact],
      auditEntries: [auditEntry],
      processedEvents: [
        {
          eventId: 'evt_init_001',
          recordId: 'cont_001',
          objectType: 'Contact',
          processedAt: timestamp,
          source: 'SALESFORCE_WEBHOOK',
        },
      ],
      outboxJobs: [outboxJob],
    };

    await storage.commitTransaction(commit);

    // Verify in-memory state
    const retrievedCust = await storage.getCustomer('cust_001');
    assert.deepEqual(retrievedCust, customer);

    const retrievedContact = await storage.getContact('cont_001');
    assert.deepEqual(retrievedContact, contact);

    const auditLogs = await storage.getAuditLogs('cont_001');
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].newValue, 'San Francisco');

    const isProcessed = await storage.isEventProcessed('evt_init_001');
    assert.equal(isProcessed, true);

    const pendingJobs = await storage.getPendingOutboxJobs();
    assert.equal(pendingJobs.length, 1);
    assert.equal(pendingJobs[0].id, outboxJob.id);

    await storage.close();

    // Verify file content has exactly one line
    const content = fs.readFileSync(TEST_JOURNAL_FILE, 'utf-8').trim();
    const lines = content.split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.type, 'ATOMIC_COMMIT');
    assert.equal(parsed.commitId, commit.commitId);
  });

  it('recovers all state and indexes on restart from disk', async () => {
    const timestamp = new Date().toISOString();
    const initialStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await initialStorage.init();

    await initialStorage.commitTransaction({
      commitId: randomUUID(),
      timestamp,
      customers: [
        {
          id: 'cust_restart',
          name: 'Globex',
          status: 'Active',
          owner: 'rep@client.example',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
      contacts: [
        {
          id: 'cont_restart',
          customerId: 'cust_restart',
          fullName: 'Bob Vance',
          phone: '+123456789',
          email: 'bob@globex.example',
          city: 'Scranton',
          owner: 'rep@client.example',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: {
            fullName: timestamp,
            phone: timestamp,
            email: timestamp,
            city: timestamp,
            owner: timestamp,
            customerId: timestamp,
          },
        },
      ],
      auditEntries: [
        {
          id: randomUUID(),
          recordId: 'cont_restart',
          objectType: 'Contact',
          fieldName: 'city',
          oldValue: null,
          newValue: 'Scranton',
          changedBy: 'rep@client.example',
          eventTimestamp: timestamp,
          receivedAt: timestamp,
          eventSource: 'PORTAL',
          eventId: 'evt_portal_001',
          appliedToCurrent: true,
        },
      ],
      processedEvents: [
        {
          eventId: 'evt_portal_001',
          recordId: 'cont_restart',
          objectType: 'Contact',
          processedAt: timestamp,
          source: 'PORTAL',
        },
      ],
    });

    await initialStorage.close();

    // Simulate complete process restart with fresh instance
    const restartedStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await restartedStorage.init();

    const customer = await restartedStorage.getCustomer('cust_restart');
    assert.ok(customer);
    assert.equal(customer.name, 'Globex');

    const contact = await restartedStorage.getContact('cont_restart');
    assert.ok(contact);
    assert.equal(contact.city, 'Scranton');

    const audit = await restartedStorage.getAuditLogs('cont_restart');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].changedBy, 'rep@client.example');

    const isProcessed = await restartedStorage.isEventProcessed('evt_portal_001');
    assert.equal(isProcessed, true);

    await restartedStorage.close();
  });

  it('recovers both PENDING and IN_FLIGHT jobs as PENDING after restart', async () => {
    const timestamp = new Date().toISOString();
    const initialStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await initialStorage.init();

    const jobPending: OutboxJob = {
      id: 'job_pending_1',
      recordId: 'rec_1',
      objectType: 'Contact',
      operation: 'UPDATE',
      payload: { phone: '111' },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      correlationId: 'corr_1',
      createdAt: timestamp,
      updatedAt: timestamp,
      nextAttemptAt: timestamp,
      lastError: null,
    };

    const jobInFlight: OutboxJob = {
      id: 'job_inflight_2',
      recordId: 'rec_2',
      objectType: 'Contact',
      operation: 'UPDATE',
      payload: { phone: '222' },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      correlationId: 'corr_2',
      createdAt: timestamp,
      updatedAt: timestamp,
      nextAttemptAt: timestamp,
      lastError: null,
    };

    await initialStorage.commitTransaction({
      commitId: randomUUID(),
      timestamp,
      outboxJobs: [jobPending, jobInFlight],
    });

    // Mark second job as IN_FLIGHT (simulating active dispatch right before process kill)
    await initialStorage.updateOutboxJobStatus('job_inflight_2', 'IN_FLIGHT', { attempts: 1 });

    const jobBeforeCrash = await initialStorage.getOutboxJob('job_inflight_2');
    assert.equal(jobBeforeCrash?.status, 'IN_FLIGHT');

    await initialStorage.close();

    // Restart process
    const restartedStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await restartedStorage.init();

    const recoveredPendingJobs = await restartedStorage.getPendingOutboxJobs();
    assert.equal(recoveredPendingJobs.length, 2, 'Both jobs must be pending after restart');

    const recovered1 = await restartedStorage.getOutboxJob('job_pending_1');
    const recovered2 = await restartedStorage.getOutboxJob('job_inflight_2');

    assert.equal(recovered1?.status, 'PENDING');
    assert.equal(recovered2?.status, 'PENDING', 'IN_FLIGHT job must be reset to PENDING');
    assert.equal(recovered2?.attempts, 1, 'Job attempts must be preserved');

    await restartedStorage.close();
  });

  it('safely handles an incomplete trailing line on restart', async () => {
    const timestamp = new Date().toISOString();
    const storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await storage.init();

    await storage.commitTransaction({
      commitId: 'commit_valid_1',
      timestamp,
      customers: [
        {
          id: 'cust_valid',
          name: 'Valid Corp',
          status: 'Active',
          owner: 'rep@client.example',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    await storage.close();

    // Corrupt the file by appending an unclosed, partial write at the end
    fs.appendFileSync(TEST_JOURNAL_FILE, '{"type":"ATOMIC_COMMIT","commitId":"commit_broken_incom');

    // Restart process: should log warning and recover cleanly
    const restartedStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await restartedStorage.init();

    const cust = await restartedStorage.getCustomer('cust_valid');
    assert.ok(cust);
    assert.equal(cust.name, 'Valid Corp');

    // Subsequent write should append cleanly
    await restartedStorage.commitTransaction({
      commitId: 'commit_valid_2',
      timestamp,
      customers: [
        {
          id: 'cust_valid_2',
          name: 'Second Corp',
          status: 'Active',
          owner: 'rep@client.example',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    const cust2 = await restartedStorage.getCustomer('cust_valid_2');
    assert.ok(cust2);
    assert.equal(cust2.name, 'Second Corp');

    await restartedStorage.close();

    // Verify journal file has exactly 2 valid JSON lines now
    const content = fs.readFileSync(TEST_JOURNAL_FILE, 'utf-8').trim();
    const lines = content.split('\n');
    assert.equal(lines.length, 2);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
    assert.doesNotThrow(() => JSON.parse(lines[1]));
  });

  it('throws fatal error on middle-of-file corruption instead of silently ignoring it', async () => {
    const timestamp = new Date().toISOString();
    const storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await storage.init();

    await storage.commitTransaction({
      commitId: 'commit_1',
      timestamp,
      customers: [
        {
          id: 'cust_1',
          name: 'First',
          status: 'Active',
          owner: 'rep',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    await storage.commitTransaction({
      commitId: 'commit_2',
      timestamp,
      customers: [
        {
          id: 'cust_2',
          name: 'Second',
          status: 'Active',
          owner: 'rep',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    await storage.close();

    // Inject corruption in the middle (between line 1 and line 2)
    const content = fs.readFileSync(TEST_JOURNAL_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    const corruptedContent = `${lines[0]}\nCORRUPTED_MIDDLE_LINE_GARBAGE\n${lines[1]}\n`;
    fs.writeFileSync(TEST_JOURNAL_FILE, corruptedContent, 'utf-8');

    // Attempting to restart must throw fatal error
    const failedStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await assert.rejects(
      async () => {
        await failedStorage.init();
      },
      /Fatal journal corruption at line 2: unparseable middle-of-file data/
    );
  });

  it('serializes concurrent writes without corrupting the journal file', async () => {
    const storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await storage.init();

    const writeCount = 50;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < writeCount; i++) {
      const timestamp = new Date().toISOString();
      promises.push(
        storage.commitTransaction({
          commitId: `concurrent_commit_${i}`,
          timestamp,
          customers: [
            {
              id: `cust_${i}`,
              name: `Customer ${i}`,
              status: 'Active',
              owner: 'rep',
              createdAt: timestamp,
              updatedAt: timestamp,
              fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
            },
          ],
        })
      );
    }

    // Await all concurrent writes
    await Promise.all(promises);

    const allCustomers = await storage.getAllCustomers();
    assert.equal(allCustomers.length, writeCount);

    await storage.close();

    // Verify all 50 lines exist and are valid JSON
    const content = fs.readFileSync(TEST_JOURNAL_FILE, 'utf-8').trim();
    const lines = content.split('\n');
    assert.equal(lines.length, writeCount);
    for (let i = 0; i < writeCount; i++) {
      assert.doesNotThrow(() => JSON.parse(lines[i]));
    }
  });

  it('throws fatal error if final line has an unknown entry type', async () => {
    const timestamp = new Date().toISOString();
    const storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await storage.init();

    await storage.commitTransaction({
      commitId: 'commit_valid_prefix',
      timestamp,
      customers: [
        {
          id: 'cust_valid_prefix',
          name: 'Acme',
          status: 'Active',
          owner: 'rep',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    await storage.close();

    // Append a valid JSON record with an UNKNOWN type as the final line
    fs.appendFileSync(
      TEST_JOURNAL_FILE,
      JSON.stringify({
        type: 'UNKNOWN_RECORD_TYPE',
        commitId: 'unknown_001',
        timestamp,
      }) + '\n'
    );

    const restartedStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await assert.rejects(
      async () => {
        await restartedStorage.init();
      },
      /Fatal journal corruption at line 2: invalid journal record schema.*Unknown journal entry type/
    );
  });

  it('throws fatal error if final line has valid JSON but missing required fields', async () => {
    const timestamp = new Date().toISOString();
    const storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await storage.init();

    await storage.commitTransaction({
      commitId: 'commit_prefix',
      timestamp,
      customers: [
        {
          id: 'cust_prefix',
          name: 'Beta',
          status: 'Active',
          owner: 'rep',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    await storage.close();

    // Append a valid JSON record of type OUTBOX_STATUS missing required 'status' and 'attempts' fields
    fs.appendFileSync(
      TEST_JOURNAL_FILE,
      JSON.stringify({
        type: 'OUTBOX_STATUS',
        commitId: 'outbox_broken_001',
        timestamp,
        jobId: 'job_xyz',
        // missing status and attempts
      }) + '\n'
    );

    const restartedStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await assert.rejects(
      async () => {
        await restartedStorage.init();
      },
      /Fatal journal corruption at line 2: invalid journal record schema.*Missing or invalid required field/
    );
  });

  it('recovers cleanly when valid JSON lacks a trailing newline, allows subsequent append, and restarts', async () => {
    const timestamp = new Date().toISOString();
    // Step 1: Journal contains one valid JSON record without a trailing newline
    const firstRecord = {
      type: 'ATOMIC_COMMIT',
      commitId: 'commit_no_newline_1',
      timestamp,
      customers: [
        {
          id: 'cust_no_newline_1',
          name: 'First Without Newline',
          status: 'Active',
          owner: 'rep',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    };

    const dir = path.dirname(TEST_JOURNAL_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // Write WITHOUT newline
    fs.writeFileSync(TEST_JOURNAL_FILE, JSON.stringify(firstRecord), 'utf-8');

    // Step 2: Application starts successfully
    const storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await storage.init();

    const loaded1 = await storage.getCustomer('cust_no_newline_1');
    assert.ok(loaded1);
    assert.equal(loaded1.name, 'First Without Newline');

    // Step 3: Application appends another journal record
    await storage.commitTransaction({
      commitId: 'commit_no_newline_2',
      timestamp,
      customers: [
        {
          id: 'cust_no_newline_2',
          name: 'Second Appended Record',
          status: 'Active',
          owner: 'rep',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    await storage.close();

    // Verify raw file has exactly two separate lines
    const rawContent = fs.readFileSync(TEST_JOURNAL_FILE, 'utf-8');
    assert.ok(rawContent.endsWith('\n'), 'File must end with newline');
    const lines = rawContent.trim().split('\n');
    assert.equal(lines.length, 2, 'File must contain exactly two separate JSONL lines');
    assert.doesNotThrow(() => JSON.parse(lines[0]), 'First line must be valid JSON');
    assert.doesNotThrow(() => JSON.parse(lines[1]), 'Second line must be valid JSON');

    // Step 4: Application restarts
    const restartedStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await restartedStorage.init();

    const recovered1 = await restartedStorage.getCustomer('cust_no_newline_1');
    const recovered2 = await restartedStorage.getCustomer('cust_no_newline_2');

    assert.ok(recovered1, 'Record 1 must be recovered after restart');
    assert.ok(recovered2, 'Record 2 must be recovered after restart');
    assert.equal(recovered1.name, 'First Without Newline');
    assert.equal(recovered2.name, 'Second Appended Record');

    await restartedStorage.close();
  });

  it('safe buffer write loop guarantees full record writing before synchronization', async () => {
    const storage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await storage.init();

    // Generate large payload (50KB) to ensure multiple buffer chunks are handled by the write loop
    const largePayload: Record<string, string> = {};
    for (let i = 0; i < 500; i++) {
      largePayload[`key_${i}`] = 'x'.repeat(100);
    }

    const timestamp = new Date().toISOString();
    await storage.commitTransaction({
      commitId: 'commit_large_payload',
      timestamp,
      outboxJobs: [
        {
          id: 'large_job_001',
          recordId: 'rec_large',
          objectType: 'Contact',
          operation: 'UPDATE',
          payload: largePayload,
          status: 'PENDING',
          attempts: 0,
          maxAttempts: 3,
          correlationId: 'corr_large',
          createdAt: timestamp,
          updatedAt: timestamp,
          nextAttemptAt: timestamp,
          lastError: null,
        },
      ],
    });

    await storage.close();

    // Verify the large record was written completely and can be replayed
    const restarted = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await restarted.init();

    const job = await restarted.getOutboxJob('large_job_001');
    assert.ok(job);
    assert.equal(Object.keys(job.payload).length, 500);
    assert.equal(job.payload.key_499, 'x'.repeat(100));

    await restarted.close();
  });

  it('enters failed state on partial write failure, rejects subsequent writes, and recovers cleanly on restart', async () => {
    const timestamp = new Date().toISOString();
    let writeCallCount = 0;
    let simulateFailure = false;

    // Custom writeSyncFn that simulates writing only 15 bytes and then throwing ENOSPC
    const faultTolerantWriter = (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number): number => {
      if (simulateFailure) {
        writeCallCount++;
        if (writeCallCount === 1) {
          // Write only 15 bytes: a genuine hardware partial write!
          return fs.writeSync(fd, buffer, offset, Math.min(15, length));
        }
        // Second chunk fails with ENOSPC
        throw new Error('ENOSPC: no space left on device');
      }
      return fs.writeSync(fd, buffer, offset, length);
    };

    const storage = new JsonlStorageEngine({
      filePath: TEST_JOURNAL_FILE,
      writeSyncFn: faultTolerantWriter,
    });
    await storage.init();

    // Write Record 1 successfully
    await storage.commitTransaction({
      commitId: 'commit_step1',
      timestamp,
      customers: [
        {
          id: 'cust_step1',
          name: 'Step 1 Customer',
          status: 'Active',
          owner: 'rep',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    // Arm fault injection to simulate partial write followed by failure
    simulateFailure = true;

    await assert.rejects(
      async () => {
        await storage.commitTransaction({
          commitId: 'commit_partial_fail',
          timestamp,
          customers: [
            {
              id: 'cust_partial_fail',
              name: 'Partial Fail Customer',
              status: 'Active',
              owner: 'rep',
              createdAt: timestamp,
              updatedAt: timestamp,
              fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
            },
          ],
        });
      },
      /ENOSPC/
    );

    // Disarm fault injection so any standard OS calls work normally
    simulateFailure = false;

    // Now verify that the storage engine is in a failed state and rejects subsequent writes
    await assert.rejects(
      async () => {
        await storage.commitTransaction({
          commitId: 'commit_after_fail',
          timestamp,
          customers: [
            {
              id: 'cust_after_fail',
              name: 'After Fail Customer',
              status: 'Active',
              owner: 'rep',
              createdAt: timestamp,
              updatedAt: timestamp,
              fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
            },
          ],
        });
      },
      /StorageEngine is in a failed state due to a previous unrecoverable write error/
    );

    // Verify raw file on disk has the partial line at the end
    const rawOnDisk = fs.readFileSync(TEST_JOURNAL_FILE, 'utf-8');
    assert.ok(rawOnDisk.includes('Step 1 Customer'));
    // The partial 15 bytes: '{"type":"ATOMIC'
    assert.ok(rawOnDisk.includes('{"type":"ATOMIC'));

    // Now restart the engine with a fresh instance
    const restartedStorage = new JsonlStorageEngine({ filePath: TEST_JOURNAL_FILE });
    await restartedStorage.init();

    // Record 1 must be intact
    const cust1 = await restartedStorage.getCustomer('cust_step1');
    assert.ok(cust1);
    assert.equal(cust1.name, 'Step 1 Customer');

    // Partial record must NOT be present
    const custFail = await restartedStorage.getCustomer('cust_partial_fail');
    assert.equal(custFail, null);

    // New engine can safely accept new writes
    await restartedStorage.commitTransaction({
      commitId: 'commit_recovered',
      timestamp,
      customers: [
        {
          id: 'cust_recovered',
          name: 'Recovered Customer',
          status: 'Active',
          owner: 'rep',
          createdAt: timestamp,
          updatedAt: timestamp,
          fieldTimestamps: { name: timestamp, status: timestamp, owner: timestamp },
        },
      ],
    });

    const recoveredCust = await restartedStorage.getCustomer('cust_recovered');
    assert.ok(recoveredCust);
    assert.equal(recoveredCust.name, 'Recovered Customer');

    await restartedStorage.close();
  });
});
