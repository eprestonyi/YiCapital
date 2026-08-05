import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { handleLedgerAdminRequest } from '../worker/ledger-store.js';

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) { return new D1Statement(this.database, this.sql, values); }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.values) };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes || 0) } };
  }

  runInBatch() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class D1Database {
  constructor(sql) {
    this.database = new DatabaseSync(':memory:');
    this.database.exec(sql);
  }

  prepare(sql) { return new D1Statement(this.database, sql); }

  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.runInBatch());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

class MemoryKv {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) || null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

async function setup() {
  const migrations = [
    '../migrations/0002_portfolio_ledger.sql',
    '../migrations/0003_frozen_price_tapes.sql',
    '../migrations/0005_public_portfolio_snapshots.sql',
    '../migrations/0006_dividend_candidate_inbox.sql',
    '../migrations/0007_action_review_workbench.sql',
  ];
  const sql = (await Promise.all(
    migrations.map(path => readFile(new URL(path, import.meta.url), 'utf8')),
  )).join('\n');
  return {
    env: {
      FEEDBACK_DB: new D1Database(sql),
      YC_KV: new MemoryKv(),
    },
  };
}

async function api(env, path, { method = 'GET', body } = {}) {
  const response = await handleLedgerAdminRequest(new Request(`https://ledger.test${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }), env, { actor: 'correction-test-admin' });
  return { status: response.status, body: await response.json() };
}

function buy(amount, notes) {
  return {
    type: 'BUY',
    date: '2026-01-03',
    ticker: 'AAA',
    name: 'AAA Inc',
    quantity: 10,
    Amount: amount,
    price: null,
    notes,
  };
}

test('confirmed event correction is staged outside the active ledger, then appends lineage v2 and preserves history', async () => {
  const { env } = await setup();
  const database = env.FEEDBACK_DB.database;

  const created = await api(env, '/api/admin/ledger/pending', {
    method: 'POST',
    body: { portfolio: 'us', event: buy('100.00', 'original trade') },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const confirmedV1 = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: created.body.item.pendingId,
      expectedVersion: created.body.item.version,
      confirmation: { reason: 'original BUY checked' },
    },
  });
  assert.equal(confirmedV1.status, 200, JSON.stringify(confirmedV1.body));
  const original = confirmedV1.body.item;
  assert.equal(original.eventVersion, 1);
  assert.equal(confirmedV1.body.ledgerRevision, 1);

  const staleRevision = await api(env, '/api/admin/ledger/events/correction', {
    method: 'POST',
    body: {
      portfolio: 'us',
      eventId: original.eventId,
      expectedEventVersion: original.eventVersion,
      expectedLedgerRevision: 0,
      event: buy('120.00', 'must not stage with stale ledger revision'),
    },
  });
  assert.equal(staleRevision.status, 409, JSON.stringify(staleRevision.body));

  const staleEventVersion = await api(env, '/api/admin/ledger/events/correction', {
    method: 'POST',
    body: {
      portfolio: 'us',
      eventId: original.eventId,
      expectedEventVersion: original.eventVersion + 1,
      expectedLedgerRevision: confirmedV1.body.ledgerRevision,
      event: buy('120.00', 'must not stage with stale event version'),
    },
  });
  assert.equal(staleEventVersion.status, 409, JSON.stringify(staleEventVersion.body));
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_pending').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get().count, 1);

  const staged = await api(env, '/api/admin/ledger/events/correction', {
    method: 'POST',
    body: {
      portfolio: 'us',
      eventId: original.eventId,
      expectedEventVersion: original.eventVersion,
      expectedLedgerRevision: confirmedV1.body.ledgerRevision,
      event: buy('120.00', 'corrected trade'),
    },
  });
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  assert.equal(staged.body.item.status, 'PENDING');
  assert.equal(staged.body.item.baseEventId, original.eventId);
  assert.equal(staged.body.item.baseEventVersion, 1);
  assert.equal(staged.body.item.lineageId, original.lineageId);

  // Staging is only a mutable review item. It must not alter revision 1 or its
  // active confirmed event until an administrator explicitly confirms it.
  const afterStage = await api(env, '/api/admin/ledger?portfolio=us&status=CONFIRMED');
  assert.equal(afterStage.status, 200, JSON.stringify(afterStage.body));
  assert.equal(afterStage.body.ledgerRevision, 1);
  assert.equal(afterStage.body.events.length, 1);
  assert.equal(afterStage.body.events[0].eventId, original.eventId);
  assert.equal(afterStage.body.events[0].event.amount_minor, 10000);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get().count, 1);

  const confirmedV2 = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: staged.body.item.pendingId,
      expectedVersion: staged.body.item.version,
      confirmation: { reason: 'corrected BUY checked' },
    },
  });
  assert.equal(confirmedV2.status, 200, JSON.stringify(confirmedV2.body));
  const replacement = confirmedV2.body.item;
  assert.equal(confirmedV2.body.ledgerRevision, 2);
  assert.equal(replacement.eventVersion, 2);
  assert.equal(replacement.lineageId, original.lineageId);
  assert.equal(replacement.supersedesEventId, original.eventId);
  assert.equal(replacement.event.amount_minor, 12000);

  const activeV2 = await api(env, '/api/admin/ledger?portfolio=us&status=CONFIRMED');
  assert.equal(activeV2.status, 200, JSON.stringify(activeV2.body));
  assert.equal(activeV2.body.ledgerRevision, 2);
  assert.equal(activeV2.body.events.length, 1);
  assert.equal(activeV2.body.events[0].eventId, replacement.eventId);
  assert.equal(activeV2.body.events[0].eventVersion, 2);

  const storedVersions = database.prepare(`
    SELECT event_id, lineage_id, event_version, ledger_revision,
      supersedes_event_id, payload_json
    FROM ledger_events
    WHERE portfolio_id = 'us' AND lineage_id = ?
    ORDER BY event_version
  `).all(original.lineageId);
  assert.equal(storedVersions.length, 2);
  assert.deepEqual(storedVersions.map(row => row.event_version), [1, 2]);
  assert.deepEqual(storedVersions.map(row => row.ledger_revision), [1, 2]);
  assert.equal(storedVersions[0].event_id, original.eventId);
  assert.equal(storedVersions[0].supersedes_event_id, null);
  assert.equal(JSON.parse(storedVersions[0].payload_json).amount_minor, 10000);
  assert.equal(storedVersions[1].event_id, replacement.eventId);
  assert.equal(storedVersions[1].supersedes_event_id, original.eventId);
  assert.equal(JSON.parse(storedVersions[1].payload_json).amount_minor, 12000);

  const history = await api(
    env,
    `/api/admin/ledger/events/history?portfolio=us&lineageId=${encodeURIComponent(original.lineageId)}`,
  );
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.equal(history.body.lineageId, original.lineageId);
  assert.deepEqual(history.body.versions.map(item => item.eventVersion), [2, 1]);
  assert.deepEqual(history.body.versions.map(item => item.eventId), [replacement.eventId, original.eventId]);
  assert.equal(history.body.versions[0].supersedesEventId, original.eventId);
  assert.equal(history.body.versions[1].supersedesEventId, null);

  const correctionAgainstStaleRevision = await api(env, '/api/admin/ledger/events/correction', {
    method: 'POST',
    body: {
      portfolio: 'us',
      eventId: original.eventId,
      expectedEventVersion: 1,
      expectedLedgerRevision: 1,
      event: buy('130.00', 'old screen must not overwrite v2'),
    },
  });
  assert.equal(
    correctionAgainstStaleRevision.status,
    409,
    JSON.stringify(correctionAgainstStaleRevision.body),
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ledger_events').get().count, 2);
});
