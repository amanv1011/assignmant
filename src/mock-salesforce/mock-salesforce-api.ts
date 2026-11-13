import { randomUUID } from 'node:crypto';
import { ObjectType, SalesforceWebhookPayload } from '../models/index.js';

export interface SalesforceRecordOptions {
  changedBy?: string;
  correlationId?: string;
  emitWebhook?: boolean;
}

export interface MockSalesforceConfig {
  maxRequestsPerSecond?: number;
  simulatedLatencyMs?: number;
  initialOnline?: boolean;
  onWebhook?: (payload: SalesforceWebhookPayload) => Promise<void> | void;
}

/**
 * Mock Salesforce CRM REST API.
 *
 * Implements:
 * 1. Standard CRUD operations for Customer and Contact records.
 * 2. Toggleable online/offline outage state.
 * 3. Rate-limit enforcement (HTTP 429 simulation).
 * 4. Automatic or manual webhook generation.
 */
export class MockSalesforceApi {
  private online: boolean;
  private readonly maxRequestsPerSecond: number;
  private readonly simulatedLatencyMs: number;
  private onWebhook?: (payload: SalesforceWebhookPayload) => Promise<void> | void;

  // In-memory CRM database
  private customers: Map<string, Record<string, any>> = new Map();
  private contacts: Map<string, Record<string, any>> = new Map();

  // Rate limiting tracker
  private requestTimestamps: number[] = [];

  // Metrics
  public totalCallsReceived: number = 0;
  public totalSuccessfulCalls: number = 0;
  public totalFailedCalls: number = 0;
  public total429sReturned: number = 0;

  constructor(config: MockSalesforceConfig = {}) {
    this.online = config.initialOnline ?? true;
    this.maxRequestsPerSecond = config.maxRequestsPerSecond ?? 100;
    this.simulatedLatencyMs = config.simulatedLatencyMs ?? 0;
    this.onWebhook = config.onWebhook;
  }

  public setOnline(isOnline: boolean): void {
    this.online = isOnline;
  }

  public isOnline(): boolean {
    return this.online;
  }

  public setWebhookCallback(cb: (payload: SalesforceWebhookPayload) => Promise<void> | void): void {
    this.onWebhook = cb;
  }

  /**
   * Simulates calling official Salesforce REST API to create a record.
   */
  public async createRecord(
    objectType: ObjectType,
    data: Record<string, any>,
    options: SalesforceRecordOptions = {}
  ): Promise<{ id: string; success: boolean }> {
    await this.simulateNetworkAndLimits();

    const recordId = data.id || (objectType === 'Contact' ? `003${randomUUID().replace(/-/g, '').slice(0, 15)}` : `001${randomUUID().replace(/-/g, '').slice(0, 15)}`);
    const record = { ...data, id: recordId, lastModifiedDate: new Date().toISOString() };

    if (objectType === 'Customer') {
      this.customers.set(recordId, record);
    } else {
      this.contacts.set(recordId, record);
    }

    this.totalSuccessfulCalls++;

    if (options.emitWebhook !== false && this.onWebhook) {
      const webhookPayload: SalesforceWebhookPayload = {
        eventId: `evt_${randomUUID()}`,
        recordId,
        objectType,
        occurredAt: record.lastModifiedDate,
        changedBy: options.changedBy ?? 'sales.user@client.example',
        changedFields: { ...data },
        correlationId: options.correlationId,
      };
      // Asynchronously trigger webhook
      setImmediate(() => {
        if (this.onWebhook) {
          Promise.resolve(this.onWebhook(webhookPayload)).catch(() => {});
        }
      });
    }

    return { id: recordId, success: true };
  }

  /**
   * Simulates calling official Salesforce REST API to update a record (PATCH).
   */
  public async updateRecord(
    objectType: ObjectType,
    id: string,
    data: Record<string, any>,
    options: SalesforceRecordOptions = {}
  ): Promise<{ success: boolean }> {
    await this.simulateNetworkAndLimits();

    const store = objectType === 'Customer' ? this.customers : this.contacts;
    const existing = store.get(id) || { id };
    const updated = { ...existing, ...data, lastModifiedDate: new Date().toISOString() };
    store.set(id, updated);

    this.totalSuccessfulCalls++;

    if (options.emitWebhook !== false && this.onWebhook) {
      const webhookPayload: SalesforceWebhookPayload = {
        eventId: `evt_${randomUUID()}`,
        recordId: id,
        objectType,
        occurredAt: updated.lastModifiedDate,
        changedBy: options.changedBy ?? 'sales.user@client.example',
        changedFields: { ...data },
        correlationId: options.correlationId,
      };
      setImmediate(() => {
        if (this.onWebhook) {
          Promise.resolve(this.onWebhook(webhookPayload)).catch(() => {});
        }
      });
    }

    return { success: true };
  }

  public async getRecord(objectType: ObjectType, id: string): Promise<Record<string, any> | null> {
    const store = objectType === 'Customer' ? this.customers : this.contacts;
    const rec = store.get(id);
    return rec ? { ...rec } : null;
  }

  /**
   * Simulates a Sales user directly making an edit inside Salesforce CRM.
   */
  public directSalesforceUserEdit(
    objectType: ObjectType,
    recordId: string,
    changedFields: Record<string, any>,
    salesUserEmail: string = 'sales.user@client.example'
  ): SalesforceWebhookPayload {
    const store = objectType === 'Customer' ? this.customers : this.contacts;
    const existing = store.get(recordId) || { id: recordId };
    const occurredAt = new Date().toISOString();
    store.set(recordId, { ...existing, ...changedFields, lastModifiedDate: occurredAt });

    const webhookPayload: SalesforceWebhookPayload = {
      eventId: `evt_${randomUUID()}`,
      recordId,
      objectType,
      occurredAt,
      changedBy: salesUserEmail,
      changedFields,
    };

    if (this.onWebhook) {
      setImmediate(() => {
        if (this.onWebhook) {
          Promise.resolve(this.onWebhook(webhookPayload)).catch(() => {});
        }
      });
    }

    return webhookPayload;
  }

  private async simulateNetworkAndLimits(): Promise<void> {
    this.totalCallsReceived++;

    if (!this.online) {
      this.totalFailedCalls++;
      const err: any = new Error('ETIMEDOUT: Salesforce CRM API is unreachable (simulated outage)');
      err.code = 'ETIMEDOUT';
      err.status = 503;
      throw err;
    }

    // Rate limiter check (sliding window 1 second)
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter((t) => now - t < 1000);
    if (this.requestTimestamps.length >= this.maxRequestsPerSecond) {
      this.totalFailedCalls++;
      this.total429sReturned++;
      const err: any = new Error('HTTP 429: Too Many Requests (Rate limit exceeded)');
      err.status = 429;
      err.retryAfterMs = 1000;
      throw err;
    }
    this.requestTimestamps.push(now);

    if (this.simulatedLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedLatencyMs));
    }
  }
}
