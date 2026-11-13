# Salesforce & PostgreSQL Two-Way Sync

A production-grade architectural design and prototype for bi-directional synchronization of customer and contact records between Salesforce CRM and an internal operations portal (PostgreSQL).

## Project Structure
- `src/models`: Domain entity types, DTOs, and event schemas.
- `src/storage`: Durable persistence abstraction and JSONL Write-Ahead Log (WAL) engine.
- `src/sync`: Field-level conflict resolution (LWW) and echo loop suppression engine.
- `src/webhook`: Inbound webhook endpoint, payload validator, and event deduplication.
- `src/workers`: Outbox queue consumer and token-bucket rate limiter.
- `src/mock-salesforce`: Simulated CRM REST API with outage toggles and rate limiting.
- `tests`: End-to-end and rule verification test suites.
- `data`: Disk persistence directory for JSONL WAL journals.
- `docs`: System architectural designs, recovery calculations, and runbooks.
