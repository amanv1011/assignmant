import { StorageEngine } from '../storage/index.js';
import { OutboxJob } from '../models/index.js';
import { MockSalesforceApi } from '../mock-salesforce/mock-salesforce-api.js';
import { WebhookHandler } from '../webhook/webhook-handler.js';
import { RateLimiter } from './rate-limiter.js';

export interface OutboxDispatcherOptions {
  pollIntervalMs?: number;
  baseRetryDelayMs?: number;
  integrationUserEmail?: string;
}

/**
 * Outbox Dispatcher Worker.
 *
 * Implements:
 * 1. Safe queue consumption with IN_FLIGHT state marking prior to network dispatch.
 * 2. Shared Token-Bucket rate limiting governing all requests and retries.
 * 3. Exponential backoff retry handling with configurable max attempts.
 * 4. Echo correlation registration to break sync loops on webhook return.
 * 5. Outage survival and resume capabilities after restart.
 */
export class OutboxDispatcher {
  private readonly storage: StorageEngine;
  private readonly salesforceApi: MockSalesforceApi;
  private readonly rateLimiter: RateLimiter;
  private readonly webhookHandler?: WebhookHandler;
  private readonly baseRetryDelayMs: number;
  private readonly integrationUserEmail: string;

  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlightJobIds: Set<string> = new Set();

  public dispatchedCount: number = 0;
  public successCount: number = 0;
  public failureCount: number = 0;
  public retryCount: number = 0;

  constructor(
    storage: StorageEngine,
    salesforceApi: MockSalesforceApi,
    rateLimiter: RateLimiter,
    webhookHandler?: WebhookHandler,
    options: OutboxDispatcherOptions = {}
  ) {
    this.storage = storage;
    this.salesforceApi = salesforceApi;
    this.rateLimiter = rateLimiter;
    this.webhookHandler = webhookHandler;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 100;
    this.integrationUserEmail = options.integrationUserEmail ?? 'integration-portal@client.example';
  }

  /**
   * Starts background polling loop.
   */
  public start(pollIntervalMs: number = 200): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const tick = async () => {
      if (!this.isRunning) return;
      try {
        await this.drainQueueOnce();
      } catch {
        // Suppress top-level tick errors
      } finally {
        if (this.isRunning) {
          this.timer = setTimeout(tick, pollIntervalMs);
          if (this.timer && typeof this.timer.unref === 'function') {
            this.timer.unref();
          }
        }
      }
    };

    this.timer = setTimeout(tick, 0);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stops background polling loop.
   */
  public stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Processes all currently due pending outbox jobs once.
   */
  public async drainQueueOnce(maxBatchSize: number = 100): Promise<number> {
    const pendingJobs = await this.storage.getPendingOutboxJobs();
    const now = new Date().getTime();

    // Filter jobs that are ready for attempt (now >= nextAttemptAt) and not currently being dispatched in-memory
    const readyJobs = pendingJobs
      .filter((j) => !this.inFlightJobIds.has(j.id))
      .filter((j) => new Date(j.nextAttemptAt).getTime() <= now)
      .slice(0, maxBatchSize);

    let processedCount = 0;

    for (const job of readyJobs) {
      this.inFlightJobIds.add(job.id);
      try {
        await this.dispatchJob(job);
        processedCount++;
      } finally {
        this.inFlightJobIds.delete(job.id);
      }
    }

    return processedCount;
  }

  /**
   * Dispatches a single outbox job through the rate limiter to Salesforce.
   */
  private async dispatchJob(job: OutboxJob): Promise<void> {
    this.dispatchedCount++;

    // 1. Mark as IN_FLIGHT in durable storage before making API call
    const nextAttempt = job.attempts + 1;
    await this.storage.updateOutboxJobStatus(job.id, 'IN_FLIGHT', { attempts: nextAttempt });

    // 2. Register correlation with webhook handler so echoes are suppressed
    if (this.webhookHandler) {
      this.webhookHandler.registerOutboundCorrelation(job.correlationId, job.recordId, job.payload);
    }

    // 3. Acquire token from shared rate limiter (enforces <= 100 req/s cap)
    await this.rateLimiter.acquireToken();

    // 4. Execute official Salesforce record API operation
    try {
      if (job.operation === 'CREATE') {
        await this.salesforceApi.createRecord(job.objectType, { ...job.payload, id: job.recordId }, {
          changedBy: this.integrationUserEmail,
          correlationId: job.correlationId,
          emitWebhook: true,
        });
      } else {
        await this.salesforceApi.updateRecord(job.objectType, job.recordId, job.payload, {
          changedBy: this.integrationUserEmail,
          correlationId: job.correlationId,
          emitWebhook: true,
        });
      }

      // 5. Mark as COMPLETED upon success
      await this.storage.updateOutboxJobStatus(job.id, 'COMPLETED');
      this.successCount++;
    } catch (err: any) {
      this.failureCount++;

      // Check if Salesforce signaled 429 backpressure
      if (err.status === 429) {
        const pauseMs = err.retryAfterMs || 1000;
        this.rateLimiter.pause(pauseMs);
      }

      // Check if retry limit reached
      if (nextAttempt >= job.maxAttempts) {
        await this.storage.updateOutboxJobStatus(job.id, 'FAILED', {
          lastError: err.message,
        });
      } else {
        // Calculate exponential backoff: base * 2^(attempts-1)
        this.retryCount++;
        const backoffMs = this.baseRetryDelayMs * Math.pow(2, nextAttempt - 1);
        const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

        await this.storage.updateOutboxJobStatus(job.id, 'PENDING', {
          attempts: nextAttempt,
          lastError: err.message,
          nextAttemptAt,
        });
      }
    }
  }
}
