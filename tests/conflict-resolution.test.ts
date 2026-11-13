import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictResolver } from '../src/sync/conflict-resolver.js';
import { Customer, Contact } from '../src/models/index.js';

describe('Milestone 2: Deterministic Conflict Resolution & Audit Trail', () => {
  const resolver = new ConflictResolver();

  it('merges simultaneous edits to different fields of the same record (both survive)', () => {
    const initialContact: Contact = {
      id: '0031A00000Abc',
      customerId: '001A00000Xyz',
      fullName: 'Aman Verma',
      phone: '+919876543210',
      email: 'aman@example.com',
      city: 'Delhi',
      owner: 'sales.rep@client.example',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      fieldTimestamps: {
        fullName: '2026-11-01T10:00:00.000Z',
        phone: '2026-11-01T10:00:00.000Z',
        email: '2026-11-01T10:00:00.000Z',
        city: '2026-11-01T10:00:00.000Z',
        owner: '2026-11-01T10:00:00.000Z',
        customerId: '2026-11-01T10:00:00.000Z',
      },
    };

    // Edit 1 from Portal (Finance): corrects city to Noida at 10:05:00
    const portalResult = resolver.resolveContact(initialContact, {
      id: '0031A00000Abc',
      changedFields: { city: 'Noida' },
      changedBy: 'finance.user@client.example',
      eventTimestamp: '2026-11-01T10:05:00.000Z',
      source: 'PORTAL',
      eventId: 'evt_portal_1',
      receivedAt: '2026-11-01T10:05:00.500Z',
    });

    assert.equal(portalResult.contact.city, 'Noida');
    assert.equal(portalResult.contact.phone, '+919876543210'); // Phone unchanged

    // Edit 2 from Salesforce (Sales): updates phone at 10:06:00
    const salesforceResult = resolver.resolveContact(portalResult.contact, {
      id: '0031A00000Abc',
      changedFields: { phone: '+919999999999' },
      changedBy: 'sales.user@client.example',
      eventTimestamp: '2026-11-01T10:06:00.000Z',
      source: 'SALESFORCE_WEBHOOK',
      eventId: 'evt_salesforce_1',
      receivedAt: '2026-11-01T10:06:01.000Z',
    });

    // Both edits must survive: city from portal, phone from salesforce!
    assert.equal(salesforceResult.contact.city, 'Noida', 'City from portal user must survive');
    assert.equal(salesforceResult.contact.phone, '+919999999999', 'Phone from sales user must survive');
  });

  it('resolves edits to the same field using Last-Write-Wins (newer timestamp wins)', () => {
    const existingCustomer: Customer = {
      id: '001A00000Xyz',
      name: 'Acme India',
      status: 'Active',
      owner: 'old.owner@client.example',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      fieldTimestamps: {
        name: '2026-11-01T10:00:00.000Z',
        status: '2026-11-01T10:00:00.000Z',
        owner: '2026-11-01T10:00:00.000Z',
      },
    };

    // Newer status update arrives
    const result = resolver.resolveCustomer(existingCustomer, {
      id: '001A00000Xyz',
      changedFields: { status: 'Suspended' },
      changedBy: 'sales.admin@client.example',
      eventTimestamp: '2026-11-01T10:10:00.000Z',
      source: 'SALESFORCE_WEBHOOK',
      eventId: 'evt_status_new',
      receivedAt: '2026-11-01T10:10:01.000Z',
    });

    assert.equal(result.customer.status, 'Suspended');
    assert.equal(result.auditEntries.length, 1);
    assert.equal(result.auditEntries[0].appliedToCurrent, true);
    assert.equal(result.auditEntries[0].oldValue, 'Active');
    assert.equal(result.auditEntries[0].newValue, 'Suspended');
  });

  it('preserves history when a stale out-of-order event arrives without overwriting current value', () => {
    const currentCustomer: Customer = {
      id: '001A00000Xyz',
      name: 'Acme India',
      status: 'Suspended',
      owner: 'rep@client.example',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:10:00.000Z',
      fieldTimestamps: {
        name: '2026-11-01T10:00:00.000Z',
        status: '2026-11-01T10:10:00.000Z', // Current status was set at 10:10:00
        owner: '2026-11-01T10:00:00.000Z',
      },
    };

    // Stale event arrives with timestamp 10:05:00 (earlier than current 10:10:00)
    const result = resolver.resolveCustomer(currentCustomer, {
      id: '001A00000Xyz',
      changedFields: { status: 'Active' },
      changedBy: 'delayed.sales@client.example',
      eventTimestamp: '2026-11-01T10:05:00.000Z',
      source: 'SALESFORCE_WEBHOOK',
      eventId: 'evt_delayed_001',
      receivedAt: '2026-11-01T10:12:00.000Z',
    });

    // Current value must NOT be modified
    assert.equal(result.customer.status, 'Suspended', 'Stale event must not overwrite newer value');

    // Audit trail MUST preserve the observed edit with appliedToCurrent = false
    assert.equal(result.auditEntries.length, 1);
    const audit = result.auditEntries[0];
    assert.equal(audit.appliedToCurrent, false, 'Audit entry must record that stale edit was not applied');
    assert.equal(audit.oldValue, 'Suspended');
    assert.equal(audit.newValue, 'Active');
    assert.equal(audit.changedBy, 'delayed.sales@client.example');
    assert.equal(audit.eventTimestamp, '2026-11-01T10:05:00.000Z');
  });

  it('deterministically breaks ties when timestamps are exactly equal using source precedence', () => {
    // Both Portal and Salesforce submit a change to Contact city with the exact same millisecond timestamp
    const exactTimestamp = '2026-11-01T12:00:00.000Z';

    const baseContact: Contact = {
      id: '0031A00000Abc',
      customerId: '001A00000Xyz',
      fullName: 'Aman Verma',
      phone: '+919876543210',
      email: 'aman@example.com',
      city: 'Delhi',
      owner: 'sales.rep@client.example',
      createdAt: exactTimestamp,
      updatedAt: exactTimestamp,
      fieldTimestamps: {
        fullName: exactTimestamp,
        phone: exactTimestamp,
        email: exactTimestamp,
        city: exactTimestamp,
        owner: exactTimestamp,
        customerId: exactTimestamp,
      },
    };

    // City is a Finance domain field -> Portal has precedence over Salesforce
    const fieldRes = resolver.resolveField({
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      fieldName: 'city',
      incomingValue: 'Gurgaon',
      currentValue: 'Delhi',
      incomingTimestamp: exactTimestamp,
      currentTimestamp: exactTimestamp,
      incomingSource: 'PORTAL',
      currentSource: 'SALESFORCE_WEBHOOK',
      incomingEventId: 'evt_portal_tie',
      currentEventId: 'evt_sf_tie',
      changedBy: 'finance.user@client.example',
      receivedAt: exactTimestamp,
    });

    assert.equal(fieldRes.applied, true, 'Portal source should win for city on equal timestamp');
    assert.equal(fieldRes.winnerValue, 'Gurgaon');
  });

  it('uses lexicographical event ID as final tie-breaker when timestamp and source are identical', () => {
    const exactTimestamp = '2026-11-01T12:00:00.000Z';

    const resolution1 = resolver.resolveField({
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      fieldName: 'phone',
      incomingValue: '+911111111111',
      currentValue: '+910000000000',
      incomingTimestamp: exactTimestamp,
      currentTimestamp: exactTimestamp,
      incomingSource: 'PORTAL',
      currentSource: 'PORTAL',
      incomingEventId: 'evt_z_higher',
      currentEventId: 'evt_a_lower',
      changedBy: 'user1',
      receivedAt: exactTimestamp,
    });

    assert.equal(resolution1.applied, true, 'Higher lexicographical event ID wins');
    assert.equal(resolution1.winnerValue, '+911111111111');

    const resolution2 = resolver.resolveField({
      recordId: '0031A00000Abc',
      objectType: 'Contact',
      fieldName: 'phone',
      incomingValue: '+912222222222',
      currentValue: '+910000000000',
      incomingTimestamp: exactTimestamp,
      currentTimestamp: exactTimestamp,
      incomingSource: 'PORTAL',
      currentSource: 'PORTAL',
      incomingEventId: 'evt_a_lower',
      currentEventId: 'evt_z_higher',
      changedBy: 'user2',
      receivedAt: exactTimestamp,
    });

    assert.equal(resolution2.applied, false, 'Lower lexicographical event ID loses');
  });
});
