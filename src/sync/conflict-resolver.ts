import { randomUUID } from 'node:crypto';
import {
  ObjectType,
  EventSource,
  Customer,
  Contact,
  AuditLogEntry,
} from '../models/index.js';

export interface FieldConflictContext {
  recordId: string;
  objectType: ObjectType;
  fieldName: string;
  incomingValue: any;
  currentValue: any;
  incomingTimestamp: string; // ISO 8601 UTC
  currentTimestamp?: string; // ISO 8601 UTC
  incomingSource: EventSource;
  currentSource?: EventSource;
  incomingEventId: string;
  currentEventId?: string;
  changedBy: string;
  receivedAt: string; // ISO 8601 UTC
}

export interface FieldResolutionResult {
  winnerValue: any;
  winnerTimestamp: string;
  winnerEventId: string;
  applied: boolean;
  auditEntry: AuditLogEntry;
}

export interface ConflictResolverOptions {
  /** Default source precedence when timestamps are identical */
  defaultSourcePrecedence?: EventSource;
  /** Field-specific source precedence when timestamps are identical */
  fieldSourcePrecedence?: Record<string, EventSource>;
}

/**
 * Deterministic Field-Level Conflict Resolver.
 *
 * Implements:
 * 1. Primary: Authoritative Timestamp comparison (Last-Write-Wins per field).
 * 2. Secondary (equal timestamp): Domain Source Precedence (e.g., Portal > Salesforce for city/billing; Salesforce > Portal for owner/status).
 * 3. Tertiary (equal timestamp & source): Lexicographical Event ID tie-breaker.
 *
 * Guarantees that every observed edit generates an immutable audit log entry,
 * preserving full history while preventing stale events from overwriting current state.
 */
export class ConflictResolver {
  private readonly defaultSourcePrecedence: EventSource;
  private readonly fieldSourcePrecedence: Record<string, EventSource>;

  constructor(options: ConflictResolverOptions = {}) {
    this.defaultSourcePrecedence = options.defaultSourcePrecedence ?? 'PORTAL';
    this.fieldSourcePrecedence = {
      // Domain-specific rules:
      city: 'PORTAL', // Finance owns billing city
      phone: 'PORTAL',
      email: 'PORTAL',
      status: 'SALESFORCE_WEBHOOK', // Sales owns customer status
      owner: 'SALESFORCE_WEBHOOK', // Sales owns account owner
      ...options.fieldSourcePrecedence,
    };
  }

  /**
   * Resolves a single field conflict between an incoming edit and existing state.
   */
  public resolveField(ctx: FieldConflictContext): FieldResolutionResult {
    const incomingTime = new Date(ctx.incomingTimestamp).getTime();
    const currentTime = ctx.currentTimestamp ? new Date(ctx.currentTimestamp).getTime() : 0;

    let incomingWins = false;

    if (!ctx.currentTimestamp || incomingTime > currentTime) {
      // Rule 1: Strictly newer timestamp wins
      incomingWins = true;
    } else if (incomingTime < currentTime) {
      // Rule 2: Strictly older timestamp loses (stale event)
      incomingWins = false;
    } else {
      // Rule 3: Timestamps are exactly equal -> Deterministic tie-breaker
      const preferredSource = this.fieldSourcePrecedence[ctx.fieldName] ?? this.defaultSourcePrecedence;
      if (ctx.incomingSource === preferredSource && ctx.currentSource !== preferredSource) {
        incomingWins = true;
      } else if (ctx.currentSource === preferredSource && ctx.incomingSource !== preferredSource) {
        incomingWins = false;
      } else {
        // Rule 4: Final tie-breaker -> Lexicographical comparison of event IDs
        const currId = ctx.currentEventId ?? '';
        incomingWins = ctx.incomingEventId.localeCompare(currId) > 0;
      }
    }

    const winnerValue = incomingWins ? ctx.incomingValue : ctx.currentValue;
    const winnerTimestamp = incomingWins ? ctx.incomingTimestamp : ctx.currentTimestamp!;
    const winnerEventId = incomingWins ? ctx.incomingEventId : (ctx.currentEventId ?? ctx.incomingEventId);

    const auditEntry: AuditLogEntry = {
      id: randomUUID(),
      recordId: ctx.recordId,
      objectType: ctx.objectType,
      fieldName: ctx.fieldName,
      oldValue: ctx.currentValue !== undefined && ctx.currentValue !== null ? String(ctx.currentValue) : null,
      newValue: ctx.incomingValue !== undefined && ctx.incomingValue !== null ? String(ctx.incomingValue) : null,
      changedBy: ctx.changedBy,
      eventTimestamp: ctx.incomingTimestamp,
      receivedAt: ctx.receivedAt,
      eventSource: ctx.incomingSource,
      eventId: ctx.incomingEventId,
      appliedToCurrent: incomingWins,
    };

    return {
      winnerValue,
      winnerTimestamp,
      winnerEventId,
      applied: incomingWins,
      auditEntry,
    };
  }

  /**
   * Applies a patch of changed fields to a Customer record.
   */
  public resolveCustomer(
    existing: Customer | null,
    patch: {
      id: string;
      changedFields: Partial<Record<'name' | 'status' | 'owner', any>>;
      changedBy: string;
      eventTimestamp: string;
      source: EventSource;
      eventId: string;
      receivedAt: string;
    }
  ): { customer: Customer; auditEntries: AuditLogEntry[]; hasChanges: boolean } {
    const isNew = !existing;
    const current: Customer = existing
      ? { ...existing, fieldTimestamps: { ...existing.fieldTimestamps } }
      : {
          id: patch.id,
          name: '',
          status: 'Active',
          owner: '',
          createdAt: patch.eventTimestamp,
          updatedAt: patch.eventTimestamp,
          fieldTimestamps: {
            name: '',
            status: '',
            owner: '',
          },
        };

    const auditEntries: AuditLogEntry[] = [];
    let hasAppliedChange = false;

    const allowedFields: (keyof typeof patch.changedFields)[] = ['name', 'status', 'owner'];

    for (const field of allowedFields) {
      if (patch.changedFields[field] !== undefined) {
        const resolution = this.resolveField({
          recordId: patch.id,
          objectType: 'Customer',
          fieldName: field,
          incomingValue: patch.changedFields[field],
          currentValue: (current as any)[field],
          incomingTimestamp: patch.eventTimestamp,
          currentTimestamp: current.fieldTimestamps[field] || undefined,
          incomingSource: patch.source,
          incomingEventId: patch.eventId,
          changedBy: patch.changedBy,
          receivedAt: patch.receivedAt,
        });

        auditEntries.push(resolution.auditEntry);

        if (resolution.applied) {
          (current as any)[field] = resolution.winnerValue;
          current.fieldTimestamps[field] = resolution.winnerTimestamp;
          hasAppliedChange = true;
        }
      }
    }

    if (hasAppliedChange || isNew) {
      current.updatedAt = patch.receivedAt;
    }

    return { customer: current, auditEntries, hasChanges: hasAppliedChange || isNew };
  }

  /**
   * Applies a patch of changed fields to a Contact record.
   */
  public resolveContact(
    existing: Contact | null,
    patch: {
      id: string;
      customerId?: string;
      changedFields: Partial<Record<'fullName' | 'phone' | 'email' | 'city' | 'owner' | 'customerId', any>>;
      changedBy: string;
      eventTimestamp: string;
      source: EventSource;
      eventId: string;
      receivedAt: string;
    }
  ): { contact: Contact; auditEntries: AuditLogEntry[]; hasChanges: boolean } {
    const isNew = !existing;
    const current: Contact = existing
      ? { ...existing, fieldTimestamps: { ...existing.fieldTimestamps } }
      : {
          id: patch.id,
          customerId: patch.customerId || (patch.changedFields as any).customerId || '',
          fullName: '',
          phone: '',
          email: '',
          city: '',
          owner: '',
          createdAt: patch.eventTimestamp,
          updatedAt: patch.eventTimestamp,
          fieldTimestamps: {
            fullName: '',
            phone: '',
            email: '',
            city: '',
            owner: '',
            customerId: '',
          },
        };

    const auditEntries: AuditLogEntry[] = [];
    let hasAppliedChange = false;

    const allowedFields: (keyof typeof patch.changedFields)[] = [
      'fullName',
      'phone',
      'email',
      'city',
      'owner',
      'customerId',
    ];

    for (const field of allowedFields) {
      if (patch.changedFields[field] !== undefined) {
        const resolution = this.resolveField({
          recordId: patch.id,
          objectType: 'Contact',
          fieldName: field,
          incomingValue: patch.changedFields[field],
          currentValue: (current as any)[field],
          incomingTimestamp: patch.eventTimestamp,
          currentTimestamp: current.fieldTimestamps[field] || undefined,
          incomingSource: patch.source,
          incomingEventId: patch.eventId,
          changedBy: patch.changedBy,
          receivedAt: patch.receivedAt,
        });

        auditEntries.push(resolution.auditEntry);

        if (resolution.applied) {
          (current as any)[field] = resolution.winnerValue;
          current.fieldTimestamps[field] = resolution.winnerTimestamp;
          hasAppliedChange = true;
        }
      }
    }

    if (hasAppliedChange || isNew) {
      current.updatedAt = patch.receivedAt;
    }

    return { contact: current, auditEntries, hasChanges: hasAppliedChange || isNew };
  }
}
