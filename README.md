# Two-Way Salesforce & PostgreSQL Sync Platform

Production-ready architecture, design document, and zero-dependency TypeScript implementation for bi-directional synchronization of Customer and Contact records between Salesforce CRM and an internal operations portal.

---

## 1. Quick Start

### Prerequisites
* Node.js version 20 or newer (tested on Node.js v24).
* No external databases or services required (runs with Node.js alone).

### Installation & Build
```bash
npm install
npm run build
```

### Run All Tests
```bash
npm test
```

---

## 2. Mandatory Assignment Scenarios Covered

The test suite directly verifies the four mandatory scenarios from `assignment.md`:

1. **Duplicate Webhook Delivery:**
   * Handled idempotently using stable event identifiers (`eventId`). Duplicate events are dropped without corrupting state or creating duplicate audit entries (`tests/end-to-end-scenarios.test.ts: Scenario 1`).
2. **Out-of-Order Webhook Delivery:**
   * Field-level Last-Write-Wins (LWW) resolver compares field timestamps. An older event arriving after a newer event keeps the current projection intact, while appending to the immutable audit log with `appliedToCurrent: false` (`tests/end-to-end-scenarios.test.ts: Scenario 2`).
3. **Sync Loop Prevention (Echo Suppression):**
   * Uses Tier-1 Integration User context (`changedBy === integration-portal@client.example`) and correlation IDs, with an in-flight cache fallback. Inbound webhooks never generate outbound jobs (`tests/end-to-end-scenarios.test.ts: Scenario 3`).
4. **6-Hour Salesforce Outage & Recovery:**
   * Portal user mutations accumulate in durable on-disk outbox queue. Survives process kills and restarts. Drains the backlog at the rate-limited target upon CRM recovery (`tests/end-to-end-scenarios.test.ts: Scenario 4`).

---

## 3. Architecture & Documentation

Full architectural specification available in:
* [`docs/architecture-design.md`](./docs/architecture-design.md): Complete design document covering assumptions, system topology, subproblems, inbound/outbound paths, conflict resolution rules, 6-hour outage arithmetic, monitoring metrics, and out-of-scope boundaries.

---

## 4. Test Suite Summary

* `tests/storage.test.ts`: Atomic commits, write serialization, crash recovery, trailing line repairs, and mid-file corruption detection (11 tests).
* `tests/conflict-resolution.test.ts`: Field-level LWW, disjoint field merging, source precedence, and event ID tie-breakers (5 tests).
* `tests/webhook-ingestion.test.ts`: Webhook validation, deduplication, and loop suppression (4 tests).
* `tests/outbox-dispatcher.test.ts`: Outbox queue, rate limiting, exponential backoff retries, and max attempt failures (5 tests).
* `tests/end-to-end-scenarios.test.ts`: All 4 mandatory end-to-end assignment scenarios (4 tests).

**Total: 29 automated tests passing with 0 failures.**
