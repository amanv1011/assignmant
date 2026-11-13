/**
 * Domain entity models and storage types for Salesforce <-> Postgres sync.
 * Aligned with assignment requirements and field-level LWW conflict resolution.
 */

export type ObjectType = 'Customer' | 'Contact';

/**
 * Customer entity.
 * Allowed business fields: name, status, owner.
 */
export interface Customer {
  id: string; // Internal/Salesforce identifier
  name: string;
  status: string;
  owner: string;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  /** Field-level timestamps for LWW conflict resolution */
  fieldTimestamps: {
    name: string;
    status: string;
    owner: string;
    [key: string]: string;
  };
}

/**
 * Contact entity.
 * Allowed business fields: fullName, phone, email, city, owner, and customer (customerId).
 */
export interface Contact {
  id: string; // Internal/Salesforce identifier
  customerId: string; // The customer they belong to
  fullName: string;
  phone: string;
  email: string;
  city: string;
  owner: string;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  /** Field-level timestamps for LWW conflict resolution */
  fieldTimestamps: {
    fullName: string;
    phone: string;
    email: string;
    city: string;
    owner: string;
    customerId: string;
    [key: string]: string;
  };
}

export type EventSource = 'SALESFORCE_WEBHOOK' | 'PORTAL';

/**
 * Immutable audit log entry preserving every observed change.
 * Satisfies the requirement: dropping history counts as data loss.
 */
export interface AuditLogEntry {
  id: string; // Unique audit entry ID (UUID)
  recordId: string;
  objectType: ObjectType;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  changedBy: string; // User email or system identifier
  eventTimestamp: string; // occurredAt or server-committed UTC
  receivedAt: string; // Local ingestion time in ISO 8601 UTC
  eventSource: EventSource;
  eventId: string; // Salesforce eventId or Portal mutation UUID
  appliedToCurrent: boolean; // True if applied to current state; false if stale/superseded
}

export type OutboxJobStatus = 'PENDING' | 'IN_FLIGHT' | 'COMPLETED' | 'FAILED';
export type OutboxOperation = 'CREATE' | 'UPDATE';

/**
 * Outbox queue job for reliable outbound dispatch to Salesforce.
 */
export interface OutboxJob {
  id: string; // UUID
  recordId: string;
  objectType: ObjectType;
  operation: OutboxOperation;
  payload: Record<string, any>; // Changed fields or full record
  status: OutboxJobStatus;
  attempts: number;
  maxAttempts: number;
  correlationId: string; // Used to identify echoes on webhook return
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  nextAttemptAt: string; // ISO 8601 UTC (for retry backoff)
  lastError: string | null;
}

/**
 * Inbound deduplication tracking for at-least-once delivery.
 */
export interface ProcessedEvent {
  eventId: string;
  recordId: string;
  objectType: ObjectType;
  processedAt: string; // ISO 8601 UTC
  source: EventSource;
}

/**
 * Atomic commit unit representing a single logical state transition.
 */
export interface AtomicCommit {
  commitId: string;
  timestamp: string; // ISO 8601 UTC
  customers?: Customer[];
  contacts?: Contact[];
  auditEntries?: AuditLogEntry[];
  processedEvents?: ProcessedEvent[];
  outboxJobs?: OutboxJob[];
}

/**
 * Journal entry stored in the JSONL write-ahead log.
 */
export type JournalEntry =
  | {
      type: 'ATOMIC_COMMIT';
      commitId: string;
      timestamp: string;
      customers?: Customer[];
      contacts?: Contact[];
      auditEntries?: AuditLogEntry[];
      processedEvents?: ProcessedEvent[];
      outboxJobs?: OutboxJob[];
    }
  | {
      type: 'OUTBOX_STATUS';
      commitId: string;
      timestamp: string;
      jobId: string;
      status: OutboxJobStatus;
      attempts: number;
      lastError?: string | null;
      nextAttemptAt?: string;
    };
