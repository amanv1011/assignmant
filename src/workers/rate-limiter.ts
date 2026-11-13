/**
 * Token Bucket Rate Limiter.
 *
 * Enforces a strict ceiling on outbound requests to the Salesforce API,
 * governing both initial dispatch attempts and retries.
 */
export interface RateLimiterOptions {
  /** Maximum allowed requests per second (assignment hard cap is 100) */
  maxRequestsPerSecond?: number;
  /** Initial token bucket capacity (burst limit) */
  bucketCapacity?: number;
  /** Initial token count in bucket (defaults to bucketCapacity) */
  initialTokens?: number;
}

export class RateLimiter {
  private readonly maxRate: number;
  private readonly capacity: number;
  private tokens: number;
  private lastRefillTimestamp: number;
  private pauseUntilTimestamp: number = 0;

  constructor(options: RateLimiterOptions = {}) {
    this.maxRate = options.maxRequestsPerSecond ?? 80;
    this.capacity = options.bucketCapacity ?? this.maxRate;
    this.tokens = options.initialTokens !== undefined ? options.initialTokens : this.capacity;
    this.lastRefillTimestamp = Date.now();
  }

  /**
   * Acquires a token, waiting asynchronously if tokens are depleted or if rate limiter is paused.
   */
  public async acquireToken(): Promise<void> {
    while (true) {
      const now = Date.now();

      // Check if paused due to 429 backpressure
      if (now < this.pauseUntilTimestamp) {
        const waitMs = this.pauseUntilTimestamp - now;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      this.refillTokens(now);

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      // Calculate time required to generate at least 1 token
      const msPerToken = 1000 / this.maxRate;
      const waitTime = Math.max(10, Math.ceil(msPerToken));
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Pauses token consumption for a specified duration (e.g. on HTTP 429).
   */
  public pause(durationMs: number): void {
    const now = Date.now();
    this.pauseUntilTimestamp = Math.max(this.pauseUntilTimestamp, now + durationMs);
  }

  public getAvailableTokens(): number {
    this.refillTokens(Date.now());
    return this.tokens;
  }

  private refillTokens(now: number): void {
    const elapsedSeconds = (now - this.lastRefillTimestamp) / 1000;
    if (elapsedSeconds > 0) {
      const tokensToAdd = elapsedSeconds * this.maxRate;
      this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
      this.lastRefillTimestamp = now;
    }
  }
}
