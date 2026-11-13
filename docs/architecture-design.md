# Architecture & System Design Document: Salesforce ↔ PostgreSQL Two-Way Sync

---

## 1. Assumptions and Open Questions

### Assumptions (Locked for Design)
1. **Traffic & Influx Rates:** Peak Portal edit rate is assumed at **20 edits/second**; quiet-hour edit rate is assumed at **2 edits/second**. Salesforce outbound processing runs at a target rate of **80 requests/second** to leave a 20% safety buffer below the hard CRM ceiling of 100 req/s.
2. **Webhook Payloads:** Webhooks carry delta updates (`changedFields`). If full record snapshots arrive, our ingestion layer diffs against known state to isolate changed fields.
3. **authoritative Timestamps:** Salesforce assigns `occurredAt` (UTC). The Portal backend assigns `server_committed_at` (UTC) upon database transaction commit. Client-side wall clocks are never trusted.
4. **Outage Recovery Bounds:** Salesforce API can experience a continuous 6-hour outage. Webhooks emitted by Salesforce during that window might be lost; a post-outage reconciliation query (`SystemModstamp >= outage_start`) is recommended in production.
5. **ID Mapping:** Portal generates internal UUIDs; Salesforce generates 18-character sObject IDs (`001...`, `003...`). Records created in Portal use Salesforce Upsert via External ID (`Portal_Id__c`) to remain idempotent on retries.

### Questions for Stakeholders Before Production Lock
* *Q1:* Does Salesforce retain undelivered webhooks for $>6$ hours in an outage, or must the Portal initiate a reconciliation poll on recovery?
* *Q2:* What are the measured peak vs. quiet hour edit volumes across sales and finance teams?
* *Q3:* Does the business prefer field-level Last-Write-Wins (LWW) or should conflicting edits to sensitive billing fields generate manual review alerts for Finance?

---

## 2. Systems, Network Boundaries, and Interfaces

```
  Sales User                            Finance / Customer-Success User
      │                                                │
      ▼                                                ▼
 Salesforce CRM                                  Tequity Portal
 (CRM Database)                                 (Postgres / WAL)
      │                                                │
      │ ── (A) Inbound Webhook (HTTPS) ──────────────> │ Webhook Endpoint
      │                                                │
      │ <── (B) Outbound REST API (HTTPS, <=80 r/s) ── │ Outbox Dispatcher
```

* **Salesforce CRM:** Manages Sales users. Emits HTTPS webhook calls on record mutation. Accepts HTTPS REST calls (`PATCH /sobjects/{type}/{id}`).
* **Tequity Portal:** Manages Finance & Customer Success users. Stores master copy in PostgreSQL (demonstrated via durable JSONL WAL engine). Hosts inbound HTTPS webhook receiver and runs the background outbox dispatcher.
* **Network Boundary:** Public internet over HTTPS. All payloads are JSON over TLS 1.3. Webhooks arrive outside the 100 req/s cap; all outbound calls and retries are constrained by a shared token-bucket rate limiter.

---

## 3. Subproblems in Build Order

1. **Subproblem 1: Schema & Durable Audit Storage (Foundation):**
   * *Component:* `StorageEngine` abstraction & `JsonlStorageEngine`.
   * *Why first:* Without atomic durability and crash recovery, all other sync logic risks data loss.
2. **Subproblem 2: Deterministic Conflict Engine & History Preservation:**
   * *Component:* `ConflictResolver`.
   * *Why second:* Core data correctness. Establishes field-level LWW, tie-breakers, and ensures stale events are audited without clobbering state.
3. **Subproblem 3: Inbound Webhook Pipeline & Echo Suppression:**
   * *Component:* `WebhookHandler`.
   * *Why third:* Solves duplicate delivery (idempotency) and echo loop suppression before enabling external traffic.
4. **Subproblem 4: Outbound Dispatcher & Token-Bucket Rate Limiter:**
   * *Component:* `RateLimiter` & `OutboxDispatcher`.
   * *Why fourth:* Connects local mutations to Salesforce, enforcing strict $\le 100$ req/s rate limits and exponential backoff.
5. **Subproblem 5: Outage Resilience & Restart Recovery:**
   * *Component:* Outage reconciliation and crash recovery harnesses.

---

## 4. The Data Stored

* **Customer:** `id`, `name`, `status`, `owner`, `createdAt`, `updatedAt`, `fieldTimestamps: { name, status, owner }`.
* **Contact:** `id`, `customerId`, `fullName`, `phone`, `email`, `city`, `owner`, `createdAt`, `updatedAt`, `fieldTimestamps: { fullName, phone, email, city, owner, customerId }`.
* **AuditLogEntry (Immutable):** `id`, `recordId`, `objectType`, `fieldName`, `oldValue`, `newValue`, `changedBy`, `eventTimestamp`, `receivedAt`, `eventSource` (`SALESFORCE_WEBHOOK` | `PORTAL`), `eventId`, `appliedToCurrent` (`boolean`).
* **OutboxJob (Durable Queue):** `id`, `recordId`, `objectType`, `operation` (`CREATE` | `UPDATE`), `payload`, `status` (`PENDING` | `IN_FLIGHT` | `COMPLETED` | `FAILED`), `attempts`, `maxAttempts`, `correlationId`, `createdAt`, `updatedAt`, `nextAttemptAt`, `lastError`.
* **ProcessedEvent (Deduplication):** `eventId`, `recordId`, `objectType`, `processedAt`, `source`.

---

## 5. Inbound Path (Salesforce Webhook $\rightarrow$ Database)

1. **Ingress & Schema Validation:** Webhook payload arrives at endpoint (`eventId`, `recordId`, `objectType`, `occurredAt`, `changedBy`, `changedFields`).
2. **Idempotency Deduplication:** Checks `storage.isEventProcessed(payload.eventId)`. If true $\rightarrow$ immediately responds with HTTP 200 (`DUPLICATE`) and discards payload. No audit or outbox entries created.
3. **Echo Loop Check:** Inspects `payload.correlationId` and `payload.changedBy`. If `changedBy === integrationUserEmail` or correlation matches outbound registry $\rightarrow$ marks as `ECHO_SUPPRESSED`.
4. **Field-Level Resolution:** Evaluates each field in `changedFields` against existing record using `ConflictResolver`.
5. **Atomic Commit:**
   * If any field wins: updates entity projection and field timestamps.
   * Inserts audit log entries for all fields (`appliedToCurrent: true` if won, `false` if stale).
   * Inserts `eventId` into `processed_events`.
   * **Crucial Rule:** Inbound webhooks **never** enqueue an outbox job. Loop is physically impossible.

---

## 6. Outbound Path (Portal Edit $\rightarrow$ Salesforce REST API)

1. **User Save:** Finance or Customer-Success user submits form.
2. **Server-Committed Timestamp:** Portal backend assigns UTC timestamp (`new Date().toISOString()`).
3. **Conflict & State Update:** Resolves against local state, updates entity projection, and appends audit log.
4. **Atomic Outbox Enqueue:** In the **same database transaction**, enqueues an `OutboxJob` (`status: PENDING`, `correlationId: uuid`, `nextAttemptAt: now`).
5. **Outbox Dispatcher Processing:**
   * Fetches ready pending jobs where `nextAttemptAt <= now`.
   * Transitions job to `IN_FLIGHT` on disk before initiating HTTP call.
   * Registers `correlationId` in webhook echo filter.
   * Acquires token from shared `RateLimiter` (governs initial dispatches and retries $\le 80$ req/s).
   * Calls Salesforce REST API (`PATCH /sobjects/{type}/{id}`).
   * On HTTP 200/204: marks job `COMPLETED`.
   * On failure (outage / 503 / 429): increments `attempts`, sets exponential backoff `nextAttemptAt = now + base * 2^(attempts-1)`, resets status to `PENDING` (or `FAILED` if `attempts >= 5`). Pauses rate limiter if 429.

---

## 7. The Rule When Both Sides Change the Same Record

* **Different Fields (e.g. Sales edits `phone`, Finance edits `city`):**
  * Both survive cleanly. Granular field-level timestamps (`fieldTimestamps[fieldName]`) ensure field updates are merged independently without clobbering.
* **Same Field (e.g. Both edit `city`):**
  1. **Primary Rule — Timestamp (LWW):** Compare $T_{\text{incoming}}$ vs $T_{\text{current}}$. Newer timestamp wins.
  2. **Secondary Rule — Source Precedence (on exact timestamp equality):**
     * Domain ownership rule: Finance-dominated fields (`city`, `phone`, `email`) give precedence to `PORTAL`. Sales-dominated fields (`status`, `owner`) give precedence to `SALESFORCE_WEBHOOK`.
  3. **Tertiary Rule — Lexicographical Event ID:**
     * Final deterministic tie-breaker: $\text{localeCompare}(eventId_{\text{incoming}}, eventId_{\text{current}}) > 0$.
  4. **Audit Requirement:** The losing edit is recorded in `audit_log` with `appliedToCurrent: false`. Earlier values, who made them, and when stay permanently on record.

---

## 8. Rules for Duplicates and Out-of-Order Webhooks

* **Duplicate Webhook Delivery:**
  * Identified by `storage.isEventProcessed(eventId)`.
  * Return `HTTP 200 OK` with `{ status: 'DUPLICATE', ignored: true }`.
  * Drops the payload before touching entity records or audit logs.
* **Out-of-Order Webhooks (Older arrives after Newer):**
  * Let event $E_1$ occur at $10:00:00$ and event $E_2$ occur at $10:00:05$.
  * If $E_2$ arrives first: record value is set to $E_2$, timestamp to $10:00:05$.
  * When $E_1$ arrives second: $T_{E1} < T_{\text{current}}$.
  * **Action:** Current field value is **not** overwritten. An audit log entry is inserted for $E_1$ with `appliedToCurrent = false`.
  * Result: Monotonic progression of current state; zero data loss in history.

---

## 9. The Rule That Stops a Loop

1. **Origin Tagging:** All outbound requests sent by the Portal use a dedicated Integration User account (`integration-portal@client.example`) and pass `correlationId`.
2. **Ingress Suppression:** When Salesforce sends a webhook resulting from our own API call:
   * The webhook handler checks if `changedBy === integrationUserEmail` or if `correlationId` matches an active outbound job.
   * If matched: marked `ECHO_SUPPRESSED`.
   * State and audit are updated if necessary, but **no outbound outbox job is created**.
3. **Structural Decoupling:** Inbound webhooks never emit outbound sync events under any circumstances. Outbound sync events are emitted exclusively by Portal user actions.

---

## 10. The 6-Hour Outage: Disk State, Drain Strategy & Arithmetic

### State on Disk During Outage
* All Portal edits continue uninterrupted.
* Each user mutation commits to the database: updating current state, inserting audit records, and appending an `OutboxJob` (`status: PENDING`).
* Even if the Portal process crashes and restarts multiple times during the 6-hour outage, all pending jobs persist on disk in the durable journal / PostgreSQL outbox table.

### Backlog & Drain Arithmetic (Explicit Division)
* **Outage Duration:** 6 hours = $6 \times 3,600\text{ seconds} = 21,600\text{ seconds}$.
* **Portal Edit Influx Rate:** $20\text{ edits/second}$.
* **Salesforce API Processing Rate:** $80\text{ requests/second}$ (leaving 20 req/s buffer under the 100 req/s limit).
* **Ongoing Portal Influx During Catch-up:** Continues at $20\text{ edits/second}$.

1. **Total Accumulated Backlog:**
   $$\text{Backlog} = 21,600\text{ s} \times 20\text{ edits/s} = \mathbf{432,000\text{ edits}}$$
2. **Net Drain Rate:**
   $$\text{Net Drain Rate} = 80\text{ req/s} - 20\text{ req/s} = \mathbf{60\text{ req/s}}$$
3. **Recovery Time in Seconds:**
   $$T = \frac{432,000\text{ edits}}{60\text{ req/s}} = \mathbf{7,200\text{ seconds}}$$
4. **Recovery Time in Minutes:**
   $$\text{Recovery Time (Minutes)} = \frac{7,200}{60} = \mathbf{120\text{ minutes}}\ (\mathbf{2.0\text{ hours}})$$

*(Note: If catch-up occurs during quiet hours with 2 edits/s, net drain rate is $78\text{ req/s}$, completing recovery in $\frac{432,000}{78 \times 60} = \mathbf{92.3\text{ minutes}}$).*

---

## 11. Three Operational Numbers to Watch & Escalation Thresholds

1. **Outbox Queue Age (Oldest Pending Job Age):**
   * *Metric:* $\text{now}() - \min(\text{created\_at})$ for pending outbox jobs.
   * *Normal:* $< 5\text{ seconds}$ (well within the 30-second SLA).
   * *Call-Someone Threshold:* **$> 60\text{ seconds}$**. Indicates downstream Salesforce degradation, network partition, or token bucket stall.
2. **Salesforce HTTP 429 & 5xx Error Rate:**
   * *Metric:* Percentage of outbound API attempts returning 429 or 5xx over a 1-minute window.
   * *Normal:* $0\%$.
   * *Call-Someone Threshold:* **$> 5\%$ over 3 consecutive minutes**. Indicates API quota exhaustion or Salesforce platform outage requiring incident management.
3. **Dead-Letter / Failed Outbox Job Count:**
   * *Metric:* Count of jobs reaching `status = FAILED` (exhausted 5 retries).
   * *Normal:* 0.
   * *Call-Someone Threshold:* **$> 1$ failed job**. Indicates a permanent schema mismatch, validation rule failure, or data corruption requiring immediate engineering intervention.

---

## 12. Leaving Out of Scope

As stipulated by the assignment:
* Record deletions (soft or hard tombstones).
* Salesforce OAuth/SSO login screens.
* Visual Portal frontend UI (CLI and programmatic interfaces only).
* Multi-region active-active database replication.
* Live load testing against production Salesforce CRM instances.
