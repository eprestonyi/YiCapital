import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  handleLedgerAdminRequest,
  loadActionDetectionScanPlan,
  persistActionDetectionScanState,
  persistCorporateActionCandidates,
  persistDividendCandidates,
  persistMaterializedLedgerProjection,
} from '../worker/ledger-store.js';

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
    '../migrations/0007_action_review_workbench.sql',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
  return { FEEDBACK_DB: new D1Database(sql), YC_KV: new MemoryKv() };
}

async function api(env, path, { method = 'GET', body } = {}) {
  const response = await handleLedgerAdminRequest(new Request(`https://ledger.test${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }), env, { actor: 'action-review-test-admin' });
  return { status: response.status, body: await response.json() };
}

function corporateCandidate(overrides = {}) {
  return {
    schema_version: 'corporate-action-candidate-v1',
    event_type: 'CORPORATE_ACTION',
    candidate_status: 'PENDING',
    portfolio: 'us',
    ticker: 'AAA',
    name: 'AAA Inc',
    action_date: '2026-06-05',
    record_date: null,
    action_type_hint: 'SPLIT',
    source_event_id: 'yahoo:query2-chart:AAA:split:1780666200',
    cash_change: null,
    evidence: {
      provider: 'Yahoo Finance',
      source: 'yahoo:query2-chart',
      provider_event_key: 'split_one',
      provider_event_timestamp: 1780666200,
      event_date_semantics: 'effective_date',
      fetched_at: '2026-06-06T01:00:00.000Z',
    },
    ...overrides,
  };
}

function dividendCandidate(overrides = {}) {
  return {
    schema_version: 'dividend-candidate-v1',
    event_type: 'DIVIDEND',
    candidate_status: 'PENDING',
    portfolio: 'us',
    ticker: 'ZERO',
    name: 'Zero Dividend Inc',
    ex_date: '2026-06-08',
    pay_date: '2026-06-10',
    source_event_id: 'yahoo:query2-chart:ZERO:dividend:1780925400',
    amount: null,
    amount_status: 'PENDING_VERIFICATION',
    evidence: {
      provider: 'Yahoo Finance',
      source: 'yahoo:query2-chart',
      provider_event_key: 'zero_dividend',
      provider_event_timestamp: 1780925400,
      event_date_semantics: 'ex_date',
      fetched_at: '2026-06-09T01:00:00.000Z',
    },
    ...overrides,
  };
}

test('a corporate-action signal moves from unified OPEN to Automation Pending and unified RESOLVED', async () => {
  const env = await setup();
  const persisted = await persistCorporateActionCandidates(
    env,
    'us',
    [corporateCandidate()],
    { detectedAt: '2026-06-06T01:00:00.000Z' },
  );
  assert.equal(persisted.ok, true, JSON.stringify(persisted));
  assert.equal(persisted.inserted, 1);
  const candidate = persisted.results[0].candidate;

  const open = await api(env, '/api/admin/ledger/actions?portfolio=us&state=OPEN');
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal(open.body.items.length, 1);
  assert.equal(open.body.items[0].candidateType, 'CORPORATE_ACTION');
  assert.equal(open.body.items[0].status, 'PENDING_VERIFICATION');

  const resolved = await api(env, '/api/admin/ledger/actions/resolve', {
    method: 'POST',
    body: {
      candidateType: 'CORPORATE_ACTION',
      decision: 'ENTER',
      candidateId: candidate.candidateId,
      expectedVersion: candidate.version,
      actionType: 'SPLIT',
      actionDate: '2026-06-05',
      quantity: 10,
      postTicker: 'AAA',
      postQuantity: 20,
      cashChange: '0.00',
      reviewNote: 'broker position checked',
    },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.duplicate, false);
  assert.equal(resolved.body.candidate.status, 'CONVERTED');
  assert.equal(resolved.body.pending.status, 'PENDING');
  assert.equal(resolved.body.pending.source, 'AUTOMATION');
  assert.equal(resolved.body.pending.event.type, 'CORPORATE_ACTION');
  assert.equal(resolved.body.pending.event.corporate_action_type, 'SPLIT');
  assert.equal(resolved.body.pending.event.pre_quantity, 10);
  assert.equal(resolved.body.pending.event.post_ticker, 'AAA');
  assert.equal(resolved.body.pending.event.post_quantity, 20);
  assert.equal(resolved.body.pending.event.cash_change, 0);

  const afterOpen = await api(env, '/api/admin/ledger/actions?portfolio=us&state=OPEN');
  assert.equal(afterOpen.body.items.length, 0);
  const handled = await api(env, '/api/admin/ledger/actions?portfolio=us&state=RESOLVED');
  assert.equal(handled.status, 200);
  assert.equal(handled.body.items.length, 1);
  assert.equal(handled.body.items[0].convertedPending.pendingId,
    resolved.body.pending.pendingId);
  assert.deepEqual(handled.body.items[0].resolutionHistory.map(item => item.action), ['ENTER']);

  const db = env.FEEDBACK_DB.database;
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_events`).get().count, 0,
    'review resolution must not bypass the explicit Confirm boundary');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_pending`).get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_candidate_observations`).get().count, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_candidate_resolutions`).get().count, 1);
});

test('ignored corporate actions appear in RESOLVED and can be reopened with append-only history', async () => {
  const env = await setup();
  const persisted = await persistCorporateActionCandidates(env, 'us', [corporateCandidate({
    ticker: 'BBB',
    name: 'BBB Inc',
    action_date: '2026-06-12',
    source_event_id: 'yahoo:query2-chart:BBB:split:1781271000',
  })]);
  const candidate = persisted.results[0].candidate;

  const ignored = await api(env, '/api/admin/ledger/actions/resolve', {
    method: 'POST',
    body: {
      candidateType: 'CORPORATE_ACTION',
      decision: 'IGNORE',
      candidateId: candidate.candidateId,
      expectedVersion: candidate.version,
      reason: 'broker confirms no entitlement',
    },
  });
  assert.equal(ignored.status, 200, JSON.stringify(ignored.body));
  assert.equal(ignored.body.candidate.status, 'DISMISSED');
  assert.equal(ignored.body.candidate.version, 2);

  const handled = await api(env, '/api/admin/ledger/actions?portfolio=us&state=RESOLVED');
  assert.equal(handled.body.items.length, 1);
  assert.deepEqual(handled.body.items[0].resolutionHistory.map(item => item.action), ['IGNORE']);

  const reopened = await api(env, '/api/admin/ledger/actions/reopen', {
    method: 'POST',
    body: {
      candidateType: 'CORPORATE_ACTION',
      candidateId: candidate.candidateId,
      expectedVersion: ignored.body.candidate.version,
      reason: 'new broker statement requires another review',
    },
  });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.duplicate, false);
  assert.equal(reopened.body.candidate.status, 'PENDING_VERIFICATION');
  assert.equal(reopened.body.candidate.version, 3);

  const open = await api(env, '/api/admin/ledger/actions?portfolio=us&state=OPEN');
  assert.equal(open.body.items.length, 1);
  assert.deepEqual(new Set(open.body.items[0].resolutionHistory.map(item => item.action)),
    new Set(['IGNORE', 'REOPEN']));
  assert.equal(env.FEEDBACK_DB.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_pending
  `).get().count, 0);
});

test('a manually verified Dividend Amount of zero is valid and CPS is derived as zero', async () => {
  const env = await setup();
  const persisted = await persistDividendCandidates(env, 'us', [dividendCandidate()]);
  const candidate = persisted.results[0].candidate;

  const resolved = await api(env, '/api/admin/ledger/actions/resolve', {
    method: 'POST',
    body: {
      candidateType: 'DIVIDEND',
      decision: 'ENTER',
      candidateId: candidate.candidateId,
      expectedVersion: candidate.version,
      amount: '0.00',
      quantity: 7,
      actualReceiptDate: '2026-06-10',
      reviewNote: 'broker booked a zero cash distribution',
    },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.candidate.status, 'CONVERTED');
  assert.equal(resolved.body.pending.status, 'PENDING');
  assert.equal(resolved.body.pending.event.amount, 0);
  assert.equal(resolved.body.pending.event.net_cash, 0);
  assert.equal(resolved.body.pending.event.quantity, 7);
  assert.equal(resolved.body.pending.event.per_share, 0);

  const db = env.FEEDBACK_DB.database;
  assert.equal(db.prepare(`SELECT amount_minor FROM ledger_dividend_candidates`).get().amount_minor,
    null, 'the immutable provider candidate must retain a NULL amount');
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_events`).get().count, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ledger_pending`).get().count, 1);
});

test('rejected candidate Pending can be reopened and entered as a new idempotent review attempt', async () => {
  const scenarios = [
    {
      candidateType: 'DIVIDEND',
      keyPrefix: 'dividend-candidate',
      persist: env => persistDividendCandidates(env, 'us', [dividendCandidate()]),
      enter: (candidate, expectedVersion, amount) => ({
        candidateType: 'DIVIDEND', decision: 'ENTER',
        candidateId: candidate.candidateId, expectedVersion,
        amount, quantity: 7, actualReceiptDate: '2026-06-10',
        reviewNote: `dividend review attempt v${expectedVersion}`,
      }),
    },
    {
      candidateType: 'CORPORATE_ACTION',
      keyPrefix: 'corporate-action-candidate',
      persist: env => persistCorporateActionCandidates(env, 'us', [corporateCandidate()]),
      enter: (candidate, expectedVersion, _amount, postQuantity) => ({
        candidateType: 'CORPORATE_ACTION', decision: 'ENTER',
        candidateId: candidate.candidateId, expectedVersion,
        actionType: 'SPLIT', actionDate: '2026-06-05', quantity: 10,
        postTicker: 'AAA', postQuantity, cashChange: '0.00',
        reviewNote: `corporate-action review attempt v${expectedVersion}`,
      }),
    },
  ];

  for (const scenario of scenarios) {
    const env = await setup();
    const persisted = await scenario.persist(env);
    const candidate = persisted.results[0].candidate;
    const first = await api(env, '/api/admin/ledger/actions/resolve', {
      method: 'POST',
      body: scenario.enter(candidate, candidate.version, '1.00', 20),
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.duplicate, false);
    assert.equal(
      first.body.pending.idempotencyKey,
      `${scenario.keyPrefix}:${candidate.candidateId}:v1`,
    );

    const rejected = await api(env, '/api/admin/ledger/pending/reject', {
      method: 'POST',
      body: {
        pendingId: first.body.pending.pendingId,
        expectedVersion: first.body.pending.version,
        reason: 'first review attempt was wrong',
      },
    });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    assert.equal(rejected.body.item.status, 'REJECTED');

    const reopened = await api(env, '/api/admin/ledger/actions/reopen', {
      method: 'POST',
      body: {
        candidateType: scenario.candidateType,
        candidateId: candidate.candidateId,
        expectedVersion: first.body.candidate.version,
        reason: 'review again from corrected broker evidence',
      },
    });
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
    assert.equal(reopened.body.candidate.status, 'PENDING_VERIFICATION');
    assert.equal(reopened.body.candidate.version, 3);

    const second = await api(env, '/api/admin/ledger/actions/resolve', {
      method: 'POST',
      body: scenario.enter(reopened.body.candidate, reopened.body.candidate.version, '2.00', 30),
    });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.duplicate, false);
    assert.notEqual(second.body.pending.pendingId, first.body.pending.pendingId);
    assert.equal(
      second.body.pending.idempotencyKey,
      `${scenario.keyPrefix}:${candidate.candidateId}:v3`,
    );

    const pendingRows = env.FEEDBACK_DB.database.prepare(`
      SELECT status, idempotency_key FROM ledger_pending ORDER BY rowid
    `).all();
    assert.deepEqual(pendingRows.map(row => row.status), ['REJECTED', 'PENDING']);
    assert.equal(new Set(pendingRows.map(row => row.idempotency_key)).size, 2);
    const resolutionRows = env.FEEDBACK_DB.database.prepare(`
      SELECT resolution_action, candidate_version
      FROM ledger_candidate_resolutions ORDER BY rowid
    `).all();
    assert.deepEqual(resolutionRows.map(row => row.resolution_action),
      ['ENTER', 'REOPEN', 'ENTER']);
    assert.deepEqual(resolutionRows.map(row => row.candidate_version), [2, 3, 4]);
  }
});

test('resolved candidate follows its lineage to the current active corrected event', async () => {
  const env = await setup();

  const buyPending = await api(env, '/api/admin/ledger/pending', {
    method: 'POST',
    body: {
      portfolio: 'us',
      event: {
        type: 'BUY', date: '2026-06-01', ticker: 'AAA', name: 'AAA Inc',
        quantity: 7, amount: '70.00', price: null,
      },
    },
  });
  assert.equal(buyPending.status, 201, JSON.stringify(buyPending.body));
  const buyConfirmed = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: buyPending.body.item.pendingId,
      expectedVersion: buyPending.body.item.version,
      confirmation: { reason: 'seed holding' },
    },
  });
  assert.equal(buyConfirmed.status, 200, JSON.stringify(buyConfirmed.body));

  const persisted = await persistDividendCandidates(env, 'us', [dividendCandidate({
    ticker: 'AAA',
    name: 'AAA Inc',
    source_event_id: 'yahoo:query2-chart:AAA:dividend:1780925400',
  })]);
  const candidate = persisted.results[0].candidate;
  const entered = await api(env, '/api/admin/ledger/actions/resolve', {
    method: 'POST',
    body: {
      candidateType: 'DIVIDEND', decision: 'ENTER',
      candidateId: candidate.candidateId, expectedVersion: candidate.version,
      amount: '7.00', quantity: 7, actualReceiptDate: '2026-06-10',
      reviewNote: 'initial broker amount',
    },
  });
  assert.equal(entered.status, 200, JSON.stringify(entered.body));
  const originalPendingId = entered.body.pending.pendingId;
  const confirmedV1 = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: originalPendingId,
      expectedVersion: entered.body.pending.version,
      confirmation: { reason: 'initial dividend checked' },
    },
  });
  assert.equal(confirmedV1.status, 200, JSON.stringify(confirmedV1.body));
  const dividendV1 = confirmedV1.body.item;
  assert.equal(dividendV1.eventVersion, 1);

  const stagedCorrection = await api(env, '/api/admin/ledger/events/correction', {
    method: 'POST',
    body: {
      portfolio: 'us',
      eventId: dividendV1.eventId,
      expectedEventVersion: dividendV1.eventVersion,
      expectedLedgerRevision: confirmedV1.body.ledgerRevision,
      event: {
        type: 'DIVIDEND', date: '2026-06-10', ticker: 'AAA', name: 'AAA Inc',
        quantity: 7, amount: '14.00', notes: 'corrected broker amount',
        dividend_candidate_id: candidate.candidateId,
        ex_date: '2026-06-08', pay_date: '2026-06-10',
        actual_receipt_date: '2026-06-10',
      },
    },
  });
  assert.equal(stagedCorrection.status, 201, JSON.stringify(stagedCorrection.body));
  const confirmedV2 = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: stagedCorrection.body.item.pendingId,
      expectedVersion: stagedCorrection.body.item.version,
      confirmation: { reason: 'corrected dividend checked' },
    },
  });
  assert.equal(confirmedV2.status, 200, JSON.stringify(confirmedV2.body));
  const dividendV2 = confirmedV2.body.item;
  assert.equal(dividendV2.lineageId, dividendV1.lineageId);
  assert.equal(dividendV2.eventVersion, 2);
  assert.equal(dividendV2.supersedesEventId, dividendV1.eventId);

  const resolved = await api(env, '/api/admin/ledger/actions?portfolio=us&state=RESOLVED');
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.items.length, 1);
  const linked = resolved.body.items[0];
  assert.equal(linked.convertedPending.pendingId, originalPendingId,
    'the candidate keeps its immutable original Pending link');
  assert.equal(linked.convertedPending.originalConfirmedEventId, dividendV1.eventId);
  assert.equal(linked.convertedPending.confirmedEventId, dividendV2.eventId,
    'the edit target must follow the lineage to active v2');
  assert.equal(linked.convertedPending.lineageId, dividendV2.lineageId);
  assert.equal(linked.linkedActiveEvent.eventId, dividendV2.eventId);
  assert.equal(linked.linkedActiveEvent.eventVersion, 2);
  assert.equal(linked.linkedActiveEvent.event.amount_minor, 1400);

  const activeLedger = await api(env, '/api/admin/ledger?portfolio=us&status=CONFIRMED');
  const activeDividend = activeLedger.body.events.find(item => item.eventType === 'DIVIDEND');
  assert.equal(activeDividend.eventId, linked.convertedPending.confirmedEventId);
  assert.equal(env.FEEDBACK_DB.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_events WHERE lineage_id = ?
  `).get(dividendV1.lineageId).count, 2, 'both immutable event versions remain stored');
});

test('unified action pagination orders both candidate tables before applying the page boundary', async () => {
  const env = await setup();
  await persistDividendCandidates(env, 'us', [
    dividendCandidate({
      ticker: 'DNEW', name: 'New Dividend', ex_date: '2026-06-30', pay_date: null,
      source_event_id: 'yahoo:query2-chart:DNEW:dividend:1782739800',
    }),
    dividendCandidate({
      ticker: 'DOLD', name: 'Old Dividend', ex_date: '2026-06-10', pay_date: null,
      source_event_id: 'yahoo:query2-chart:DOLD:dividend:1781011800',
    }),
  ]);
  await persistCorporateActionCandidates(env, 'us', [
    corporateCandidate({
      ticker: 'CNEW', name: 'New Action', action_date: '2026-06-20',
      source_event_id: 'yahoo:query2-chart:CNEW:split:1781875800',
    }),
    corporateCandidate({
      ticker: 'COLD', name: 'Old Action', action_date: '2026-06-01',
      source_event_id: 'yahoo:query2-chart:COLD:split:1780234200',
    }),
  ]);

  const first = await api(env,
    '/api/admin/ledger/actions?portfolio=us&state=ALL&limit=2&offset=0');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.total, 4);
  assert.equal(first.body.nextOffset, 2);
  assert.deepEqual(first.body.items.map(item => item.ticker), ['DNEW', 'CNEW']);

  const second = await api(env,
    '/api/admin/ledger/actions?portfolio=us&state=ALL&limit=2&offset=2');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.total, 4);
  assert.equal(second.body.nextOffset, null);
  assert.deepEqual(second.body.items.map(item => item.ticker), ['DOLD', 'COLD']);
  assert.equal(new Set([...first.body.items, ...second.body.items]
    .map(item => item.candidateId)).size, 4);

  const dividendsOnly = await api(env,
    '/api/admin/ledger/actions?portfolio=us&state=OPEN&type=DIVIDEND&month=2026-06&limit=1');
  assert.equal(dividendsOnly.body.total, 2);
  assert.equal(dividendsOnly.body.nextOffset, 1);
  assert.deepEqual(dividendsOnly.body.items.map(item => item.ticker), ['DNEW']);
});

test('action scan state performs a full first backfill and then a 45-day incremental overlap', async () => {
  const env = await setup();
  await persistMaterializedLedgerProjection(env, 'us', 0, {
    portfolio: 'us',
    market: 'us',
    ledgerRevision: 0,
    source: 'd1-confirmed-event-ledger',
    savedBy: 'ledger-outbox',
    savedAt: '2026-08-05T03:00:00.000Z',
    valuationReady: true,
    navRecalculationRequired: [],
    confirmedEvents: [],
    positions: [],
  });
  const first = await loadActionDetectionScanPlan(env, 'us', {
    firstHeldDate: '2024-02-15',
    toDate: '2026-08-05',
    lookbackDays: 45,
    ledgerRevision: 0,
  });
  assert.equal(first.mode, 'FULL_HOLDING_HISTORY');
  assert.equal(first.fromDate, '2024-02-15');
  assert.equal(first.toDate, '2026-08-05');

  const saved = await persistActionDetectionScanState(env, 'us', {
    ledgerRevision: 0,
    materializedRevision: 0,
    fromDate: first.fromDate,
    toDate: first.toDate,
    checkedHoldings: 12,
    failedHoldings: 0,
    sourceCoverage: {
      dividends: 'YAHOO_CHART',
      splits: 'YAHOO_CHART',
      renamesMergersSpinoffs: 'PARTIAL_MANUAL_REVIEW_REQUIRED',
    },
  });
  assert.equal(saved.status, 'COMPLETE');

  const second = await loadActionDetectionScanPlan(env, 'us', {
    firstHeldDate: '2024-02-15',
    toDate: '2026-08-10',
    lookbackDays: 45,
    ledgerRevision: 0,
  });
  assert.equal(second.mode, 'INCREMENTAL_OVERLAP');
  assert.equal(second.fromDate, '2026-06-26');
  assert.equal(second.toDate, '2026-08-10');
  assert.equal(second.previous.coverageFrom, '2024-02-15');
  assert.equal(second.previous.scannedThrough, '2026-08-05');
  assert.equal(second.previous.status, 'COMPLETE');

  const revisionChanged = await loadActionDetectionScanPlan(env, 'us', {
    firstHeldDate: '2024-02-15',
    toDate: '2026-08-10',
    lookbackDays: 45,
    ledgerRevision: 1,
  });
  assert.equal(revisionChanged.mode, 'FULL_HOLDING_HISTORY',
    'a ledger revision can add an old closed holding and must force a full rescan');
  assert.equal(revisionChanged.fromDate, '2024-02-15');

  const review = await api(env, '/api/admin/ledger/actions?portfolio=us&state=ALL');
  assert.equal(review.status, 200);
  assert.equal(review.body.coverage.status, 'COMPLETE');
  assert.equal(review.body.coverage.coverageFrom, '2024-02-15');
  assert.equal(review.body.coverage.scannedThrough, '2026-08-05');
  assert.equal(review.body.coverage.checkedHoldings, 12);

  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  const staleReview = await api(env, '/api/admin/ledger/actions?portfolio=us&state=ALL');
  assert.equal(staleReview.status, 200);
  assert.equal(staleReview.body.coverage.status, 'STALE');
  assert.equal(staleReview.body.coverage.recordedStatus, 'COMPLETE');
  assert.equal(staleReview.body.coverage.current, false);
  assert.equal(staleReview.body.coverage.currentLedgerRevision, 1);
  assert.equal(staleReview.body.coverage.ledgerRevision, 0);
  await assert.rejects(
    persistActionDetectionScanState(env, 'us', {
      ledgerRevision: 1,
      materializedRevision: 0,
      fromDate: '2024-02-15',
      toDate: '2026-08-10',
      checkedHoldings: 12,
      failedHoldings: 0,
      complete: true,
    }),
    error => error?.details?.code === 'ACTION_SCAN_MATERIALIZED_REVISION_MISMATCH',
  );
  const unchanged = env.FEEDBACK_DB.database.prepare(`
    SELECT * FROM ledger_action_scan_state WHERE portfolio_id = 'us'
  `).get();
  assert.equal(unchanged.ledger_revision, 0);
  assert.equal(unchanged.coverage_from, '2024-02-15');
  assert.equal(unchanged.scanned_through, '2026-08-05');
  assert.equal(unchanged.status, 'COMPLETE');
});
