import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  Customer,
  Contact,
  AuditLogEntry,
  OutboxJob,
  OutboxJobStatus,
  ProcessedEvent,
  AtomicCommit,
  JournalEntry,
} from '../models/index.js';
import { StorageEngine } from './engine.js';

export interface JsonlStorageOptions {
  filePath: string;
  autoRecoverInFlight?: boolean;
  /** Optional low-level write hook for testing hardware partial-write faults */
  writeSyncFn?: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number) => number;
}

/**
 * File-backed Write-Ahead Log (WAL) storage engine using JSON Lines.
 *
 * Provides:
 * 1. Serialized writes with strict async mutex.
 * 2. Synchronous disk flush (fdatasync) for durable persistence.
 * 3. Crash recovery on restart: rebuilds entities, audit history, dedup, and outbox.
 * 4. Safe recovery from incomplete trailing lines without ignoring mid-file corruption.
 * 5. In-flight job recovery: resets IN_FLIGHT jobs to PENDING on restart.
 *
 * NOTE: This is a prototype substitute for PostgreSQL, implementing the identical
 * StorageEngine contract so sync business logic remains 100% database-agnostic.
 */
export class JsonlStorageEngine implements StorageEngine {
  private readonly filePath: string;
  private readonly autoRecoverInFlight: boolean;
  private fd: number | null = null;
  private writeLock: Promise<void> = Promise.resolve();
  private isFailed: boolean = false;
  private failureReason: Error | null = null;

  // In-memory materialized views rebuilt on replay
  private customers: Map<string, Customer> = new Map();
  private contacts: Map<string, Contact> = new Map();
  private auditLogs: AuditLogEntry[] = [];
  private processedEvents: Set<string> = new Set();
  private outboxJobs: Map<string, OutboxJob> = new Map();

  private readonly writeSyncFn: (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number) => number;

  constructor(options: JsonlStorageOptions) {
    this.filePath = path.resolve(options.filePath);
    this.autoRecoverInFlight = options.autoRecoverInFlight ?? true;
    this.writeSyncFn = options.writeSyncFn ?? fs.writeSync;
  }

  /**
   * Initializes storage, creates directories if needed, and replays journal.
   */
  public async init(): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '', { flag: 'w' });
    }

    this.isFailed = false;
    this.failureReason = null;

    // Replay existing journal
    await this.replayJournal();

    // Open file descriptor for append
    this.fd = fs.openSync(this.filePath, 'a');

    // Ensure file ends with newline before accepting writes, and synchronize to disk
    const currentContent = fs.readFileSync(this.filePath, 'utf-8');
    if (currentContent.length > 0 && !currentContent.endsWith('\n')) {
      fs.writeSync(this.fd, '\n');
      fs.fdatasyncSync(this.fd);
    }
  }

  /**
   * Closes the file descriptor and releases resources.
   */
  public async close(): Promise<void> {
    await this.writeLock;
    if (this.fd !== null) {
      try {
        fs.fdatasyncSync(this.fd);
        fs.closeSync(this.fd);
      } finally {
        this.fd = null;
      }
    }
  }

  // --- Entity Accessors ---

  public async getCustomer(id: string): Promise<Customer | null> {
    const cust = this.customers.get(id);
    return cust ? { ...cust } : null;
  }

  public async getContact(id: string): Promise<Contact | null> {
    const contact = this.contacts.get(id);
    return contact ? { ...contact } : null;
  }

  public async getAllCustomers(): Promise<Customer[]> {
    return Array.from(this.customers.values()).map((c) => ({ ...c }));
  }

  public async getAllContacts(): Promise<Contact[]> {
    return Array.from(this.contacts.values()).map((c) => ({ ...c }));
  }

  // --- Audit History Accessors ---

  public async getAuditLogs(recordId?: string): Promise<AuditLogEntry[]> {
    if (!recordId) {
      return this.auditLogs.map((e) => ({ ...e }));
    }
    return this.auditLogs
      .filter((e) => e.recordId === recordId)
      .map((e) => ({ ...e }));
  }

  // --- Deduplication ---

  public async isEventProcessed(eventId: string): Promise<boolean> {
    return this.processedEvents.has(eventId);
  }

  // --- Outbox Queue Accessors ---

  public async getPendingOutboxJobs(): Promise<OutboxJob[]> {
    return Array.from(this.outboxJobs.values())
      .filter((job) => job.status === 'PENDING')
      .map((job) => ({ ...job }));
  }

  public async getOutboxJob(id: string): Promise<OutboxJob | null> {
    const job = this.outboxJobs.get(id);
    return job ? { ...job } : null;
  }

  // --- State Mutations ---

  public async commitTransaction(commit: AtomicCommit): Promise<void> {
    return this.withWriteLock(async () => {
      const entry: JournalEntry = {
        type: 'ATOMIC_COMMIT',
        commitId: commit.commitId,
        timestamp: commit.timestamp,
        customers: commit.customers,
        contacts: commit.contacts,
        auditEntries: commit.auditEntries,
        processedEvents: commit.processedEvents,
        outboxJobs: commit.outboxJobs,
      };

      this.writeJournalEntry(entry);
      this.applyAtomicCommitToMemory(entry);
    });
  }

  public async updateOutboxJobStatus(
    jobId: string,
    status: OutboxJobStatus,
    meta?: { attempts?: number; lastError?: string | null; nextAttemptAt?: string }
  ): Promise<void> {
    return this.withWriteLock(async () => {
      const job = this.outboxJobs.get(jobId);
      if (!job) {
        throw new Error(`Outbox job not found: ${jobId}`);
      }

      const attempts = meta?.attempts !== undefined ? meta.attempts : job.attempts;
      const entry: JournalEntry = {
        type: 'OUTBOX_STATUS',
        commitId: randomUUID(),
        timestamp: new Date().toISOString(),
        jobId,
        status,
        attempts,
        lastError: meta?.lastError !== undefined ? meta.lastError : job.lastError,
        nextAttemptAt: meta?.nextAttemptAt !== undefined ? meta.nextAttemptAt : job.nextAttemptAt,
      };

      this.writeJournalEntry(entry);
      this.applyOutboxStatusToMemory(entry);
    });
  }

  // --- Internal Serialization & Flush ---

  private async withWriteLock<T>(action: () => Promise<T>): Promise<T> {
    if (this.isFailed) {
      throw new Error(
        `[JsonlStorageEngine] StorageEngine is in a failed state due to a previous unrecoverable write error: ${this.failureReason?.message}. Re-initialization required.`
      );
    }

    const previous = this.writeLock;
    let release: () => void;
    this.writeLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      if (this.isFailed) {
        throw new Error(
          `[JsonlStorageEngine] StorageEngine is in a failed state due to a previous unrecoverable write error: ${this.failureReason?.message}. Re-initialization required.`
        );
      }
      return await action();
    } finally {
      release!();
    }
  }

  private writeJournalEntry(entry: JournalEntry): void {
    if (this.fd === null) {
      throw new Error('StorageEngine is not initialized or has been closed');
    }
    if (this.isFailed) {
      throw new Error(
        `[JsonlStorageEngine] StorageEngine is in a failed state: ${this.failureReason?.message}`
      );
    }

    const line = JSON.stringify(entry) + '\n';
    const buffer = Buffer.from(line, 'utf-8');
    let bytesWritten = 0;
    try {
      while (bytesWritten < buffer.length) {
        const chunkWritten = this.writeSyncFn(
          this.fd,
          buffer,
          bytesWritten,
          buffer.length - bytesWritten
        );
        if (chunkWritten <= 0) {
          throw new Error(`Write failed: fs.writeSync returned ${chunkWritten}`);
        }
        bytesWritten += chunkWritten;
      }
      fs.fdatasyncSync(this.fd);
    } catch (err) {
      // Any write failure (partial write or sync failure) poisons the engine
      // to prevent subsequent writes from corrupting the journal
      this.isFailed = true;
      this.failureReason = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  }

  // --- Memory State Application ---

  private applyAtomicCommitToMemory(entry: Extract<JournalEntry, { type: 'ATOMIC_COMMIT' }>): void {
    if (entry.customers) {
      for (const cust of entry.customers) {
        this.customers.set(cust.id, { ...cust });
      }
    }
    if (entry.contacts) {
      for (const contact of entry.contacts) {
        this.contacts.set(contact.id, { ...contact });
      }
    }
    if (entry.auditEntries) {
      for (const audit of entry.auditEntries) {
        this.auditLogs.push({ ...audit });
      }
    }
    if (entry.processedEvents) {
      for (const evt of entry.processedEvents) {
        this.processedEvents.add(evt.eventId);
      }
    }
    if (entry.outboxJobs) {
      for (const job of entry.outboxJobs) {
        this.outboxJobs.set(job.id, { ...job });
      }
    }
  }

  private applyOutboxStatusToMemory(entry: Extract<JournalEntry, { type: 'OUTBOX_STATUS' }>): void {
    const job = this.outboxJobs.get(entry.jobId);
    if (job) {
      job.status = entry.status;
      job.attempts = entry.attempts;
      job.lastError = entry.lastError ?? null;
      if (entry.nextAttemptAt) {
        job.nextAttemptAt = entry.nextAttemptAt;
      }
      job.updatedAt = entry.timestamp;
    }
  }

  // --- Replay & Crash Recovery ---

  private validateJournalRecord(entry: any): void {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Journal record is not a valid JSON object');
    }
    if (typeof entry.commitId !== 'string' || entry.commitId.trim().length === 0) {
      throw new Error('Missing or invalid required field: commitId');
    }
    if (typeof entry.timestamp !== 'string' || entry.timestamp.trim().length === 0) {
      throw new Error('Missing or invalid required field: timestamp');
    }
    if (entry.type === 'ATOMIC_COMMIT') {
      if (entry.customers !== undefined && !Array.isArray(entry.customers)) {
        throw new Error('Invalid field: customers must be an array');
      }
      if (entry.contacts !== undefined && !Array.isArray(entry.contacts)) {
        throw new Error('Invalid field: contacts must be an array');
      }
      if (entry.auditEntries !== undefined && !Array.isArray(entry.auditEntries)) {
        throw new Error('Invalid field: auditEntries must be an array');
      }
      if (entry.processedEvents !== undefined && !Array.isArray(entry.processedEvents)) {
        throw new Error('Invalid field: processedEvents must be an array');
      }
      if (entry.outboxJobs !== undefined && !Array.isArray(entry.outboxJobs)) {
        throw new Error('Invalid field: outboxJobs must be an array');
      }
      return;
    }
    if (entry.type === 'OUTBOX_STATUS') {
      if (typeof entry.jobId !== 'string' || entry.jobId.trim().length === 0) {
        throw new Error('Missing or invalid required field: jobId in OUTBOX_STATUS');
      }
      const validStatuses: OutboxJobStatus[] = ['PENDING', 'IN_FLIGHT', 'COMPLETED', 'FAILED'];
      if (typeof entry.status !== 'string' || !validStatuses.includes(entry.status as OutboxJobStatus)) {
        throw new Error(`Missing or invalid required field: status '${entry.status}' in OUTBOX_STATUS`);
      }
      if (typeof entry.attempts !== 'number' || Number.isNaN(entry.attempts)) {
        throw new Error('Missing or invalid required field: attempts in OUTBOX_STATUS');
      }
      return;
    }
    throw new Error(`Unknown journal entry type: '${entry.type}'`);
  }

  private async replayJournal(): Promise<void> {
    this.customers.clear();
    this.contacts.clear();
    this.auditLogs = [];
    this.processedEvents.clear();
    this.outboxJobs.clear();

    const raw = fs.readFileSync(this.filePath, 'utf-8');
    if (!raw || raw.trim().length === 0) {
      return;
    }

    // Split raw lines preserving positions
    const rawLines = raw.split(/\r?\n/);
    // Find all non-empty lines with their line numbers
    const linesWithIndex: { line: string; index: number }[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      const trimmed = rawLines[i].trim();
      if (trimmed.length > 0) {
        linesWithIndex.push({ line: trimmed, index: i });
      }
    }

    if (linesWithIndex.length === 0) {
      return;
    }

    const totalLines = linesWithIndex.length;
    let repairedFile = false;
    const validLines: string[] = [];

    for (let i = 0; i < totalLines; i++) {
      const { line, index } = linesWithIndex[i];
      const isFinalLine = i === totalLines - 1;

      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch (jsonErr) {
        if (isFinalLine) {
          // Crash during write: syntactically incomplete trailing line safely repaired
          repairedFile = true;
          // eslint-disable-next-line no-console
          console.warn(
            `[JsonlStorageEngine] Incomplete trailing line detected at line ${index + 1}. Safely truncating partial write.`
          );
          continue;
        } else {
          // Mid-file syntax corruption must NOT be silently ignored
          throw new Error(
            `[JsonlStorageEngine] Fatal journal corruption at line ${index + 1}: unparseable middle-of-file data. Reason: ${
              jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
            }`
          );
        }
      }

      // Valid JSON syntax: now validate schema. Schema errors are FATAL on all lines (including the final line).
      try {
        this.validateJournalRecord(parsed);
      } catch (schemaErr) {
        throw new Error(
          `[JsonlStorageEngine] Fatal journal corruption at line ${index + 1}: invalid journal record schema. Reason: ${
            schemaErr instanceof Error ? schemaErr.message : String(schemaErr)
          }`
        );
      }

      if (parsed.type === 'ATOMIC_COMMIT') {
        this.applyAtomicCommitToMemory(parsed);
      } else if (parsed.type === 'OUTBOX_STATUS') {
        this.applyOutboxStatusToMemory(parsed);
      }
      validLines.push(line);
    }

    // If an incomplete trailing line was detected, rewrite the file with only valid entries
    if (repairedFile) {
      const cleanContent = validLines.length > 0 ? validLines.join('\n') + '\n' : '';
      fs.writeFileSync(this.filePath, cleanContent, 'utf-8');
    }

    // Post-replay: Auto-recover IN_FLIGHT jobs to PENDING
    if (this.autoRecoverInFlight) {
      for (const job of this.outboxJobs.values()) {
        if (job.status === 'IN_FLIGHT') {
          job.status = 'PENDING';
        }
      }
    }
  }
}
