import {
  Customer,
  Contact,
  AuditLogEntry,
  OutboxJob,
  OutboxJobStatus,
  AtomicCommit,
} from '../models/index.js';

/**
 * StorageEngine defines the storage abstraction boundary.
 * Allows switching between file-backed JSONL journal (prototype)
 * and PostgreSQL (production) without modifying sync business logic.
 */
export interface StorageEngine {
  /**
   * Initialize storage and replay journal / connect database.
   */
  init(): Promise<void>;

  /**
   * Close connections, flush pending writes, and release resources.
   */
  close(): Promise<void>;

  // Entity queries
  getCustomer(id: string): Promise<Customer | null>;
  getContact(id: string): Promise<Contact | null>;
  getAllCustomers(): Promise<Customer[]>;
  getAllContacts(): Promise<Contact[]>;

  // Audit history queries
  getAuditLogs(recordId?: string): Promise<AuditLogEntry[]>;

  // Inbound deduplication queries
  isEventProcessed(eventId: string): Promise<boolean>;

  // Outbox queue queries and updates
  getPendingOutboxJobs(): Promise<OutboxJob[]>;
  getOutboxJob(id: string): Promise<OutboxJob | null>;
  updateOutboxJobStatus(
    jobId: string,
    status: OutboxJobStatus,
    meta?: { attempts?: number; lastError?: string | null; nextAttemptAt?: string }
  ): Promise<void>;

  // Atomic state commit
  commitTransaction(commit: AtomicCommit): Promise<void>;
}
