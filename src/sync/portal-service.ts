import { randomUUID } from 'node:crypto';
import { StorageEngine } from '../storage/index.js';
import {
  Customer,
  Contact,
  OutboxJob,
  AtomicCommit,
  PortalEditPayload,
} from '../models/index.js';
import { ConflictResolver } from './conflict-resolver.js';

export interface PortalMutationResult {
  record: Customer | Contact;
  outboxJob: OutboxJob;
  commitId: string;
}

/**
 * Handles Portal-originated mutations (Finance and Customer-Success edits/creates).
 * Uses authoritative server-generated UTC timestamps and commits state,
 * audit entries, and outbound outbox jobs atomically.
 */
export class PortalService {
  private readonly storage: StorageEngine;
  private readonly conflictResolver: ConflictResolver;

  constructor(storage: StorageEngine, conflictResolver: ConflictResolver) {
    this.storage = storage;
    this.conflictResolver = conflictResolver;
  }

  /**
   * Applies an edit to a Customer from the Portal.
   */
  public async editCustomer(payload: PortalEditPayload): Promise<PortalMutationResult> {
    const serverTimestamp = new Date().toISOString();
    const mutationId = `portal_mut_${randomUUID()}`;
    const correlationId = `corr_${randomUUID()}`;

    const existing = await this.storage.getCustomer(payload.recordId);
    const { customer, auditEntries } = this.conflictResolver.resolveCustomer(existing, {
      id: payload.recordId,
      changedFields: payload.changedFields,
      changedBy: payload.editedBy,
      eventTimestamp: serverTimestamp,
      source: 'PORTAL',
      eventId: mutationId,
      receivedAt: serverTimestamp,
    });

    const isCreate = !existing;
    const outboxJob: OutboxJob = {
      id: randomUUID(),
      recordId: payload.recordId,
      objectType: 'Customer',
      operation: isCreate ? 'CREATE' : 'UPDATE',
      payload: { ...payload.changedFields },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      correlationId,
      createdAt: serverTimestamp,
      updatedAt: serverTimestamp,
      nextAttemptAt: serverTimestamp,
      lastError: null,
    };

    const commit: AtomicCommit = {
      commitId: randomUUID(),
      timestamp: serverTimestamp,
      customers: [customer],
      auditEntries,
      processedEvents: [
        {
          eventId: mutationId,
          recordId: payload.recordId,
          objectType: 'Customer',
          processedAt: serverTimestamp,
          source: 'PORTAL',
        },
      ],
      outboxJobs: [outboxJob],
    };

    await this.storage.commitTransaction(commit);
    return { record: customer, outboxJob, commitId: commit.commitId };
  }

  /**
   * Applies an edit to a Contact from the Portal.
   */
  public async editContact(payload: PortalEditPayload): Promise<PortalMutationResult> {
    const serverTimestamp = new Date().toISOString();
    const mutationId = `portal_mut_${randomUUID()}`;
    const correlationId = `corr_${randomUUID()}`;

    const existing = await this.storage.getContact(payload.recordId);
    const { contact, auditEntries } = this.conflictResolver.resolveContact(existing, {
      id: payload.recordId,
      changedFields: payload.changedFields,
      changedBy: payload.editedBy,
      eventTimestamp: serverTimestamp,
      source: 'PORTAL',
      eventId: mutationId,
      receivedAt: serverTimestamp,
    });

    const isCreate = !existing;
    const outboxJob: OutboxJob = {
      id: randomUUID(),
      recordId: payload.recordId,
      objectType: 'Contact',
      operation: isCreate ? 'CREATE' : 'UPDATE',
      payload: { ...payload.changedFields },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      correlationId,
      createdAt: serverTimestamp,
      updatedAt: serverTimestamp,
      nextAttemptAt: serverTimestamp,
      lastError: null,
    };

    const commit: AtomicCommit = {
      commitId: randomUUID(),
      timestamp: serverTimestamp,
      contacts: [contact],
      auditEntries,
      processedEvents: [
        {
          eventId: mutationId,
          recordId: payload.recordId,
          objectType: 'Contact',
          processedAt: serverTimestamp,
          source: 'PORTAL',
        },
      ],
      outboxJobs: [outboxJob],
    };

    await this.storage.commitTransaction(commit);
    return { record: contact, outboxJob, commitId: commit.commitId };
  }
}
