import { StorageEngine, JsonlStorageEngine } from './storage/index.js';
import { ConflictResolver } from './sync/conflict-resolver.js';
import { PortalService } from './sync/portal-service.js';
import { WebhookHandler } from './webhook/webhook-handler.js';
import { MockSalesforceApi } from './mock-salesforce/mock-salesforce-api.js';
import { RateLimiter } from './workers/rate-limiter.js';
import { OutboxDispatcher } from './workers/outbox-dispatcher.js';
import { SalesforceWebhookPayload, PortalEditPayload } from './models/index.js';

export interface SyncServiceOptions {
  storageFilePath?: string;
  maxRequestsPerSecond?: number;
  integrationUserEmail?: string;
  baseRetryDelayMs?: number;
  autoStartDispatcher?: boolean;
}

/**
 * Unified Two-Way Sync Service Orchestrator.
 * Connects the StorageEngine, Inbound Webhook Pipeline, Portal Mutation Service,
 * Mock Salesforce CRM API, and the Rate-Limited Outbox Dispatcher.
 */
export class SyncService {
  public readonly storage: StorageEngine;
  public readonly conflictResolver: ConflictResolver;
  public readonly webhookHandler: WebhookHandler;
  public readonly portalService: PortalService;
  public readonly salesforceApi: MockSalesforceApi;
  public readonly rateLimiter: RateLimiter;
  public readonly outboxDispatcher: OutboxDispatcher;
  private readonly autoStartDispatcher: boolean;

  constructor(options: SyncServiceOptions = {}) {
    const storageFilePath = options.storageFilePath ?? './data/sync_journal.jsonl';
    const maxRate = options.maxRequestsPerSecond ?? 80;
    const integrationUserEmail = options.integrationUserEmail ?? 'integration-portal@client.example';
    this.autoStartDispatcher = options.autoStartDispatcher ?? true;

    this.storage = new JsonlStorageEngine({ filePath: storageFilePath });
    this.conflictResolver = new ConflictResolver();
    this.webhookHandler = new WebhookHandler(this.storage, this.conflictResolver, {
      integrationUserEmail,
    });
    this.portalService = new PortalService(this.storage, this.conflictResolver);
    this.rateLimiter = new RateLimiter({ maxRequestsPerSecond: maxRate });

    this.salesforceApi = new MockSalesforceApi({
      maxRequestsPerSecond: 100, // Hard ceiling from assignment
      onWebhook: async (payload: SalesforceWebhookPayload) => {
        await this.webhookHandler.handleWebhook(payload);
      },
    });

    this.outboxDispatcher = new OutboxDispatcher(
      this.storage,
      this.salesforceApi,
      this.rateLimiter,
      this.webhookHandler,
      {
        baseRetryDelayMs: options.baseRetryDelayMs ?? 50,
        integrationUserEmail,
      }
    );
  }

  public async start(): Promise<void> {
    await this.storage.init();
    if (this.autoStartDispatcher) {
      this.outboxDispatcher.start(50);
    }
  }

  public async stop(): Promise<void> {
    this.outboxDispatcher.stop();
    await this.storage.close();
  }

  public async handleInboundWebhook(payload: SalesforceWebhookPayload) {
    return this.webhookHandler.handleWebhook(payload);
  }

  public async handlePortalEdit(payload: PortalEditPayload) {
    if (payload.objectType === 'Customer') {
      return this.portalService.editCustomer(payload);
    } else {
      return this.portalService.editContact(payload);
    }
  }

  public async drainOutbox(): Promise<number> {
    return this.outboxDispatcher.drainQueueOnce();
  }
}
