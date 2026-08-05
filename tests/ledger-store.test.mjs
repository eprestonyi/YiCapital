import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  freezeLedgerPriceTape,
  handleLedgerAdminRequest,
  loadMaterializedLedgerProjection,
  loadPublicPortfolioAttempt,
  loadPublicPortfolioSnapshot,
  materializeLedgerKv,
  persistLedgerValuation,
  persistPublicPortfolioSnapshot,
  updatePublicPortfolioStatus,
} from '../worker/ledger-store.js';

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
  constructor() {
    this.values = new Map();
    this.puts = [];
    this.onPut = null;
  }
  async get(key) { return this.values.get(key) || null; }
  async put(key, value) {
    this.puts.push({ key, value });
    this.values.set(key, value);
    if (this.onPut) await this.onPut(key, value);
  }
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
  const env = { FEEDBACK_DB: new D1Database(sql), YC_KV: new MemoryKv() };
  return { env };
}

function publicSnapshot({
  revision = 1,
  snapshotId = 'portfolio-us-v1',
  asOf = '2026-08-05',
  updatedAt = '2026-08-05T10:00:00.000Z',
} = {}) {
  return {
    ok: true,
    enabled: true,
    portfolio: 'us',
    ledgerRevision: revision,
    snapshot_id: snapshotId,
    cacheVersion: 3,
    as_of: asOf,
    updatedAt,
    historyComplete: true,
    history: [],
    navRows: [],
    curve: [],
    holdings: [],
  };
}

test('D1 public snapshot helpers publish one atomic row and update only newer status', async () => {
  const { env } = await setup();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  const snapshot = publicSnapshot();
  const publishedStatus = {
    pf: 'us', ledgerRevision: 1, complete: true, fallback: false,
    ranAt: '2026-08-05T10:00:00.000Z',
  };

  await persistPublicPortfolioSnapshot(env, 'us', 1, snapshot, publishedStatus);
  const publishedRow = database.prepare(`
    SELECT ledger_revision, snapshot_id, snapshot_json, snapshot_sha256,
      status_json, generated_at, status_at
    FROM ledger_public_snapshots WHERE portfolio_id = 'us'
  `).get();
  assert.equal(publishedRow.ledger_revision, 1);
  assert.equal(publishedRow.snapshot_id, snapshot.snapshot_id);
  assert.match(publishedRow.snapshot_sha256, /^[a-f0-9]{64}$/);

  const loaded = await loadPublicPortfolioSnapshot(env, 'us');
  assert.equal(loaded.ledgerRevision, 1);
  assert.equal(loaded.snapshotId, snapshot.snapshot_id);
  assert.deepEqual(loaded.snapshot, snapshot);
  assert.deepEqual(loaded.status, publishedStatus);

  const newerStatus = {
    pf: 'us', ledgerRevision: 1, fallback: true,
    reason: 'quote_temporarily_unavailable',
    ranAt: '2026-08-05T10:05:00.000Z',
  };
  assert.equal(await updatePublicPortfolioStatus(env, 'us', newerStatus), true);
  const statusUpdatedRow = database.prepare(`
    SELECT ledger_revision, snapshot_id, snapshot_json, snapshot_sha256,
      status_json, generated_at, status_at
    FROM ledger_public_snapshots WHERE portfolio_id = 'us'
  `).get();
  assert.deepEqual(statusUpdatedRow, publishedRow);
  const newerAttempt = await loadPublicPortfolioAttempt(env, 'us');
  assert.equal(newerAttempt.ledgerRevision, 1);
  assert.deepEqual(newerAttempt.status, newerStatus);

  const olderStatus = {
    pf: 'us', ledgerRevision: 1, fallback: false,
    ranAt: '2026-08-05T10:01:00.000Z',
  };
  assert.equal(await updatePublicPortfolioStatus(env, 'us', olderStatus), true);
  assert.deepEqual(
    await loadPublicPortfolioAttempt(env, 'us'),
    newerAttempt,
  );
});

test('D1 public snapshot load fails closed when the stored SHA is corrupted', async () => {
  const { env } = await setup();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  await persistPublicPortfolioSnapshot(
    env,
    'us',
    1,
    publicSnapshot(),
    { pf: 'us', ledgerRevision: 1, ranAt: '2026-08-05T10:00:00.000Z' },
  );
  database.prepare(`
    UPDATE ledger_public_snapshots SET snapshot_sha256 = ? WHERE portfolio_id = 'us'
  `).run('0'.repeat(64));

  await assert.rejects(
    loadPublicPortfolioSnapshot(env, 'us'),
    error => error && error.status === 503 && /校驗失敗/.test(error.message),
  );
});

test('an older same-revision public snapshot is a no-op and cannot replace the newer row', async () => {
  const { env } = await setup();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  const newer = publicSnapshot({
    snapshotId: 'portfolio-us-newer',
    updatedAt: '2026-08-05T10:05:00.000Z',
  });
  await persistPublicPortfolioSnapshot(env, 'us', 1, newer, {
    pf: 'us', ledgerRevision: 1, complete: true, fallback: false,
    ranAt: '2026-08-05T10:05:00.000Z',
  });
  const before = database.prepare(`
    SELECT * FROM ledger_public_snapshots WHERE portfolio_id = 'us'
  `).get();

  const older = publicSnapshot({
    snapshotId: 'portfolio-us-older',
    updatedAt: '2026-08-05T10:00:00.000Z',
  });
  await persistPublicPortfolioSnapshot(env, 'us', 1, older, {
    pf: 'us', ledgerRevision: 1, complete: true, fallback: false,
    ranAt: '2026-08-05T10:00:00.000Z',
  });

  const after = database.prepare(`
    SELECT * FROM ledger_public_snapshots WHERE portfolio_id = 'us'
  `).get();
  assert.deepEqual(after, before);
  assert.equal((await loadPublicPortfolioSnapshot(env, 'us')).snapshotId, newer.snapshot_id);
});

test('public snapshot revision mismatch is rejected without partially changing the release row', async () => {
  const { env } = await setup();
  const database = env.FEEDBACK_DB.database;
  database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  await persistPublicPortfolioSnapshot(env, 'us', 1, publicSnapshot(), {
    pf: 'us', ledgerRevision: 1, complete: true, fallback: false,
    ranAt: '2026-08-05T10:00:00.000Z',
  });
  const before = database.prepare(`
    SELECT * FROM ledger_public_snapshots WHERE portfolio_id = 'us'
  `).get();

  await assert.rejects(
    persistPublicPortfolioSnapshot(
      env,
      'us',
      2,
      publicSnapshot({
        revision: 2,
        snapshotId: 'portfolio-us-wrong-revision',
        updatedAt: '2026-08-05T10:10:00.000Z',
      }),
      {
        pf: 'us', ledgerRevision: 2, complete: true, fallback: false,
        ranAt: '2026-08-05T10:10:00.000Z',
      },
    ),
    error => error && error.status === 409 &&
      error.details && error.details.code === 'LEDGER_REVISION_CHANGED',
  );
  assert.deepEqual(
    database.prepare(`
      SELECT * FROM ledger_public_snapshots WHERE portfolio_id = 'us'
    `).get(),
    before,
  );
});

async function api(env, path, { method = 'GET', body } = {}) {
  const response = await handleLedgerAdminRequest(new Request('https://ledger.test' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }), env, { actor: 'test-admin' });
  return { status: response.status, body: await response.json() };
}

let automationSequence = 0;
async function createAndConfirm(env, event, confirmation = {}) {
  const manual = new Set(['BUY', 'SELL', 'CAPITAL']);
  const eventType = String(event.type || event.event_type || '').toUpperCase();
  automationSequence += 1;
  const created = manual.has(eventType)
    ? await api(env, '/api/admin/ledger/pending', {
        method: 'POST', body: { portfolio: 'us', event },
      })
    : await api(env, '/api/admin/ledger/source', {
        method: 'POST', body: {
          portfolio: 'us', sourceSystem: 'unit-test-automation', sourceAccount: 'test',
          sourceEventId: `${eventType}-${automationSequence}`, event,
          rawPayload: { eventType, sequence: automationSequence, event },
        },
      });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pending = created.body.item || created.body.pending;
  const confirmed = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: pending.pendingId,
      expectedVersion: pending.version,
      confirmation: { reason: 'unit test', ...confirmation },
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return confirmed.body;
}

async function freezeUsTape(env, revision, {
  from,
  through = from,
  calendarDates = [through],
  prices = [],
  parent = null,
} = {}) {
  const priceSource = 'tushare:us_daily:raw_close';
  return freezeLedgerPriceTape(env, 'us', {
    tapeFrom: from,
    tapeThrough: through,
    calendarFrom: calendarDates[0],
    calendarDates,
    requiredTickers: [...new Set(prices.map(row => row.ticker))],
    priceBasis: 'raw_close',
    adjusted: false,
    priceSource,
    calendarSource: 'tushare:us_tradecal',
    calendarSourceRef: 'https://tushare.pro/document/2?doc_id=253',
    parentPriceTapeId: parent && parent.priceTapeId,
    inheritedThrough: parent && parent.tapeThrough,
    priceRows: prices.map(row => ({
      ...row,
      source: priceSource,
      sourceRef: `us_daily:${row.ticker}:${row.date}`,
    })),
  }, revision);
}

function markCurrentDerivationDone(env, portfolio = 'us') {
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_outbox SET status = 'DONE', processed_at = 1
    WHERE portfolio_id = ? AND ledger_revision = (
      SELECT ledger_revision FROM ledger_portfolios WHERE portfolio_id = ?
    )
  `).run(portfolio, portfolio);
}

function legacyEvents() {
  return [
    {
      event_id: 'legacy_us_' + '1'.repeat(24), event_type: 'CAPITAL', sequence_no: 1,
      source_ref: 'Capital Record!3', tax_status: 'UNKNOWN_LEGACY',
      payload: {
        date: '2026-01-02', shareholder: 'LP1', subscription: 1000,
        redemption: 0, unit_price: 1, net_cash: 1000,
        gross_amount: null, tax_amount: null, fee_amount: null,
        tax_status: 'UNKNOWN_LEGACY',
      },
    },
    {
      event_id: 'legacy_us_' + '2'.repeat(24), event_type: 'BUY', sequence_no: 1,
      source_ref: 'ETF Stock Buy Record!3', tax_status: 'UNKNOWN_LEGACY',
      payload: {
        date: '2026-01-03', ticker: 'AAA', name: 'AAA Inc', quantity: 10,
        amount: 100, net_cash: -100, gross_amount: null,
        tax_amount: null, fee_amount: null, tax_status: 'UNKNOWN_LEGACY',
      },
    },
  ];
}

function historicalNavRows() {
  return [
    {
      date: '2026-01-02', currency: 'USD', cash: 1000, market_value: 0,
      total_assets: 1000, liability: 0, liability_asset_ratio: 0,
      net_value: 1000, units: 1000, unit_nav: 1,
      fund_action_adjustment: 0, source_sheet: 'NAV Statement', source_row: 3,
      valuation: { method: 'legacy_workbook' }, warnings: ['historical_seed'],
    },
    {
      date: '2026-01-03', currency: 'USD', cash: 900, market_value: 120,
      total_assets: 1020, liability: 20, liability_asset_ratio: 20 / 1020,
      net_value: 1000, units: 1000, unit_nav: 1,
      fund_action_adjustment: -2, source_sheet: 'NAV Statement', source_row: 4,
      valuation: { method: 'legacy_workbook', priced_positions: 1 }, warnings: [],
    },
  ];
}

async function signedReplacementFixture(env) {
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-03-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });
  await createAndConfirm(env, {
    type: 'BUY', date: '2026-03-02', ticker: 'AAA', name: 'AAA Inc', quantity: 10,
    Amount: '100.00', price: '9.50',
  });
  await createAndConfirm(env, {
    type: 'BUY', date: '2026-03-03', ticker: 'BBB', name: 'BBB Inc', quantity: 5,
    Amount: '50.00', price: '8.00',
  });
  await persistLedgerValuation(env, 'us', {
    date: '2026-03-03', cash: 850, marketValue: 150, totalAssets: 1000,
    liability: 0, netValue: 1000, units: 1000, unitNav: 1,
    source: 'TUSHARE', sourceRef: 'us_daily:replacement-fixture',
    valuation: { priceBasis: 'raw_close', adjusted: false }, warnings: [],
  }, [
    {
      ticker: 'AAA', date: '2026-03-03', close: 10,
      source: 'TUSHARE', sourceRef: 'us_daily:AAA:replacement-fixture',
      valuation: { priceBasis: 'raw_close', adjusted: false },
    },
    {
      ticker: 'BBB', date: '2026-03-03', close: 10,
      source: 'TUSHARE', sourceRef: 'us_daily:BBB:replacement-fixture',
      valuation: { priceBasis: 'raw_close', adjusted: false },
    },
  ], 3);
  await freezeUsTape(env, 3, {
    from: '2026-03-03',
    prices: [
      { ticker: 'AAA', date: '2026-03-03', close: 10 },
      { ticker: 'BBB', date: '2026-03-03', close: 10 },
    ],
  });
  markCurrentDerivationDone(env);
  const exported = await api(env, '/api/admin/ledger/export?portfolio=us');
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.ledgerRevision, 3);
  return {
    exported: exported.body,
    capital: exported.body.events.find(item => item.eventType === 'CAPITAL'),
    aaa: exported.body.events.find(item => item.event.ticker === 'AAA'),
    bbb: exported.body.events.find(item => item.event.ticker === 'BBB'),
  };
}

test('D1 ledger keeps Pending mutable, Confirm immutable, and Excel updates as superseding events', async () => {
  const { env } = await setup();

  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-01-02', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });

  const created = await api(env, '/api/admin/ledger/pending', {
    method: 'POST',
    body: {
      portfolio: 'us',
      event: {
        type: 'BUY', date: '2026-01-03', ticker: 'AAA', name: 'AAA Inc', quantity: 10,
        gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const pending = created.body.item;
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.event.status, 'pending');

  const updated = await api(env, '/api/admin/ledger/pending/update', {
    method: 'POST',
    body: {
      pendingId: pending.pendingId,
      expectedVersion: pending.version,
      event: { ...pending.event, notes: 'edited before confirm' },
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.item.version, 2);

  const confirmed = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: pending.pendingId,
      expectedVersion: 2,
      confirmation: { reason: 'checked trade' },
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.item.event.status, 'confirmed');
  assert.equal(confirmed.body.ledgerRevision, 2);

  const stale = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: { pendingId: pending.pendingId, expectedVersion: 2, confirmation: {} },
  });
  assert.equal(stale.status, 409);

  await persistLedgerValuation(env, 'us', {
    date: '2026-01-03', cash: 900, marketValue: 100, totalAssets: 1000,
    liability: 0, netValue: 1000, units: 1000, unitNav: 1,
    sourceRef: 'us_daily:raw-close',
    valuation: { priceBasis: 'raw_close', adjusted: false }, warnings: [],
  }, [{
    ticker: 'AAA', date: '2026-01-03', close: 10,
    source: 'TUSHARE', sourceRef: 'us_daily:AAA:raw-close',
    valuation: { priceBasis: 'raw_close', adjusted: false },
  }], 2);
  const tape2 = await freezeUsTape(env, 2, {
    from: '2026-01-03',
    prices: [{ ticker: 'AAA', date: '2026-01-03', close: 10 }],
  });
  markCurrentDerivationDone(env);

  const exported = await api(env, '/api/admin/ledger/export?portfolio=us');
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.events.length, 2);
  const originalBuy = exported.body.events.find(item => item.eventType === 'BUY');
  assert.ok(originalBuy);

  const changedBuy = {
    type: 'BUY', date: originalBuy.tradeDate,
    ticker: 'AAA', name: 'AAA Inc', quantity: 10,
    Amount: '120.00', price: null, notes: 'edited through Excel',
  };
  const preview = await api(env, '/api/admin/ledger/import/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', fileName: 'roundtrip.xlsx', uploadSha256: 'a'.repeat(64),
      exportId: exported.body.exportId, syncToken: exported.body.syncToken,
      baseLedgerRevision: exported.body.ledgerRevision,
      rows: [{
        sheetName: 'ETF Stock Buy Record', rowNumber: 3,
        lineageId: originalBuy.lineageId,
        eventVersion: originalBuy.eventVersion,
        event: changedBuy,
      }],
    },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.summary.UPDATE, 1, JSON.stringify(preview.body));
  const updateOperation = preview.body.operations.find(item => item.operation === 'UPDATE');

  const staged = await api(env, '/api/admin/ledger/import/confirm', {
    method: 'POST',
    body: {
      importId: preview.body.importId,
      expectedLedgerRevision: preview.body.currentLedgerRevision,
      selectedOperationIds: [updateOperation.operationId],
    },
  });
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  assert.equal(staged.body.staged, 1);

  const correctionList = await api(env, '/api/admin/ledger?portfolio=us&status=pending');
  assert.equal(correctionList.body.pending.length, 1);
  const correction = correctionList.body.pending[0];
  assert.equal(correction.baseEventId, originalBuy.eventId);
  assert.equal(correction.event.amount_minor, 12000);
  assert.equal(correction.event.net_cash_minor, -12000);
  assert.equal(correction.event.per_share, 12);
  assert.equal(correction.event.price, null);
  assert.equal(correction.event.tax_review_required, false);

  const corrected = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: correction.pendingId,
      expectedVersion: correction.version,
      confirmation: { reason: 'Excel Amount correction checked' },
    },
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.item.supersedesEventId, originalBuy.eventId);
  assert.equal(corrected.body.item.eventVersion, 2);
  assert.equal(corrected.body.item.event.amount_minor, 12000);
  assert.equal(corrected.body.item.event.net_cash_minor, -12000);
  assert.equal(corrected.body.item.event.per_share, 12);
  assert.equal(corrected.body.item.event.price, null);
  assert.equal(corrected.body.projection.cash.minor, 88000);

  await freezeUsTape(env, 3, {
    from: '2026-01-03',
    parent: tape2,
    prices: [{ ticker: 'AAA', date: '2026-01-03', close: 10 }],
  });
  await persistLedgerValuation(env, 'us', {
    date: '2026-01-03', cash: 880, marketValue: 100, totalAssets: 980,
    liability: 0, netValue: 980, units: 1000, unitNav: 0.98,
    sourceRef: 'us_daily:raw-close',
    valuation: { priceBasis: 'raw_close', adjusted: false }, warnings: [],
  }, [{
    ticker: 'AAA', date: '2026-01-03', close: 10,
    source: 'TUSHARE', sourceRef: 'us_daily:AAA:raw-close',
    valuation: { priceBasis: 'raw_close', adjusted: false },
  }], 3);
  markCurrentDerivationDone(env);
  await materializeLedgerKv(env, 'us', { expectedLedgerRevision: 3 });

  const finalList = await api(env, '/api/admin/ledger?portfolio=us&status=all');
  assert.equal(finalList.body.ledgerRevision, 3);
  assert.equal(finalList.body.events.length, 2);
  const finalBuy = finalList.body.events.find(item => item.eventType === 'BUY');
  assert.equal(finalBuy.event.net_cash_minor, -12000);
  assert.equal(finalList.body.projection.cash.minor, 88000);
  assert.equal(
    (await loadMaterializedLedgerProjection(env, 'us')).ledgerRevision,
    3,
  );
});

test('replaceAll atomically makes signed Excel the active ledger and preserves immutable history', async () => {
  const { env } = await setup();
  const database = env.FEEDBACK_DB.database;
  const { exported, capital, aaa, bbb } = await signedReplacementFixture(env);
  assert.ok(capital && aaa && bbb);

  const preview = await api(env, '/api/admin/ledger/import/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', fileName: 'full-ledger-replacement.xlsx',
      uploadSha256: 'e'.repeat(64),
      replaceAll: true,
      exportId: exported.exportId, syncToken: exported.syncToken,
      baseLedgerRevision: exported.ledgerRevision,
      rows: [
        {
          sheetName: 'Capital Record', rowNumber: 3,
          lineageId: capital.lineageId, eventVersion: capital.eventVersion,
          event: capital.event,
        },
        {
          sheetName: 'ETF Stock Buy Record', rowNumber: 3,
          lineageId: aaa.lineageId, eventVersion: aaa.eventVersion,
          event: {
            type: 'BUY', date: aaa.tradeDate, ticker: 'AAA', name: 'AAA Inc',
            quantity: 10, Amount: '120.00', price: null,
            notes: 'whole workbook replacement',
          },
        },
        {
          sheetName: 'ETF Stock Buy Record', rowNumber: 4,
          event: {
            type: 'BUY', date: '2026-03-04', ticker: 'CCC', name: 'CCC Inc',
            quantity: 2, Amount: '20.00', price: null,
          },
        },
      ],
    },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual({
    NOOP: preview.body.summary.NOOP,
    UPDATE: preview.body.summary.UPDATE,
    CREATE: preview.body.summary.CREATE,
    MISSING_IN_EXCEL: preview.body.summary.MISSING_IN_EXCEL,
  }, { NOOP: 1, UPDATE: 1, CREATE: 1, MISSING_IN_EXCEL: 1 });

  const unconfirmed = await api(env, '/api/admin/ledger/import/confirm', {
    method: 'POST',
    body: {
      importId: preview.body.importId,
      expectedLedgerRevision: preview.body.currentLedgerRevision,
      replaceAll: true,
    },
  });
  assert.equal(unconfirmed.status, 422, JSON.stringify(unconfirmed.body));
  assert.equal(unconfirmed.body.details.code, 'EXCEL_REPLACEMENT_CONFIRMATION_REQUIRED');
  assert.equal(database.prepare(
    'SELECT status FROM ledger_imports WHERE import_id = ?',
  ).get(preview.body.importId).status, 'PREVIEWED');

  const confirmed = await api(env, '/api/admin/ledger/import/confirm', {
    method: 'POST',
    body: {
      importId: preview.body.importId,
      expectedLedgerRevision: preview.body.currentLedgerRevision,
      replaceAll: true,
      confirmation: {
        replaceAll: true,
        reason: 'Signed workbook checked; replace the complete active ledger',
      },
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.replaceAll, true);
  assert.equal(confirmed.body.previousLedgerRevision, 3);
  assert.equal(confirmed.body.ledgerRevision, 6);
  assert.equal(confirmed.body.replaced, 2);
  assert.equal(confirmed.body.removed, 1);

  const rawEvents = database.prepare(`
    SELECT event_id, lineage_id, event_version, ledger_revision, event_type,
      payload_json, supersedes_event_id, reversal_of_event_id
    FROM ledger_events WHERE portfolio_id = 'us'
    ORDER BY ledger_revision
  `).all();
  assert.equal(rawEvents.length, 6);
  const oldAaa = rawEvents.find(row => row.event_id === aaa.eventId);
  const oldBbb = rawEvents.find(row => row.event_id === bbb.eventId);
  assert.ok(oldAaa);
  assert.ok(oldBbb);
  const newAaa = rawEvents.find(row => row.supersedes_event_id === aaa.eventId);
  assert.ok(newAaa);
  assert.equal(newAaa.lineage_id, aaa.lineageId);
  assert.equal(newAaa.event_version, 2);
  const bbbReversal = rawEvents.find(row => row.reversal_of_event_id === bbb.eventId);
  assert.ok(bbbReversal);
  assert.equal(bbbReversal.event_type, 'REVERSAL');

  const listed = await api(env, '/api/admin/ledger?portfolio=us&status=all');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.ledgerRevision, 6);
  assert.deepEqual(listed.body.events.map(item => ({
    type: item.eventType,
    ticker: item.event.ticker || null,
    amount: item.event.amount_minor ?? null,
  })), [
    { type: 'CAPITAL', ticker: null, amount: null },
    { type: 'BUY', ticker: 'AAA', amount: 12000 },
    { type: 'BUY', ticker: 'CCC', amount: 2000 },
  ]);
  const activeAaa = listed.body.events.find(item => item.event.ticker === 'AAA');
  const activeCcc = listed.body.events.find(item => item.event.ticker === 'CCC');
  assert.equal(activeAaa.event.per_share, 12);
  assert.equal(activeAaa.event.price, 9.5);
  assert.equal(activeCcc.event.per_share, 10);
  assert.equal(activeCcc.event.price, null);
  assert.equal(listed.body.events.reduce(
    (cash, item) => cash + Number(item.event.cash_change_minor || 0),
    0,
  ), 86000);

  const replacementOutbox = database.prepare(`
    SELECT ledger_revision, kind, status, payload_json
    FROM ledger_outbox WHERE ledger_revision > 3
    ORDER BY ledger_revision, kind
  `).all();
  assert.deepEqual(replacementOutbox.map(row => ({
    revision: row.ledger_revision, kind: row.kind, status: row.status,
  })), [
    { revision: 6, kind: 'REBUILD_EXCEL', status: 'PENDING' },
    { revision: 6, kind: 'REBUILD_KV', status: 'PENDING' },
    { revision: 6, kind: 'RECALC_NAV', status: 'PENDING' },
  ]);
  assert.ok(replacementOutbox.every(row =>
    JSON.parse(row.payload_json).replaceAll === true));
});

test('replaceAll fails closed when the ledger revision changes after preview', async () => {
  const { env } = await setup();
  const database = env.FEEDBACK_DB.database;
  const { exported, capital, aaa, bbb } = await signedReplacementFixture(env);

  const preview = await api(env, '/api/admin/ledger/import/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', fileName: 'stale-full-ledger.xlsx',
      uploadSha256: 'f'.repeat(64),
      replaceAll: true,
      exportId: exported.exportId, syncToken: exported.syncToken,
      baseLedgerRevision: exported.ledgerRevision,
      rows: [
        {
          sheetName: 'Capital Record', rowNumber: 3,
          lineageId: capital.lineageId, event: capital.event,
        },
        {
          sheetName: 'ETF Stock Buy Record', rowNumber: 3,
          lineageId: aaa.lineageId,
          event: { ...aaa.event, Amount: '110.00' },
        },
        {
          sheetName: 'ETF Stock Buy Record', rowNumber: 4,
          lineageId: bbb.lineageId, event: bbb.event,
        },
      ],
    },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.currentLedgerRevision, 3);

  await createAndConfirm(env, {
    type: 'BUY', date: '2026-03-05', ticker: 'DDD', name: 'DDD Inc', quantity: 1,
    Amount: '5.00',
  });
  const eventsBefore = database.prepare(
    "SELECT COUNT(*) AS count FROM ledger_events WHERE portfolio_id = 'us'",
  ).get().count;

  const stale = await api(env, '/api/admin/ledger/import/confirm', {
    method: 'POST',
    body: {
      importId: preview.body.importId,
      expectedLedgerRevision: preview.body.currentLedgerRevision,
      replaceAll: true,
      confirmation: { replaceAll: true, reason: 'This preview is now stale' },
    },
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.details.code, 'LEDGER_REVISION_CHANGED');
  assert.equal(database.prepare(
    'SELECT status FROM ledger_imports WHERE import_id = ?',
  ).get(preview.body.importId).status, 'STALE');
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM ledger_events WHERE portfolio_id = 'us'",
  ).get().count, eventsBefore);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_audit_log
    WHERE portfolio_id = 'us' AND action = 'EXCEL_LEDGER_REPLACED'
  `).get().count, 0);
});

test('replaceAll accepts one complete workbook above the retired 280-row batch limit', async () => {
  const { env } = await setup();
  const { exported } = await signedReplacementFixture(env);
  const rows = Array.from({ length: 281 }, (_, index) => ({
    sheetName: 'ETF Stock Buy Record',
    rowNumber: index + 3,
    event: {
      type: 'BUY',
      date: '2026-03-03',
      ticker: `NEW${index + 1}`,
      name: `New position ${index + 1}`,
      quantity: 1,
      Amount: '1.00',
      Price: '',
    },
  }));
  const preview = await api(env, '/api/admin/ledger/import/preview', {
    method: 'POST',
    body: {
      portfolio: 'us',
      fileName: 'complete-ledger-over-280.xlsx',
      uploadSha256: '9'.repeat(64),
      replaceAll: true,
      exportId: exported.exportId,
      syncToken: exported.syncToken,
      baseLedgerRevision: exported.ledgerRevision,
      rows,
    },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.summary.CREATE, 281);
  assert.equal(preview.body.replaceAll, true);
});

test('Confirm and replaceAll reject corporate actions with an invalid replayed source quantity', async () => {
  const missingEnv = (await setup()).env;
  const missing = await api(missingEnv, '/api/admin/ledger/source', {
    method: 'POST',
    body: {
      portfolio: 'us', sourceSystem: 'corporate-action-feed', sourceAccount: 'one',
      sourceEventId: 'missing-source-rename',
      event: {
        type: 'CORPORATE_ACTION', date: '2026-04-01', ticker: 'MISSING',
        action_type: 'RENAME', pre_quantity: 0,
        outputs: [{ ticker: 'NEW', quantity: 10 }],
      },
    },
  });
  assert.equal(missing.status, 201, JSON.stringify(missing.body));
  const missingConfirm = await api(missingEnv, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: missing.body.pending.pendingId,
      expectedVersion: missing.body.pending.version,
      confirmation: { reason: 'must not manufacture a holding' },
    },
  });
  assert.equal(missingConfirm.status, 422, JSON.stringify(missingConfirm.body));
  assert.match(missingConfirm.body.error, /確認後賬本校驗失敗/);
  assert.equal(missingEnv.FEEDBACK_DB.database.prepare(`
    SELECT ledger_revision FROM ledger_portfolios WHERE portfolio_id = 'us'
  `).get().ledger_revision, 0);
  assert.equal(missingEnv.FEEDBACK_DB.database.prepare(
    `SELECT COUNT(*) AS count FROM ledger_events`,
  ).get().count, 0);

  const { env } = await setup();
  await createAndConfirm(env, {
    type: 'BUY', date: '2026-04-01', ticker: 'AAA', name: 'AAA Inc',
    quantity: 10, amount: '100.00',
  });
  const stagedAction = await api(env, '/api/admin/ledger/source', {
    method: 'POST',
    body: {
      portfolio: 'us', sourceSystem: 'corporate-action-feed', sourceAccount: 'one',
      sourceEventId: 'valid-rename',
      event: {
        type: 'CORPORATE_ACTION', date: '2026-04-02', ticker: 'AAA',
        action_type: 'RENAME', pre_quantity: 10,
        outputs: [{ ticker: 'BBB', quantity: 10 }],
      },
    },
  });
  assert.equal(stagedAction.status, 201, JSON.stringify(stagedAction.body));
  const actionConfirmed = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: stagedAction.body.pending.pendingId,
      expectedVersion: stagedAction.body.pending.version,
      confirmation: { reason: 'verified rename quantities' },
    },
  });
  assert.equal(actionConfirmed.status, 200, JSON.stringify(actionConfirmed.body));

  await persistLedgerValuation(env, 'us', {
    date: '2026-04-03', cash: -100, marketValue: 100, totalAssets: 0,
    liability: 0, netValue: 0, units: 0, unitNav: null,
    source: 'TUSHARE', sourceRef: 'us_daily:corporate-action-guard',
    valuation: { priceBasis: 'raw_close', adjusted: false }, warnings: [],
  }, [{
    ticker: 'BBB', date: '2026-04-03', close: 10,
    source: 'TUSHARE', sourceRef: 'us_daily:BBB:corporate-action-guard',
    valuation: { priceBasis: 'raw_close', adjusted: false },
  }], 2);
  await freezeUsTape(env, 2, {
    from: '2026-04-03',
    prices: [{ ticker: 'BBB', date: '2026-04-03', close: 10 }],
  });
  markCurrentDerivationDone(env);
  const exported = await api(env, '/api/admin/ledger/export?portfolio=us');
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const buyEvent = exported.body.events.find(item => item.eventType === 'BUY');
  const corporateAction = exported.body.events.find(item => item.eventType === 'CORPORATE_ACTION');
  assert.ok(buyEvent && corporateAction);

  const preview = await api(env, '/api/admin/ledger/import/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', fileName: 'invalid-corporate-action-replacement.xlsx',
      uploadSha256: '7'.repeat(64), replaceAll: true,
      exportId: exported.body.exportId, syncToken: exported.body.syncToken,
      baseLedgerRevision: exported.body.ledgerRevision,
      rows: [
        {
          sheetName: 'ETF Stock Buy Record', rowNumber: 3,
          lineageId: buyEvent.lineageId, event: buyEvent.event,
        },
        {
          sheetName: 'Corporate Action Record', rowNumber: 3,
          lineageId: corporateAction.lineageId,
          event: {
            ...corporateAction.event,
            pre_quantity: 9,
            outputs: [{ ticker: 'BBB', quantity: 9 }],
          },
        },
      ],
    },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.summary.UPDATE, 1);
  const eventsBefore = env.FEEDBACK_DB.database.prepare(
    `SELECT COUNT(*) AS count FROM ledger_events WHERE portfolio_id = 'us'`,
  ).get().count;
  const replacement = await api(env, '/api/admin/ledger/import/confirm', {
    method: 'POST',
    body: {
      importId: preview.body.importId,
      expectedLedgerRevision: preview.body.currentLedgerRevision,
      replaceAll: true,
      confirmation: { replaceAll: true, reason: 'attempt invalid pre-quantity' },
    },
  });
  assert.equal(replacement.status, 422, JSON.stringify(replacement.body));
  assert.match(replacement.body.error, /替換後校驗失敗/);
  assert.equal(env.FEEDBACK_DB.database.prepare(
    `SELECT COUNT(*) AS count FROM ledger_events WHERE portfolio_id = 'us'`,
  ).get().count, eventsBefore);
  assert.equal(env.FEEDBACK_DB.database.prepare(`
    SELECT ledger_revision FROM ledger_portfolios WHERE portfolio_id = 'us'
  `).get().ledger_revision, 2);
});

test('automation source idempotency rejects the same source key with changed content', async () => {
  const { env } = await setup();
  const base = {
    portfolio: 'us',
    sourceSystem: 'broker-api',
    sourceAccount: 'account-1',
    sourceEventId: 'dividend-2026-001',
    event: {
      type: 'DIVIDEND', date: '2026-01-03', ticker: 'AAA', name: 'AAA Inc', quantity: 10,
      gross_amount: '10.00', tax_amount: '0', fee_amount: '0', net_cash: '10.00',
    },
    rawPayload: { dividendId: 'dividend-2026-001', amount: '10.00' },
  };

  const first = await api(env, '/api/admin/ledger/source', { method: 'POST', body: base });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.duplicate, false);

  const duplicate = await api(env, '/api/admin/ledger/source', { method: 'POST', body: base });
  assert.equal(duplicate.status, 201, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.duplicate, true);

  const conflict = await api(env, '/api/admin/ledger/source', {
    method: 'POST',
    body: {
      ...base,
      rawPayload: { dividendId: 'dividend-2026-001', amount: '11.00' },
    },
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.details.code, 'SOURCE_PAYLOAD_CONFLICT');
  assert.equal(env.FEEDBACK_DB.database.prepare('SELECT COUNT(*) AS count FROM ledger_source_records').get().count, 1);
  assert.equal(env.FEEDBACK_DB.database.prepare('SELECT COUNT(*) AS count FROM ledger_pending').get().count, 1);
});

test('manual creation is limited to trades and capital while automation facts enter Pending', async () => {
  const { env } = await setup();
  const event = {
    type: 'DIVIDEND', date: '2026-01-02', ticker: 'AAA', quantity: 1,
    gross_amount: '1.00', tax_amount: '0', fee_amount: '0', net_cash: '1.00',
  };
  const manual = await api(env, '/api/admin/ledger/pending', {
    method: 'POST', body: { portfolio: 'us', event },
  });
  assert.equal(manual.status, 422);
  assert.match(manual.body.error, /人工新增只允許/);

  const spoofed = await api(env, '/api/admin/ledger/pending', {
    method: 'POST', body: { portfolio: 'us', event, source: 'AUTOMATION' },
  });
  assert.equal(spoofed.status, 422, JSON.stringify(spoofed.body));

  const automated = await api(env, '/api/admin/ledger/source', {
    method: 'POST', body: {
      portfolio: 'us', sourceSystem: 'custodian', sourceAccount: 'one',
      sourceEventId: 'div-1', event, rawPayload: event,
    },
  });
  assert.equal(automated.status, 201, JSON.stringify(automated.body));
  assert.equal(automated.body.pending.source, 'AUTOMATION');

  const forbiddenTrade = await api(env, '/api/admin/ledger/source', {
    method: 'POST', body: {
      portfolio: 'us', sourceSystem: 'broker', sourceAccount: 'one',
      sourceEventId: 'buy-1',
      event: { type: 'BUY', date: '2026-01-02', ticker: 'AAA', quantity: 1, amount: 1 },
    },
  });
  assert.equal(forbiddenTrade.status, 422);
});

test('future-dated events remain Pending and cannot be confirmed early', async () => {
  const { env } = await setup();
  const created = await api(env, '/api/admin/ledger/pending', {
    method: 'POST',
    body: {
      portfolio: 'us',
      event: {
        type: 'CAPITAL', date: '2099-01-01', shareholder: 'LP1',
        subscription: '1000.00', redemption: '0', unit_price: '1.00',
      },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const confirmed = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: created.body.item.pendingId,
      expectedVersion: created.body.item.version,
      confirmation: { reason: 'too early' },
    },
  });
  assert.equal(confirmed.status, 422, JSON.stringify(confirmed.body));
  assert.match(confirmed.body.error, /Pending/);
  const row = env.FEEDBACK_DB.database.prepare(
    'SELECT status, version FROM ledger_pending WHERE pending_id = ?',
  ).get(created.body.item.pendingId);
  assert.deepEqual({ ...row }, { status: 'PENDING', version: 1 });
  assert.equal(env.FEEDBACK_DB.database.prepare(
    "SELECT ledger_revision FROM ledger_portfolios WHERE portfolio_id = 'us'",
  ).get().ledger_revision, 0);
});

test('legacy migration is previewed and atomically signed into immutable events', async () => {
  const { env } = await setup();
  const sourceWorkbookSha256 = 'b'.repeat(64);
  const events = legacyEvents();
  const preview = await api(env, '/api/admin/ledger/migration/preview', {
    method: 'POST', body: {
      portfolio: 'us', sourceWorkbookSha256, events,
      historical_nav_rows: [], historical_price_rows: [],
    },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.eventCount, 2);
  assert.equal(preview.body.unknownTaxEvents, undefined);
  assert.equal(preview.body.lowestCashMinor, 90000);
  assert.equal(preview.body.historicalNavRowCount, 0);
  assert.equal(preview.body.historicalPriceRowCount, 0);
  assert.equal(preview.body.historicalNavDateRange, null);
  assert.match(preview.body.navSeedHash, /^[a-f0-9]{64}$/);

  const retryPreview = await api(env, '/api/admin/ledger/migration/preview', {
    method: 'POST', body: {
      portfolio: 'us', sourceWorkbookSha256, events,
      historical_nav_rows: [], historical_price_rows: [],
    },
  });
  assert.equal(retryPreview.status, 200, JSON.stringify(retryPreview.body));
  assert.equal(retryPreview.body.duplicateUpload, true);
  assert.equal(retryPreview.body.importStatus, 'PREVIEWED');
  assert.equal(retryPreview.body.importId, preview.body.importId);
  assert.equal(retryPreview.body.migrationHash, preview.body.migrationHash);
  assert.equal(env.FEEDBACK_DB.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_imports
    WHERE portfolio_id = 'us' AND upload_sha256 = ?
  `).get(sourceWorkbookSha256).count, 1);

  const confirmed = await api(env, '/api/admin/ledger/migration/confirm', {
    method: 'POST',
    body: {
      importId: preview.body.importId,
      migrationHash: preview.body.migrationHash,
      acknowledgement: {
        phrase: 'CONFIRM LEGACY US', duplicates: true,
      },
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.ledgerRevision, 2);
  assert.equal(confirmed.body.historicalNavRowCount, 0);
  assert.equal(confirmed.body.historicalPriceRowCount, 0);

  const storedNav = env.FEEDBACK_DB.database.prepare(`
    SELECT * FROM ledger_nav_snapshots
    WHERE portfolio_id = 'us' ORDER BY nav_date
  `).all();
  assert.equal(storedNav.length, 0);

  await freezeUsTape(env, 2, {
    from: '2026-01-05',
    prices: [{ ticker: 'AAA', date: '2026-01-05', close: 12 }],
  });
  await persistLedgerValuation(env, 'us', {
    date: '2026-01-05', cash: 900, marketValue: 120, totalAssets: 1020,
    liability: 0, netValue: 1020, units: 1000, unitNav: 1.02,
    source: 'TUSHARE', sourceRef: 'us_daily:raw-close',
    valuation: { source: 'TUSHARE', priceBasis: 'raw_close', adjusted: false }, warnings: [],
  }, [{
    ticker: 'AAA', date: '2026-01-05', close: 12, source: 'TUSHARE',
    valuation: { priceBasis: 'raw_close', adjusted: false },
  }], 2);
  markCurrentDerivationDone(env);

  const listed = await api(env, '/api/admin/ledger?portfolio=us&status=all');
  assert.equal(listed.body.events.length, 2);
  assert.equal(listed.body.projection.cash.minor, 90000);
  assert.equal(listed.body.navRows.length, 1);
  assert.deepEqual(listed.body.projection.nav_rows, listed.body.navRows);
  assert.ok(listed.body.events.every(item => item.event.tax_status === 'UNKNOWN_LEGACY'));
});

test('legacy migration rejects all derived NAV and price seeds', async () => {
  const sourceWorkbookSha256 = 'c'.repeat(64);
  const baseRows = historicalNavRows();
  const { env } = await setup();
  const navSeed = await api(env, '/api/admin/ledger/migration/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', sourceWorkbookSha256, events: legacyEvents(),
      historicalNavRows: baseRows,
    },
  });
  assert.equal(navSeed.status, 422, JSON.stringify(navSeed.body));
  assert.equal(navSeed.body.details.code, 'LEGACY_DERIVED_SEED_FORBIDDEN');

  const priceSeed = await api(env, '/api/admin/ledger/migration/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', sourceWorkbookSha256: 'd'.repeat(64), events: legacyEvents(),
      historicalPriceRows: [{
        ticker: 'AAA', date: '2026-01-05', price: 12, quantity: 10,
        market_value: 120, currency: 'USD',
      }],
    },
  });
  assert.equal(priceSeed.status, 422, JSON.stringify(priceSeed.body));
  assert.equal(priceSeed.body.details.code, 'LEGACY_DERIVED_SEED_FORBIDDEN');
});

test('Excel export serves one coherent last-complete snapshot while the current revision is pending', async () => {
  const { env } = await setup();
  const database = env.FEEDBACK_DB.database;

  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });
  await createAndConfirm(env, {
    type: 'BUY', date: '2026-02-02', ticker: 'AAA', name: 'AAA Inc', quantity: 10,
    gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
  });

  const frozenNavRow = {
    date: '2026-02-02', currency: 'USD', totalAssets: 1020, liability: 0,
    liabilityAssetRatio: 0, netValue: 1020, units: 1000,
    unitNav: 1.02, nav: 1.02, fundActionAdjustment: 0,
    cash: 900, marketValue: 120, ledgerRevision: 2,
    source: 'TUSHARE', sourceRef: 'us_daily:revision-2-complete',
    sourceWorkbookSha256: null, sourceRow: null,
    valuation: { priceBasis: 'raw_close', adjusted: false },
    warnings: [], recalculationRequired: false,
  };
  await persistLedgerValuation(env, 'us', {
    date: frozenNavRow.date, cash: frozenNavRow.cash,
    marketValue: frozenNavRow.marketValue, totalAssets: frozenNavRow.totalAssets,
    liability: frozenNavRow.liability, netValue: frozenNavRow.netValue,
    units: frozenNavRow.units, unitNav: frozenNavRow.unitNav,
    source: frozenNavRow.source, sourceRef: frozenNavRow.sourceRef,
    valuation: frozenNavRow.valuation, warnings: frozenNavRow.warnings,
  }, [{
    ticker: 'AAA', date: frozenNavRow.date, close: 12,
    source: 'TUSHARE', sourceRef: 'us_daily:AAA:revision-2-complete',
    valuation: { priceBasis: 'raw_close', adjusted: false },
  }], 2);
  await freezeUsTape(env, 2, {
    from: frozenNavRow.date,
    prices: [{ ticker: 'AAA', date: frozenNavRow.date, close: 12 }],
  });
  markCurrentDerivationDone(env);
  await materializeLedgerKv(env, 'us', { expectedLedgerRevision: 2 });
  await persistPublicPortfolioSnapshot(env, 'us', 2, {
    ...publicSnapshot({
      revision: 2,
      snapshotId: 'portfolio-us-revision-2-complete',
      asOf: frozenNavRow.date,
      updatedAt: '2026-02-02T22:00:00.000Z',
    }),
    source: 'portfolio-ledger',
    freshness_class: 'eod',
    freshness: { class: 'eod', stale: false, fallback: null },
    base: {
      date: frozenNavRow.date, cash: 900, marketValue: 120,
      totalAssets: 1020, liability: 0, netValue: 1020,
      units: 1000, unitNav: 1.02,
    },
    navRows: [frozenNavRow],
    holdings: [{
      t: 'AAA', n: 'AAA Inc', q: 10, price: 12, marketValue: 120,
      date: frozenNavRow.date, priceBasis: 'raw_close', adjusted: false,
    }],
  }, {
    pf: 'us', ledgerRevision: 2, complete: true, fallback: false,
    ranAt: '2026-02-02T22:00:00.000Z',
  });

  // Revision 3 is confirmed but its derived work is still pending. Simulate a
  // partial recalculation overwriting mutable same-day NAV/price rows. None of
  // these values may leak into the revision-2 Excel export.
  await createAndConfirm(env, {
    type: 'BUY', date: '2026-02-02', ticker: 'BBB', name: 'BBB Inc', quantity: 1,
    gross_amount: '50.00', tax_amount: '0', fee_amount: '0', net_cash: '-50.00',
  });
  await persistLedgerValuation(env, 'us', {
    date: frozenNavRow.date, cash: 850, marketValue: 1040, totalAssets: 1890,
    liability: 0, netValue: 1890, units: 1000, unitNav: 1.89,
    source: 'PARTIAL_RECALCULATION', sourceRef: 'revision-3-must-not-export',
    valuation: { priceBasis: 'raw_close', adjusted: false, partial: true },
    warnings: ['revision-3-partial'],
  }, [{
    ticker: 'AAA', date: frozenNavRow.date, close: 99,
    source: 'TUSHARE', sourceRef: 'revision-3-must-not-export',
    valuation: { priceBasis: 'raw_close', adjusted: false, partial: true },
  }], 3);

  const lastComplete = await loadMaterializedLedgerProjection(env, 'us');
  assert.equal(lastComplete.ledgerRevision, 2);
  assert.equal(lastComplete.projection.valuationReady, true);
  assert.deepEqual(lastComplete.projection.navRows, [frozenNavRow]);
  assert.deepEqual(lastComplete.projection.positions.map(row => ({
    ticker: row.t, basis: row.priceBasis, adjusted: row.priceAdjusted,
  })), [{ ticker: 'AAA', basis: 'raw_close', adjusted: false }]);

  const exported = await api(env, '/api/admin/ledger/export?portfolio=us');
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.ledgerRevision, 2);
  assert.equal(exported.body.servedRevision, 2);
  assert.equal(exported.body.targetRevision, 3);
  assert.equal(exported.body.fallback, true);
  assert.deepEqual(exported.body.navRows, [frozenNavRow]);
  assert.deepEqual(exported.body.projection.nav_rows, [frozenNavRow]);
  assert.deepEqual(exported.body.events.map(item => ({
    revision: item.ledgerRevision,
    type: item.eventType,
    ticker: item.event.ticker || null,
  })), [
    { revision: 1, type: 'CAPITAL', ticker: null },
    { revision: 2, type: 'BUY', ticker: 'AAA' },
  ]);
  assert.deepEqual(exported.body.priceRows.map(row => ({
    ticker: row.ticker, date: row.date, price: row.price,
  })), [{ ticker: 'AAA', date: frozenNavRow.date, price: 12 }]);
  assert.deepEqual(exported.body.projection.positions.map(row => ({
    ticker: row.ticker, quantity: row.quantity, price: row.latest_price,
  })), [{ ticker: 'AAA', quantity: 10, price: 12 }]);

  const storedExport = database.prepare(`
    SELECT ledger_revision, snapshot_json
    FROM ledger_exports WHERE export_id = ?
  `).get(exported.body.exportId);
  assert.equal(storedExport.ledger_revision, 2);
  const signedSnapshot = JSON.parse(storedExport.snapshot_json);
  assert.equal(signedSnapshot.ledgerRevision, 2);
  assert.equal(Object.values(signedSnapshot.events).length, 2);
  assert.equal(Object.values(signedSnapshot.events).some(item =>
    item.event && item.event.ticker === 'BBB'), false);
});

test('valuation persistence UPSERTs same-day NAV and prices under a ledger revision guard', async () => {
  const { env } = await setup();
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });

  const first = await persistLedgerValuation(env, 'us', {
    date: '2026-02-02', cash: 1000, marketValue: 500, totalAssets: 1500,
    liability: 100, netValue: 1400, units: 1000, unitNav: 1.4,
    sourceRef: 'tushare:first-close', valuation: { priced: 1 }, warnings: ['first'],
  }, [
    { ticker: 'aaa', close: 50, source: 'TUSHARE', sourceRef: 'daily:AAA' },
  ], 1);
  assert.equal(first.date, '2026-02-02');
  assert.equal(first.ledgerRevision, 1);
  assert.equal(first.unitNav, 1.4);

  const second = await persistLedgerValuation(env, 'us', {
    date: '2026-02-02', cash: 950, marketValue: 650, totalAssets: 1600,
    liability: 100, netValue: 1500, units: 1000, unitNav: 1.5,
    sourceRef: 'tushare:corrected-close', valuation: { priced: 2 }, warnings: [],
  }, [
    { ticker: 'AAA', close: 55.5, source: 'TUSHARE', sourceRef: 'daily:AAA:v2' },
    { ticker: 'BBB', close: 20, source: 'TUSHARE', sourceRef: 'daily:BBB' },
  ], 1);
  assert.equal(second.unitNav, 1.5);
  assert.equal(second.marketValue, 650);

  const storedNav = env.FEEDBACK_DB.database.prepare(`
    SELECT * FROM ledger_nav_snapshots WHERE portfolio_id = 'us'
  `).all();
  assert.equal(storedNav.length, 1);
  assert.equal(storedNav[0].ledger_revision, 1);
  assert.equal(storedNav[0].cash_minor, 95000);
  assert.equal(storedNav[0].market_value_minor, 65000);
  assert.equal(storedNav[0].unit_nav_micros, 1_500_000);
  assert.equal(storedNav[0].source, 'TUSHARE');
  assert.equal(storedNav[0].source_ref, 'tushare:corrected-close');
  assert.deepEqual(JSON.parse(storedNav[0].valuation_json), { priced: 2 });

  const prices = env.FEEDBACK_DB.database.prepare(`
    SELECT * FROM ledger_prices
    WHERE portfolio_id = 'us' ORDER BY ticker
  `).all();
  assert.deepEqual(prices.map(row => ({
    ticker: row.ticker,
    date: row.price_date,
    revision: row.ledger_revision,
    price: row.price_micros,
    source: row.source,
    sourceRef: row.source_ref,
  })), [
    {
      ticker: 'AAA', date: '2026-02-02', revision: 1,
      price: 55_500_000, source: 'TUSHARE', sourceRef: 'daily:AAA:v2',
    },
    {
      ticker: 'BBB', date: '2026-02-02', revision: 1,
      price: 20_000_000, source: 'TUSHARE', sourceRef: 'daily:BBB',
    },
  ]);

  await assert.rejects(
    persistLedgerValuation(env, 'us', {
      date: '2026-02-03', cash: 900, marketValue: 600, totalAssets: 1500,
      liability: 100, netValue: 1400, units: 1000, unitNav: 1.4,
    }, [{ ticker: 'AAA', close: 60 }], 0),
    error => {
      assert.equal(error.status, 409);
      assert.match(error.message, /revision/);
      return true;
    },
  );
  assert.equal(env.FEEDBACK_DB.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_nav_snapshots
  `).get().count, 1);
  assert.equal(env.FEEDBACK_DB.database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_transaction_guards
  `).get().count, 0);

  await freezeUsTape(env, 1, {
    from: '2026-02-02',
    prices: [
      { ticker: 'AAA', date: '2026-02-02', close: 55.5 },
      { ticker: 'BBB', date: '2026-02-02', close: 20 },
    ],
  });
  markCurrentDerivationDone(env);

  const exported = await api(env, '/api/admin/ledger/export?portfolio=us');
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.navRows.length, 1);
  assert.deepEqual(exported.body.projection.nav_rows, exported.body.navRows);
  assert.deepEqual(exported.body.projection.nav_rows[0], {
    date: '2026-02-02', currency: 'USD', totalAssets: 1600, liability: 100,
    liabilityAssetRatio: 0.0625, netValue: 1500, units: 1000,
    unitNav: 1.5, nav: 1.5, fundActionAdjustment: 0,
    cash: 950, marketValue: 650, ledgerRevision: 1,
    source: 'TUSHARE', sourceRef: 'tushare:corrected-close',
    sourceWorkbookSha256: null, sourceRow: null,
    valuation: { priced: 2 }, warnings: [], recalculationRequired: false,
  });
});

test('price-enriched projection preserves the Python nominal and exposure return formulas', async () => {
  const { env } = await setup();
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });
  await createAndConfirm(env, {
    type: 'BUY', date: '2026-02-02', ticker: 'AAA', name: 'AAA Inc', quantity: 10,
    gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
  });
  await createAndConfirm(env, {
    type: 'SELL', date: '2026-02-03', ticker: 'AAA', name: 'AAA Inc', quantity: 2,
    gross_amount: '30.00', tax_amount: '0', fee_amount: '0', net_cash: '30.00',
  });
  await createAndConfirm(env, {
    type: 'DIVIDEND', date: '2026-02-04', ticker: 'AAA', name: 'AAA Inc', quantity: 8,
    gross_amount: '4.00', tax_amount: '0', fee_amount: '0', net_cash: '4.00',
    // Production legacy rows can retain more precision than the Excel-visible
    // derived per-share value. This must not make an untouched export an UPDATE.
    price: 0.500000000123,
  });

  await persistLedgerValuation(env, 'us', {
    date: '2026-02-05', cash: 934, marketValue: 96, totalAssets: 1030,
    liability: 0, netValue: 1030, units: 1000, unitNav: 1.03,
    sourceRef: 'tushare:python-parity',
    valuation: { priced: 1, priceBasis: 'raw_close', adjusted: false }, warnings: [],
  }, [{
    ticker: 'AAA', close: 12, source: 'TUSHARE', sourceRef: 'daily:AAA',
    valuation: { priceBasis: 'raw_close', adjusted: false },
  }], 4);

  await freezeUsTape(env, 4, {
    from: '2026-02-05',
    prices: [{ ticker: 'AAA', date: '2026-02-05', close: 12 }],
  });
  markCurrentDerivationDone(env);

  const exported = await api(env, '/api/admin/ledger/export?portfolio=us');
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  const position = exported.body.projection.positions[0];
  assert.equal(position.total_buy_cost, 100);
  assert.equal(position.total_sell_proceeds, 30);
  assert.equal(position.dividend_income, 4);
  assert.equal(position.net_cost, 70);
  assert.equal(position.total_pnl, 30);
  assert.equal(position.average_cost, 8.75);
  assert.ok(Math.abs(position.nominal_return - (12 - 8.75) / 8.75) < 1e-12);
  assert.ok(Math.abs(position.exposure_return - 0.3) < 1e-12);

  const dividend = exported.body.events.find(item => item.eventType === 'DIVIDEND');
  assert.ok(dividend);
  assert.equal(dividend.event.price, 0.500000000123);
  assert.equal(dividend.event.per_share, 0.5);
  const roundtrip = await api(env, '/api/admin/ledger/import/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', fileName: 'dividend-roundtrip.xlsx',
      uploadSha256: 'd'.repeat(64), exportId: exported.body.exportId,
      syncToken: exported.body.syncToken,
      baseLedgerRevision: exported.body.ledgerRevision,
      rows: [{
        sheetName: 'ETF Stock Dividend Record', rowNumber: 3,
        lineageId: dividend.lineageId, eventVersion: dividend.eventVersion,
        // The workbook parser intentionally recomputes dividend price from
        // Amount / quantity at its visible eight-decimal precision.
        event: { ...dividend.event, price: null },
      }],
    },
  });
  assert.equal(roundtrip.status, 200, JSON.stringify(roundtrip.body));
  const dividendOperation = roundtrip.body.operations.find(item =>
    item.lineageId === dividend.lineageId);
  assert.equal(dividendOperation.operation, 'NOOP', JSON.stringify(dividendOperation));

  const changedQuantity = await api(env, '/api/admin/ledger/import/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', fileName: 'dividend-quantity-edit.xlsx',
      uploadSha256: 'e'.repeat(64), exportId: exported.body.exportId,
      syncToken: exported.body.syncToken,
      baseLedgerRevision: exported.body.ledgerRevision,
      rows: [{
        sheetName: 'ETF Stock Dividend Record', rowNumber: 3,
        lineageId: dividend.lineageId, eventVersion: dividend.eventVersion,
        event: { ...dividend.event, quantity: 9, price: null },
      }],
    },
  });
  assert.equal(changedQuantity.status, 200, JSON.stringify(changedQuantity.body));
  assert.equal(changedQuantity.body.operations.find(item =>
    item.lineageId === dividend.lineageId).operation, 'UPDATE');

  const buy = exported.body.events.find(item => item.eventType === 'BUY');
  const changedBuyPrice = await api(env, '/api/admin/ledger/import/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', fileName: 'buy-price-edit.xlsx',
      uploadSha256: 'f'.repeat(64), exportId: exported.body.exportId,
      syncToken: exported.body.syncToken,
      baseLedgerRevision: exported.body.ledgerRevision,
      rows: [{
        sheetName: 'ETF Stock Buy Record', rowNumber: 3,
        lineageId: buy.lineageId, eventVersion: buy.eventVersion,
        event: { ...buy.event, price: Number(buy.event.price) + 1 },
      }],
    },
  });
  assert.equal(changedBuyPrice.status, 200, JSON.stringify(changedBuyPrice.body));
  assert.equal(changedBuyPrice.body.operations.find(item =>
    item.lineageId === buy.lineageId).operation, 'UPDATE');
});

test('D1 action-date prices never allocate cash-derived corporate action cost', async () => {
  const { env } = await setup();
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });
  await createAndConfirm(env, {
    type: 'BUY', date: '2026-02-02', ticker: 'SPGI', quantity: 10,
    gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
  });
  await persistLedgerValuation(env, 'us', {
    date: '2026-02-03', cash: 900, marketValue: 4200, totalAssets: 5100,
    liability: 0, netValue: 5100, units: 1000, unitNav: 5.1,
    sourceRef: 'action-date-prices', valuation: {}, warnings: [],
  }, [
    { ticker: 'SPGI', date: '2026-02-03', close: 400, source: 'TUSHARE' },
    { ticker: 'MBGL', date: '2026-02-03', close: 20, source: 'TUSHARE' },
  ], 2);
  const confirmed = await createAndConfirm(env, {
    type: 'CORPORATE_ACTION', date: '2026-02-03', ticker: 'SPGI',
    corporate_action_type: 'SPINOFF', quantity: 10,
    post_ticker: '[SPGI,MBGL]', post_quantity: '[10,10]', cash_change: '0',
  });
  assert.equal(confirmed.projection.cash_chain.length, 2);
  const positions = new Map(confirmed.projection.positions.map(row => [row.ticker, row]));
  assert.equal(positions.get('SPGI').buy_cost_minor, 10000);
  assert.equal(positions.get('MBGL').buy_cost_minor, 0);
  assert.equal(positions.get('SPGI').total_shares_bought, 10);
  assert.equal(positions.get('MBGL').total_shares_bought, 0);
  assert.equal(confirmed.projection.checks.some(check =>
    check.code === 'CORPORATE_ACTION_PRICE_FALLBACK'), false);
});

test('admin derived rebuild requeues the current revision idempotently without changing events', async () => {
  const { env } = await setup();
  const missingPortfolio = await api(env, '/api/admin/ledger/rebuild', {
    method: 'POST', body: { reason: 'must not default to a portfolio' },
  });
  assert.equal(missingPortfolio.status, 422);
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });
  await createAndConfirm(env, {
    type: 'BUY', date: '2026-02-03', ticker: 'AAA', quantity: 10,
    gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
  });

  const database = env.FEEDBACK_DB.database;
  const beforePortfolio = database.prepare(`
    SELECT ledger_revision FROM ledger_portfolios WHERE portfolio_id = 'us'
  `).get();
  const beforeEvents = database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_events WHERE portfolio_id = 'us'
  `).get();
  const stagedTape = await freezeUsTape(env, beforePortfolio.ledger_revision, {
    from: '2026-02-01',
    through: '2026-02-03',
    calendarDates: ['2026-02-01', '2026-02-03'],
    prices: [{ ticker: 'AAA', date: '2026-02-03', close: 10 }],
  });
  database.prepare(`
    UPDATE ledger_outbox
    SET status = 'DONE', attempts = 7, last_error = 'old failure', processed_at = 123456
    WHERE portfolio_id = 'us' AND ledger_revision = ?
  `).run(beforePortfolio.ledger_revision);
  const originalIds = database.prepare(`
    SELECT kind, outbox_id FROM ledger_outbox
    WHERE portfolio_id = 'us' AND ledger_revision = ?
    ORDER BY kind
  `).all(beforePortfolio.ledger_revision);

  const first = await api(env, '/api/admin/ledger/rebuild', {
    method: 'POST', body: { portfolio: 'us', reason: 'raw price tape repair' },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ledgerRevision, beforePortfolio.ledger_revision);
  assert.equal(first.body.affectedFrom, '2026-02-01');
  assert.equal(first.body.discardedPriceTapeId, stagedTape.priceTapeId);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_price_tapes
    WHERE portfolio_id = 'us' AND ledger_revision = ?
  `).get(beforePortfolio.ledger_revision).count, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_price_tape_rows WHERE price_tape_id = ?
  `).get(stagedTape.priceTapeId).count, 0);

  const resetRows = database.prepare(`
    SELECT kind, outbox_id, payload_json, status, attempts, last_error, processed_at
    FROM ledger_outbox
    WHERE portfolio_id = 'us' AND ledger_revision = ?
    ORDER BY kind
  `).all(beforePortfolio.ledger_revision);
  assert.deepEqual(resetRows.map(row => row.kind), [
    'REBUILD_EXCEL', 'REBUILD_KV', 'RECALC_NAV',
  ]);
  assert.deepEqual(resetRows.map(row => row.outbox_id), originalIds.map(row => row.outbox_id));
  assert.ok(resetRows.every(row => row.status === 'PENDING'));
  assert.ok(resetRows.every(row => row.attempts === 0));
  assert.ok(resetRows.every(row => row.last_error === null));
  assert.ok(resetRows.every(row => row.processed_at === null));
  for (const row of resetRows) {
    assert.deepEqual(JSON.parse(row.payload_json), {
      affectedFrom: '2026-02-01', probeEod: true,
      reason: 'raw price tape repair',
    });
  }

  const second = await api(env, '/api/admin/ledger/rebuild', {
    method: 'POST', body: { portfolio: 'us', reason: 'repeat safely' },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const afterPortfolio = database.prepare(`
    SELECT ledger_revision FROM ledger_portfolios WHERE portfolio_id = 'us'
  `).get();
  const afterEvents = database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_events WHERE portfolio_id = 'us'
  `).get();
  const afterOutbox = database.prepare(`
    SELECT kind, outbox_id, payload_json, status, attempts, last_error, processed_at
    FROM ledger_outbox
    WHERE portfolio_id = 'us' AND ledger_revision = ?
    ORDER BY kind
  `).all(beforePortfolio.ledger_revision);
  assert.equal(afterPortfolio.ledger_revision, beforePortfolio.ledger_revision);
  assert.equal(afterEvents.count, beforeEvents.count);
  assert.equal(afterOutbox.length, 3);
  assert.deepEqual(afterOutbox.map(row => row.outbox_id), originalIds.map(row => row.outbox_id));
  assert.ok(afterOutbox.every(row => row.status === 'PENDING' && row.attempts === 0));
  assert.ok(afterOutbox.every(row => row.last_error === null && row.processed_at === null));
  assert.ok(afterOutbox.every(row => JSON.parse(row.payload_json).probeEod === true));
  assert.ok(afterOutbox.every(row => JSON.parse(row.payload_json).reason === 'repeat safely'));

  const audits = database.prepare(`
    SELECT actor_type, actor_ref, action, target_type, target_id, after_json, metadata_json
    FROM ledger_audit_log
    WHERE portfolio_id = 'us' AND action = 'DERIVED_REBUILD_REQUESTED'
    ORDER BY created_at, audit_id
  `).all();
  assert.equal(audits.length, 2);
  assert.ok(audits.every(row => row.actor_type === 'ADMIN'));
  assert.ok(audits.every(row => row.actor_ref === 'test-admin'));
  assert.ok(audits.every(row => row.target_type === 'PORTFOLIO' && row.target_id === 'us'));
  const auditByReason = new Map(audits.map(row => [JSON.parse(row.metadata_json).reason, row]));
  assert.deepEqual(JSON.parse(auditByReason.get('raw price tape repair').after_json), {
    affectedFrom: '2026-02-01',
    kinds: ['RECALC_NAV', 'REBUILD_KV', 'REBUILD_EXCEL'],
    ledgerRevision: beforePortfolio.ledger_revision,
    status: 'PENDING',
  });
  assert.ok(auditByReason.has('repeat safely'));
});

test('admin rebuild cannot discard a tape that becomes published before its batch starts', async () => {
  const { env } = await setup();
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });
  const database = env.FEEDBACK_DB.database;
  const revision = database.prepare(`
    SELECT ledger_revision FROM ledger_portfolios WHERE portfolio_id = 'us'
  `).get().ledger_revision;
  const tape = await freezeUsTape(env, revision, {
    from: '2026-02-01',
    prices: [{ ticker: 'AAA', date: '2026-02-01', close: 10 }],
  });
  const originalBatch = env.FEEDBACK_DB.batch.bind(env.FEEDBACK_DB);
  let injectedPublication = false;
  env.FEEDBACK_DB.batch = async statements => {
    if (!injectedPublication) {
      injectedPublication = true;
      database.prepare(`
        INSERT INTO ledger_nav_snapshots (
          portfolio_id, nav_date, ledger_revision, cash_minor,
          market_value_minor, total_assets_minor, liability_minor,
          liability_asset_ratio_micros, net_value_minor, units_micros,
          unit_nav_micros, fund_action_adjustment_minor, source, source_ref,
          valuation_json, warnings_json, calculated_at
        ) VALUES (
          'us', '2026-02-01', ?, 100000,
          0, 100000, 0,
          0, 100000, 1000000000,
          1000000, 0, 'race-publish', 'unit-test',
          '{"priceBasis":"raw_close","adjusted":false}', '[]', 123456
        )
      `).run(revision);
    }
    return originalBatch(statements);
  };

  const response = await api(env, '/api/admin/ledger/rebuild', {
    method: 'POST', body: { portfolio: 'us', reason: 'concurrent publish guard' },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.discardedPriceTapeId, null);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_price_tapes WHERE price_tape_id = ?
  `).get(tape.priceTapeId).count, 1);
  assert.ok(database.prepare(`
    SELECT COUNT(*) AS count FROM ledger_price_tape_rows WHERE price_tape_id = ?
  `).get(tape.priceTapeId).count > 0);
});

test('admin derived rebuild defers an ordered outbox drain when refresh is available', async () => {
  const { env } = await setup();
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });
  await freezeUsTape(env, 1, { from: '2026-02-01' });
  await persistLedgerValuation(env, 'us', {
    date: '2026-02-01', cash: 1000, marketValue: 0, totalAssets: 1000,
    liability: 0, netValue: 1000, units: 1000, unitNav: 1,
    sourceRef: 'unit-test-published-tape',
    valuation: { priceBasis: 'raw_close', adjusted: false }, warnings: [],
  }, [], 1);
  const deferred = [];
  const refreshCalls = [];
  const response = await handleLedgerAdminRequest(new Request(
    'https://ledger.test/api/admin/ledger/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio: 'us', reason: 'operator replay' }),
    },
  ), env, {
    actor: 'test-admin',
    defer(promise) { deferred.push(promise); },
    async refreshPortfolio(_env, portfolio, options) {
      refreshCalls.push({ portfolio, options });
      return {
        complete: true,
        historicalReplay: true,
        ledgerRevision: options.ledgerRevision,
      };
    },
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(deferred.length, 1);
  await deferred[0];
  assert.equal(refreshCalls.length, 1);
  assert.equal(refreshCalls[0].portfolio, 'us');
  assert.equal(refreshCalls[0].options.affectedFrom, '2026-02-01');
  const rows = env.FEEDBACK_DB.database.prepare(`
    SELECT kind, status, attempts, last_error, processed_at
    FROM ledger_outbox
    WHERE portfolio_id = 'us' AND ledger_revision = 1
    ORDER BY CASE kind WHEN 'REBUILD_KV' THEN 0 WHEN 'RECALC_NAV' THEN 1 ELSE 2 END
  `).all();
  assert.deepEqual(rows.map(row => row.kind), ['REBUILD_KV', 'RECALC_NAV', 'REBUILD_EXCEL']);
  assert.ok(rows.every(row => row.status === 'DONE' && row.attempts === 1));
  assert.ok(rows.every(row => row.last_error === null && row.processed_at != null));
});

test('D1 materialization recovers the latest revision when revision changes during publication', async () => {
  const { env } = await setup();
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });
  const tape1 = await freezeUsTape(env, 1, { from: '2026-02-01' });

  let injected = false;
  const originalPrepare = env.FEEDBACK_DB.prepare.bind(env.FEEDBACK_DB);
  env.FEEDBACK_DB.prepare = sql => {
    const statement = originalPrepare(sql);
    if (!/INSERT INTO ledger_materialized_projections/.test(sql)) return statement;
    const originalBind = statement.bind.bind(statement);
    statement.bind = (...values) => {
      const bound = originalBind(...values);
      const originalRun = bound.run.bind(bound);
      bound.run = async () => {
        if (!injected) {
          injected = true;
          env.FEEDBACK_DB.database.prepare(`
            UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
          `).run();
          await freezeUsTape(env, 2, { from: '2026-02-01', parent: tape1 });
        }
        return originalRun();
      };
      return bound;
    };
    return statement;
  };

  const materialized = await materializeLedgerKv(env, 'us');
  assert.equal(injected, true);
  assert.equal(materialized.ledgerRevision, 2);
  const stored = await loadMaterializedLedgerProjection(env, 'us');
  assert.equal(stored.ledgerRevision, 2);
  assert.equal(stored.projection.ledgerRevision, 2);
  assert.equal(env.YC_KV.values.has('ledger:us'), false);

  const recovery = env.FEEDBACK_DB.database.prepare(`
    SELECT ledger_revision, status, attempts, last_error
    FROM ledger_outbox
    WHERE portfolio_id = 'us' AND kind = 'REBUILD_KV' AND ledger_revision = 2
  `).get();
  assert.equal(recovery.ledger_revision, 2);
  assert.equal(recovery.status, 'DONE');
  assert.equal(recovery.attempts, 1);
  assert.equal(recovery.last_error, null);
});
