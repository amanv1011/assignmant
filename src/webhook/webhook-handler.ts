import { randomUUID } from 'node:crypto';
import { StorageEngine } from '../storage/index.js';
import {
  Customer,
  Contact,
  AtomicCommit,
  SalesforceWebhookPayload,
} from '../models/index.js';
import { ConflictResolver } from '../sync/conflict-resolver.js';

export interface WebhookProcessingResult {
  status: 'PROCESSED' | 'DUPLICATE' | 'ECHO_SUPPRESSED';
  eventId: string;
  recordId: string;
  applied: boolean;
  ignored: boolean;
  commitId?: string;
  message?: string;
}

export interface WebhookHandlerOptions {
  /** Integration user email used by the portal when calling Salesforce API */
  integrationUserEmail?: string;
}

/**
 * Inbound Salesforce Webhook Handler.
 *
 * Implements:
 * 1. Payload validation.
 * 2. Idempotent deduplication on eventId.
 * 3. Echo-loop prevention (suppresses outbound sync when changes originated from portal).
 * 4. Deterministic field-level out-of-order conflict resolution.
 * 5. Atomic persistence of state, audit trail, and deduplication records.
 */
export class WebhookHandler {
  private readonly storage: StorageEngine;
  private readonly conflictResolver: ConflictResolver;
  private readonly integrationUserEmail: string;

  // Active correlation registry for echo suppression
  private activeCorrelationIds: Set<string> = new Set();
  // Fallback in-flight echo cache: key = `${recordId}:${fieldName}:${valueString}` -> expiresAt
  private inFlightEchoCache: Map<string, number> = new Map();

  constructor(
    storage: StorageEngine,
    conflictResolver: ConflictResolver,
    options: WebhookHandlerOptions = {}
  ) {
    this.storage = storage;
    this.conflictResolver = conflictResolver;
    this.integrationUserEmail = options.integrationUserEmail ?? 'integration-portal@client.example';
  }

  /**
   * Registers a correlation ID from an outbound job so returning webhooks are recognized as echoes.
   */
  public registerOutboundCorrelation(correlationId: string, recordId?: string, changedFields?: Record<string, any>): void {
    if (correlationId) {
      this.activeCorrelationIds.add(correlationId);
    }
    // Also populate fallback cache
    if (recordId && changedFields) {
      const now = Date.now();
      const expiresAt = now + 5 * 60 * 1000; // 5 minute TTL
      for (const [field, val] of Object.entries(changedFields)) {
        const key = `${recordId}:${field}:${String(val)}`;
        this.inFlightEchoCache.set(key, expiresAt);
      }
    }
  }

  /**
   * Processes an incoming Salesforce webhook payload.
   */
  public async handleWebhook(payload: SalesforceWebhookPayload): Promise<WebhookProcessingResult> {
    this.validatePayload(payload);

    const receivedAt = new Date().toISOString();

    // 1. Idempotency Check: deduplicate on stable eventId
    const alreadyProcessed = await this.storage.isEventProcessed(payload.eventId);
    if (alreadyProcessed) {
      return {
        status: 'DUPLICATE',
        eventId: payload.eventId,
        recordId: payload.recordId,
        applied: false,
        ignored: true,
        message: `Event ${payload.eventId} has already been processed. Safely ignored.`,
      };
    }

    // 2. Loop Prevention: check if this is an echo of a Portal outbound update
    const isEcho = this.detectEcho(payload);

    if (payload.objectType === 'Customer') {
      return this.processCustomerWebhook(payload, receivedAt, isEcho);
    } else if (payload.objectType === 'Contact') {
      return this.processContactWebhook(payload, receivedAt, isEcho);
    } else {
      throw new Error(`Unsupported objectType in webhook: ${(payload as any).objectType}`);
    }
  }

  private detectEcho(payload: SalesforceWebhookPayload): boolean {
    // Tier 1: Authoritative correlation ID match
    if (payload.correlationId && this.activeCorrelationIds.has(payload.correlationId)) {
      this.activeCorrelationIds.delete(payload.correlationId);
      return true;
    }

    // Tier 1b: Integration user match
    if (payload.changedBy && payload.changedBy.toLowerCase() === this.integrationUserEmail.toLowerCase()) {
      return true;
    }

    // Tier 2: Fallback in-flight echo cache heuristic
    const now = Date.now();
    let hasFallbackMatch = false;
    for (const [field, val] of Object.entries(payload.changedFields)) {
      const key = `${payload.recordId}:${field}:${String(val)}`;
      const expiresAt = this.inFlightEchoCache.get(key);
      if (expiresAt && expiresAt > now) {
        hasFallbackMatch = true;
        this.inFlightEchoCache.delete(key);
      }
    }

    return hasFallbackMatch;
  }

  private async processCustomerWebhook(
    payload: SalesforceWebhookPayload,
    receivedAt: string,
    isEcho: boolean
  ): Promise<WebhookProcessingResult> {
    const existing = await this.storage.getCustomer(payload.recordId);

    const { customer, auditEntries, hasChanges } = this.conflictResolver.resolveCustomer(existing, {
      id: payload.recordId,
      changedFields: payload.changedFields,
      changedBy: payload.changedBy,
      eventTimestamp: payload.occurredAt,
      source: 'SALESFORCE_WEBHOOK',
      eventId: payload.eventId,
      receivedAt,
    });

    const commit: AtomicCommit = {
      commitId: randomUUID(),
      timestamp: receivedAt,
      customers: hasChanges ? [customer] : undefined,
      auditEntries,
      processedEvents: [
        {
          eventId: payload.eventId,
          recordId: payload.recordId,
          objectType: 'Customer',
          processedAt: receivedAt,
          source: 'SALESFORCE_WEBHOOK',
        },
      ],
      // CRITICAL: We NEVER enqueue an outbound job for webhook ingress!
      // This guarantees zero sync loops.
    };

    await this.storage.commitTransaction(commit);

    return {
      status: isEcho ? 'ECHO_SUPPRESSED' : 'PROCESSED',
      eventId: payload.eventId,
      recordId: payload.recordId,
      applied: hasChanges,
      ignored: false,
      commitId: commit.commitId,
      message: isEcho ? 'Change matched portal outbound origin; echo loop suppressed.' : 'Processed webhook.',
    };
  }

  private async processContactWebhook(
    payload: SalesforceWebhookPayload,
    receivedAt: string,
    isEcho: boolean
  ): Promise<WebhookProcessingResult> {
    const existing = await this.storage.getContact(payload.recordId);

    const { contact, auditEntries, hasChanges } = this.conflictResolver.resolveContact(existing, {
      id: payload.recordId,
      changedFields: payload.changedFields,
      changedBy: payload.changedBy,
      eventTimestamp: payload.occurredAt,
      source: 'SALESFORCE_WEBHOOK',
      eventId: payload.eventId,
      receivedAt,
    });

    const commit: AtomicCommit = {
      commitId: randomUUID(),
      timestamp: receivedAt,
      contacts: hasChanges ? [contact] : undefined,
      auditEntries,
      processedEvents: [
        {
          eventId: payload.eventId,
          recordId: payload.recordId,
          objectType: 'Contact',
          processedAt: receivedAt,
          source: 'SALESFORCE_WEBHOOK',
        },
      ],
      // CRITICAL: We NEVER enqueue an outbound job for webhook ingress!
    };

    await this.storage.commitTransaction(commit);

    return {
      status: isEcho ? 'ECHO_SUPPRESSED' : 'PROCESSED',
      eventId: payload.eventId,
      recordId: payload.recordId,
      applied: hasChanges,
      ignored: false,
      commitId: commit.commitId,
      message: isEcho ? 'Change matched portal outbound origin; echo loop suppressed.' : 'Processed webhook.',
    };
  }

  private validatePayload(payload: SalesforceWebhookPayload): void {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Webhook payload must be a non-null object');
    }
    if (!payload.eventId || typeof payload.eventId !== 'string') {
      throw new Error('Missing or invalid required field: eventId');
    }
    if (!payload.recordId || typeof payload.recordId !== 'string') {
      throw new Error('Missing or invalid required field: recordId');
    }
    if (payload.objectType !== 'Customer' && payload.objectType !== 'Contact') {
      throw new Error(`Invalid objectType: ${payload.objectType}`);
    }
    if (!payload.occurredAt || Number.isNaN(new Date(payload.occurredAt).getTime())) {
      throw new Error(`Invalid occurredAt timestamp: ${payload.occurredAt}`);
    }
    if (!payload.changedBy || typeof payload.changedBy !== 'string') {
      throw new Error('Missing or invalid required field: changedBy');
    }
    if (!payload.changedFields || typeof payload.changedFields !== 'object') {
      throw new Error('Missing or invalid required field: changedFields');
    }
  }
}
