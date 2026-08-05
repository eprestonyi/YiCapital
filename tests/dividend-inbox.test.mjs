import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  handleLedgerAdminRequest,
  ledgerHealth,
  loadDividendDetectionHoldings,
  persistDividendCandidates,
  persistMaterializedLedgerProjection,
} from '../worker/ledger-store.js';
import { runScheduledDividendDetection } from '../worker/worker.js';

class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }
  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
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
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

async function setup() {
  const sql = (await Promise.all([
    '../migrations/0002_portfolio_ledger.sql',
    '../migrations/0003_frozen_price_tapes.sql',
    '../migrations/0005_public_portfolio_snapshots.sql',
    '../migrations/0006_dividend_candidate_inbox.sql',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
  return { FEEDBACK_DB: new D1Database(sql), YC_KV: new MemoryKv() };
}

async function api(env, path, { method = 'GET', body } = {}) {
  const response = await handleLedgerAdminRequest(new Request(`https://ledger.test${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }), env, { actor: 'dividend-test-admin' });
  return { status: response.status, body: await response.json() };
}

function candidate(overrides = {}) {
  return {
    schema_version: 'dividend-candidate-v1',
    event_type: 'DIVIDEND',
    candidate_status: 'PENDING',
    portfolio: 'us',
    ticker: 'AAA',
    name: 'AAA Inc',
    ex_date: '2026-01-03',
    pay_date: '2026-01-04',
    source_event_id: 'yahoo:query2-chart:AAA:dividend:1767398400',
    amount: null,
    amount_status: 'PENDING_VERIFICATION',
    evidence: {
      provider: 'Yahoo Finance',
      source: 'yahoo:query2-chart',
      provider_event_timestamp: 1767398400,
      event_date_semantics: 'ex_date',
      fetched_at: '2026-01-05T01:00:00.000Z',
    },
    ...overrides,
  };
}

test('migration and candidate persistence enforce a NULL amount and never overwrite duplicates', async () => {
  const env = await setup();
  const first = await persistDividendCandidates(env, 'us', [candidate()], {
    detectedAt: '2026-01-05T01:00:00.000Z',
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.inserted, 1);
  assert.equal(first.results[0].candidate.amount, null);
  assert.equal(first.results[0].candidate.status, 'PENDING_VERIFICATION');

  const db = env.FEEDBACK_DB.database;
  const stored = db.prepare(`SELECT * FROM ledger_dividend_candidates`).get();
  assert.equal(stored.amount_minor, null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_source_records`).get().count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM ledger_audit_log
    WHERE action = 'DIVIDEND_CANDIDATE_DETECTED'
  `).get().count, 1);
  const rawSource = JSON.parse(db.prepare(`
    SELECT payload_json FROM ledger_source_records WHERE source_record_id = ?
  `).get(stored.source_record_id).payload_json);
  assert.equal(rawSource.amount, null);
  assert.equal(rawSource.amount_status, 'PENDING_VERIFICATION');
  assert.equal(rawSource.evidence, undefined);
  assert.throws(() => db.prepare(`
    UPDATE ledger_dividend_candidates SET amount_minor = 100 WHERE candidate_id = ?
  `).run(stored.candidate_id), /CHECK constraint failed/);

  const duplicate = await persistDividendCandidates(env, 'us', [candidate()], {
    detectedAt: '2026-01-06T01:00:00.000Z',
  });
  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.duplicates, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_dividend_candidates`).get().count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM ledger_audit_log
    WHERE action = 'DIVIDEND_CANDIDATE_DETECTED'
  `).get().count, 1);
  assert.equal(db.prepare(`SELECT detected_at FROM ledger_dividend_candidates`).get().detected_at,
    Date.parse('2026-01-05T01:00:00.000Z'));

  const volatileEvidenceDuplicate = await persistDividendCandidates(env, 'us', [candidate({
    evidence: {
      ...candidate().evidence,
      fetched_at: '2026-01-07T01:00:00.000Z',
      source_url: 'https://query2.finance.yahoo.com/chart/AAA?period1=changed&period2=changed',
    },
  })]);
  assert.equal(volatileEvidenceDuplicate.inserted, 0);
  assert.equal(volatileEvidenceDuplicate.duplicates, 1);
  assert.equal(volatileEvidenceDuplicate.conflicts, 0);
  const firstEvidence = JSON.parse(db.prepare(`
    SELECT evidence_json FROM ledger_dividend_candidates
  `).get().evidence_json);
  assert.equal(firstEvidence.fetched_at, '2026-01-05T01:00:00.000Z');
  assert.equal(firstEvidence.source_url, undefined);

  const conflicting = await persistDividendCandidates(env, 'us', [candidate({
    pay_date: '2026-01-05',
  })]);
  assert.equal(conflicting.inserted, 0);
  assert.equal(conflicting.conflicts, 1);
  assert.equal(JSON.parse(db.prepare(`
    SELECT evidence_json FROM ledger_dividend_candidates
  `).get().evidence_json).provider_event_key, undefined);
  assert.equal((await ledgerHealth(env)).ready, true);
});

test('admin verifies broker Amount into Automation Pending, derives CPS, and never auto-confirms', async () => {
  const env = await setup();
  const createdBuy = await api(env, '/api/admin/ledger/pending', {
    method: 'POST',
    body: {
      portfolio: 'us',
      event: {
        type: 'BUY', date: '2026-01-02', ticker: 'AAA', name: 'AAA Inc',
        quantity: 10, amount: '100.00', price: '',
      },
    },
  });
  assert.equal(createdBuy.status, 201, JSON.stringify(createdBuy.body));
  const confirmedBuy = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: createdBuy.body.item.pendingId,
      expectedVersion: createdBuy.body.item.version,
      confirmation: { reason: 'seed current holding' },
    },
  });
  assert.equal(confirmedBuy.status, 200, JSON.stringify(confirmedBuy.body));

  const stored = await persistDividendCandidates(env, 'us', [candidate()], {
    detectedAt: '2026-01-05T01:00:00.000Z',
  });
  const inboxItem = stored.results[0].candidate;
  const listed = await api(env, '/api/admin/ledger/dividends?portfolio=us');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.candidates.length, 1);
  assert.equal(listed.body.candidates[0].amount, null);
  assert.equal(listed.body.candidates[0].currentQuantity, 10);
  assert.equal(listed.body.candidates[0].suggestedQuantity, 10);

  const missingAmount = await api(env, '/api/admin/ledger/dividends/verify', {
    method: 'POST',
    body: { candidateId: inboxItem.candidateId, expectedVersion: inboxItem.version },
  });
  assert.equal(missingAmount.status, 422, JSON.stringify(missingAmount.body));
  assert.match(missingAmount.body.error, /Amount/);

  const missingQuantity = await api(env, '/api/admin/ledger/dividends/verify', {
    method: 'POST',
    body: {
      candidateId: inboxItem.candidateId,
      expectedVersion: inboxItem.version,
      Amount: '25.00',
    },
  });
  assert.equal(missingQuantity.status, 422, JSON.stringify(missingQuantity.body));
  assert.match(missingQuantity.body.error, /Quantity/);

  const verified = await api(env, '/api/admin/ledger/dividends/verify', {
    method: 'POST',
    body: {
      candidateId: inboxItem.candidateId,
      expectedVersion: inboxItem.version,
      Amount: '25.00',
      quantity: 10,
      actualReceiptDate: '2026-01-04',
      recordDate: '2026-01-02',
      reviewNote: 'broker statement checked',
    },
  });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.duplicate, false);
  assert.equal(verified.body.candidate.status, 'CONVERTED');
  assert.equal(verified.body.candidate.amount, null);
  assert.equal(verified.body.pending.status, 'PENDING');
  assert.equal(verified.body.pending.source, 'AUTOMATION');
  assert.equal(verified.body.pending.event.amount, 25);
  assert.equal(verified.body.pending.event.net_cash, 25);
  assert.equal(verified.body.pending.event.quantity, 10);
  assert.equal(verified.body.pending.event.per_share, 2.5);
  assert.equal(verified.body.pending.event.price, null);
  assert.equal(verified.body.pending.event.actual_receipt_date, '2026-01-04');
  assert.equal(verified.body.pending.event.record_date, '2026-01-02');

  const db = env.FEEDBACK_DB.database;
  assert.equal(db.prepare(`SELECT amount_minor FROM ledger_dividend_candidates`).get().amount_minor,
    null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_events`).get().count, 1,
    'the dividend must remain Pending until the normal explicit Confirm');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM ledger_pending
    WHERE event_type = 'DIVIDEND' AND status = 'PENDING'
  `).get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_outbox`).get().count, 3,
    'only the confirmed seed BUY enqueues derived work');

  const retry = await api(env, '/api/admin/ledger/dividends/verify', {
    method: 'POST',
    body: {
      candidateId: inboxItem.candidateId,
      expectedVersion: inboxItem.version,
      Amount: '25.00',
    },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.pending.pendingId, verified.body.pending.pendingId);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM ledger_pending WHERE event_type = 'DIVIDEND'
  `).get().count, 1);
});

test('dismiss is audited and cannot create Pending', async () => {
  const env = await setup();
  const stored = await persistDividendCandidates(env, 'hk', [candidate({
    portfolio: 'hk', ticker: '00700.HK', name: '腾讯控股',
    source_event_id: 'yahoo:query2-chart:0700.HK:dividend:1767398400',
  })]);
  const item = stored.results[0].candidate;
  const dismissed = await api(env, '/api/admin/ledger/dividends/dismiss', {
    method: 'POST',
    body: {
      candidateId: item.candidateId,
      expectedVersion: item.version,
      reason: 'broker statement confirms no entitlement',
    },
  });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  assert.equal(dismissed.body.candidate.status, 'DISMISSED');
  const db = env.FEEDBACK_DB.database;
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_pending`).get().count, 0);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM ledger_audit_log
    WHERE action = 'DIVIDEND_CANDIDATE_DISMISSED'
  `).get().count, 1);

  const retry = await api(env, '/api/admin/ledger/dividends/dismiss', {
    method: 'POST',
    body: { candidateId: item.candidateId, expectedVersion: item.version, reason: 'retry' },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
});

test('detection holdings union includes securities held earlier in the scan window', async () => {
  const env = await setup();
  const confirmedEvents = [
    {
      event_id: 'window-buy-sold', type: 'BUY', event_type: 'BUY',
      date: '2026-07-01', trade_date: '2026-07-01', sequence_no: 1,
      ticker: 'SOLD', name: 'Sold After Ex-Date', quantity: 10, amount: '100.00',
      status: 'confirmed', currency: 'USD',
    },
    {
      event_id: 'window-sell-sold', type: 'SELL', event_type: 'SELL',
      date: '2026-08-03', trade_date: '2026-08-03', sequence_no: 2,
      ticker: 'SOLD', name: 'Sold After Ex-Date', quantity: 10, amount: '110.00',
      status: 'confirmed', currency: 'USD',
    },
    {
      event_id: 'window-buy-late', type: 'BUY', event_type: 'BUY',
      date: '2026-08-04', trade_date: '2026-08-04', sequence_no: 3,
      ticker: 'LATE', name: 'Bought During Window', quantity: 5, amount: '50.00',
      status: 'confirmed', currency: 'USD',
    },
  ];
  await persistMaterializedLedgerProjection(env, 'us', 0, {
    portfolio: 'us', market: 'us', ledgerRevision: 0,
    source: 'd1-confirmed-event-ledger', savedBy: 'ledger-outbox',
    savedAt: '2026-08-05T03:00:00.000Z', valuationReady: true,
    navRecalculationRequired: [], confirmedEvents,
    positions: [{
      t: 'LATE', n: 'Bought During Window', q: 5, p: 10, mv: 50,
      priceDate: '2026-08-04', priceSource: 'TUSHARE',
      priceBasis: 'raw_close', priceAdjusted: false,
    }],
  });
  const window = await loadDividendDetectionHoldings(env, 'us', {
    fromDate: '2026-08-01',
    toDate: '2026-08-05',
  });
  assert.equal(window.ready, true);
  assert.equal(window.holdingCoverage, 'WINDOW_POSITIVE_UNION');
  assert.equal(window.entitlementDetermined, false);
  assert.deepEqual(window.holdings.map(item => item.ticker), ['LATE', 'SOLD']);
  assert.equal(window.holdings.find(item => item.ticker === 'SOLD').quantity, 10);
});

test('scheduled EOD detection reads the last complete materialized holdings and isolates symbol failures', async () => {
  const env = await setup();
  const savedAt = '2026-08-05T03:00:00.000Z';
  await persistMaterializedLedgerProjection(env, 'us', 0, {
    portfolio: 'us',
    market: 'us',
    ledgerRevision: 0,
    source: 'd1-confirmed-event-ledger',
    savedBy: 'ledger-outbox',
    savedAt,
    valuationReady: true,
    navRecalculationRequired: [],
    positions: [
      {
        t: 'GOOD', n: 'Good Inc', q: 4, p: 10, mv: 40,
        priceDate: '2026-08-04', priceSource: 'TUSHARE',
        priceBasis: 'raw_close', priceAdjusted: false,
      },
      {
        t: 'FAIL', n: 'Fail Inc', q: 2, p: 20, mv: 40,
        priceDate: '2026-08-04', priceSource: 'TUSHARE',
        priceBasis: 'raw_close', priceAdjusted: false,
      },
      { t: 'ZERO', n: 'Zero Inc', q: 0, p: 1, mv: 0 },
    ],
  });
  // Revision 1 is still dynamic. Detection must continue from the coherent
  // last-complete revision 0 snapshot instead of stalling or mixing states.
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  const eventTime = Math.floor(Date.parse('2026-08-03T13:30:00.000Z') / 1000);
  const fetchImpl = async url => {
    if (String(url).includes('/FAIL?')) return { ok: false };
    return {
      ok: true,
      async json() {
        return {
          chart: {
            error: null,
            result: [{ events: { dividends: {
              event: { date: eventTime, amount: 999.99 },
            } } }],
          },
        };
      },
    };
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  let run;
  try {
    run = await runScheduledDividendDetection(env, ['us'], {
      now: () => Date.parse('2026-08-05T04:00:00.000Z'),
      fetchImpl,
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].checkedHoldings, 2);
  assert.equal(run.results[0].ledgerRevision, 1);
  assert.equal(run.results[0].materializedRevision, 0);
  assert.equal(run.results[0].failedHoldings, 1);
  assert.equal(run.results[0].detected, 1);
  assert.equal(run.results[0].inserted, 1);
  assert.ok(errors.some(args => args[0] === 'dividend_detection_security_failed' &&
    args[2] === 'FAIL'));

  const db = env.FEEDBACK_DB.database;
  const stored = db.prepare(`SELECT * FROM ledger_dividend_candidates`).get();
  assert.equal(stored.ticker, 'GOOD');
  assert.equal(stored.amount_minor, null);
  assert.doesNotMatch(stored.evidence_json, /999\.99|amount|tax|fee|withholding/i);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_pending`).get().count, 0);

  const duplicate = await runScheduledDividendDetection(env, ['us'], {
    now: () => Date.parse('2026-08-05T04:00:00.000Z'),
    fetchImpl,
  });
  assert.equal(duplicate.results[0].inserted, 0);
  assert.equal(duplicate.results[0].duplicates, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_dividend_candidates`).get().count, 1);
});
