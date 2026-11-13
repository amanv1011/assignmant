/**
 * Synchronization and API types for Salesforce <-> Postgres sync.
 */
import { ObjectType } from '../models/types.js';

export interface SalesforceWebhookPayload {
  eventId: string;
  recordId: string;
  objectType: ObjectType;
  occurredAt: string; // ISO 8601 UTC
  changedBy: string;
  changedFields: Record<string, any>;
  correlationId?: string; // Optional echo correlation ID
}

export interface PortalEditPayload {
  recordId: string;
  objectType: ObjectType;
  editedBy: string;
  changedFields: Record<string, any>;
}

export interface ConflictResolutionResult {
  updatedFields: Record<string, any>;
  fieldTimestamps: Record<string, string>;
  appliedFields: string[];
  supersededFields: string[];
}
