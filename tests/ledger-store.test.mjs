import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  handleLedgerAdminRequest,
  materializeLedgerKv,
  persistLedgerValuation,
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
  const sql = await readFile(new URL('../migrations/0002_portfolio_ledger.sql', import.meta.url), 'utf8');
  const env = { FEEDBACK_DB: new D1Database(sql), YC_KV: new MemoryKv() };
  return { env };
}

async function api(env, path, { method = 'GET', body } = {}) {
  const response = await handleLedgerAdminRequest(new Request('https://ledger.test' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }), env, { actor: 'test-admin' });
  return { status: response.status, body: await response.json() };
}

async function createAndConfirm(env, event, confirmation = {}) {
  const manual = new Set(['BUY', 'SELL', 'CAPITAL']);
  const eventType = String(event.type || event.event_type || '').toUpperCase();
  const created = await api(env, '/api/admin/ledger/pending', {
    method: 'POST', body: {
      portfolio: 'us', event, source: manual.has(eventType) ? 'MANUAL' : 'AUTOMATION',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const confirmed = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: created.body.item.pendingId,
      expectedVersion: created.body.item.version,
      confirmation: { reason: 'unit test', ...confirmation },
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return confirmed.body;
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

  const exported = await api(env, '/api/admin/ledger/export?portfolio=us');
  assert.equal(exported.status, 200, JSON.stringify(exported.body));
  assert.equal(exported.body.events.length, 2);
  const originalBuy = exported.body.events.find(item => item.eventType === 'BUY');
  assert.ok(originalBuy);

  const changedBuy = {
    type: 'BUY', date: originalBuy.tradeDate,
    ticker: 'AAA', name: 'AAA Inc', quantity: 10,
    gross_amount: '120.00', tax_amount: '0', fee_amount: '0',
    net_cash: '-120.00', notes: 'edited through Excel',
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
  const corrected = await api(env, '/api/admin/ledger/pending/confirm', {
    method: 'POST',
    body: {
      pendingId: correction.pendingId,
      expectedVersion: correction.version,
      confirmation: { reason: 'Excel correction checked' },
    },
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.item.supersedesEventId, originalBuy.eventId);
  assert.equal(corrected.body.item.eventVersion, 2);

  const finalList = await api(env, '/api/admin/ledger?portfolio=us&status=all');
  assert.equal(finalList.body.ledgerRevision, 3);
  assert.equal(finalList.body.events.length, 2);
  const finalBuy = finalList.body.events.find(item => item.eventType === 'BUY');
  assert.equal(finalBuy.event.net_cash_minor, -12000);
  assert.equal(finalList.body.projection.cash.minor, 88000);
  assert.ok(JSON.parse(await env.YC_KV.get('ledger:us')).ledgerRevision === 3);
});

test('automation source idempotency rejects the same source key with changed content', async () => {
  const { env } = await setup();
  const base = {
    portfolio: 'us',
    sourceSystem: 'broker-api',
    sourceAccount: 'account-1',
    sourceEventId: 'fill-2026-001',
    event: {
      type: 'BUY', date: '2026-01-03', ticker: 'AAA', name: 'AAA Inc', quantity: 10,
      gross_amount: '100.00', tax_amount: '0', fee_amount: '0', net_cash: '-100.00',
    },
    rawPayload: { fillId: 'fill-2026-001', amount: '100.00' },
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
      rawPayload: { fillId: 'fill-2026-001', amount: '101.00' },
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

  const automated = await api(env, '/api/admin/ledger/pending', {
    method: 'POST', body: { portfolio: 'us', event, source: 'AUTOMATION' },
  });
  assert.equal(automated.status, 201, JSON.stringify(automated.body));
  assert.equal(automated.body.item.source, 'AUTOMATION');
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
  const navRows = historicalNavRows();
  const preview = await api(env, '/api/admin/ledger/migration/preview', {
    method: 'POST', body: {
      portfolio: 'us', sourceWorkbookSha256, events,
      historical_nav_rows: navRows,
    },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.eventCount, 2);
  assert.equal(preview.body.unknownTaxEvents, 2);
  assert.equal(preview.body.lowestCashMinor, 90000);
  assert.equal(preview.body.historicalNavRowCount, 2);
  assert.deepEqual(preview.body.historicalNavDateRange, ['2026-01-02', '2026-01-03']);
  assert.match(preview.body.navSeedHash, /^[a-f0-9]{64}$/);

  const retryPreview = await api(env, '/api/admin/ledger/migration/preview', {
    method: 'POST', body: {
      portfolio: 'us', sourceWorkbookSha256, events,
      historical_nav_rows: navRows,
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
        phrase: 'CONFIRM LEGACY US', negativeCash: true,
        duplicates: true, unknownTax: true, historicalNav: true,
      },
    },
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.ledgerRevision, 2);
  assert.equal(confirmed.body.historicalNavRowCount, 2);

  const storedNav = env.FEEDBACK_DB.database.prepare(`
    SELECT * FROM ledger_nav_snapshots
    WHERE portfolio_id = 'us' ORDER BY nav_date
  `).all();
  assert.equal(storedNav.length, 2);
  assert.deepEqual(storedNav.map(row => ({
    date: row.nav_date,
    revision: row.ledger_revision,
    cash: row.cash_minor,
    marketValue: row.market_value_minor,
    totalAssets: row.total_assets_minor,
    liability: row.liability_minor,
    netValue: row.net_value_minor,
    units: row.units_micros,
    unitNav: row.unit_nav_micros,
    adjustment: row.fund_action_adjustment_minor,
    source: row.source,
    sourceRow: row.source_row,
  })), [
    {
      date: '2026-01-02', revision: 2, cash: 100000, marketValue: 0,
      totalAssets: 100000, liability: 0, netValue: 100000,
      units: 1_000_000_000, unitNav: 1_000_000, adjustment: 0,
      source: 'LEGACY_READ_ONLY_PROJECTION', sourceRow: 3,
    },
    {
      date: '2026-01-03', revision: 2, cash: 90000, marketValue: 12000,
      totalAssets: 102000, liability: 2000, netValue: 100000,
      units: 1_000_000_000, unitNav: 1_000_000, adjustment: -200,
      source: 'LEGACY_READ_ONLY_PROJECTION', sourceRow: 4,
    },
  ]);
  assert.ok(storedNav.every(row => row.source_workbook_sha256 === sourceWorkbookSha256));
  assert.deepEqual(JSON.parse(storedNav[0].valuation_json), { method: 'legacy_workbook' });
  assert.deepEqual(JSON.parse(storedNav[0].warnings_json), ['historical_seed']);

  const listed = await api(env, '/api/admin/ledger?portfolio=us&status=all');
  assert.equal(listed.body.events.length, 2);
  assert.equal(listed.body.projection.cash.minor, 90000);
  assert.equal(listed.body.navRows.length, 2);
  assert.deepEqual(listed.body.projection.nav_rows, listed.body.navRows);
  assert.ok(listed.body.events.every(item => item.event.tax_status === 'UNKNOWN_LEGACY'));
});

test('legacy NAV seed hashes every NAV cell and rejects duplicate dates', async () => {
  const sourceWorkbookSha256 = 'c'.repeat(64);
  const baseRows = historicalNavRows();
  const changedRows = structuredClone(baseRows);
  changedRows[1].fund_action_adjustment = -3;

  const { env: baseEnv } = await setup();
  const base = await api(baseEnv, '/api/admin/ledger/migration/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', sourceWorkbookSha256, events: legacyEvents(),
      historicalNavRows: baseRows,
    },
  });
  assert.equal(base.status, 200, JSON.stringify(base.body));

  const { env: changedEnv } = await setup();
  const changed = await api(changedEnv, '/api/admin/ledger/migration/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', sourceWorkbookSha256, events: legacyEvents(),
      historicalNavRows: changedRows,
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.notEqual(changed.body.navSeedHash, base.body.navSeedHash);
  assert.notEqual(changed.body.migrationHash, base.body.migrationHash);

  const { env: duplicateEnv } = await setup();
  const duplicateRows = structuredClone(baseRows);
  duplicateRows[1].date = duplicateRows[0].date;
  const duplicate = await api(duplicateEnv, '/api/admin/ledger/migration/preview', {
    method: 'POST',
    body: {
      portfolio: 'us', sourceWorkbookSha256, events: legacyEvents(),
      historical_nav_rows: duplicateRows,
    },
  });
  assert.equal(duplicate.status, 422, JSON.stringify(duplicate.body));
  assert.match(duplicate.body.error, /NAV 日期重複/);
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
  });

  await persistLedgerValuation(env, 'us', {
    date: '2026-02-05', cash: 934, marketValue: 96, totalAssets: 1030,
    liability: 0, netValue: 1030, units: 1000, unitNav: 1.03,
    sourceRef: 'tushare:python-parity', valuation: { priced: 1 }, warnings: [],
  }, [{ ticker: 'AAA', close: 12, source: 'TUSHARE', sourceRef: 'daily:AAA' }], 4);

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
});

test('D1 action-date prices automatically allocate multi-output corporate action cost', async () => {
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
  assert.equal(positions.get('SPGI').buy_cost_minor, 9524);
  assert.equal(positions.get('MBGL').buy_cost_minor, 476);
  assert.equal(confirmed.projection.checks.some(check =>
    check.code === 'CORPORATE_ACTION_PRICE_FALLBACK'), false);
});

test('KV materialization recovers the latest revision when revision changes during publication', async () => {
  const { env } = await setup();
  await createAndConfirm(env, {
    type: 'CAPITAL', date: '2026-02-01', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00',
  });

  let injected = false;
  env.YC_KV.onPut = async key => {
    if (injected || key !== 'ledger:us') return;
    injected = true;
    env.FEEDBACK_DB.database.prepare(`
      UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
    `).run();
  };

  const materialized = await materializeLedgerKv(env, 'us');
  assert.equal(injected, true);
  assert.equal(materialized.ledgerRevision, 2);
  assert.equal(JSON.parse(await env.YC_KV.get('ledger:us')).ledgerRevision, 2);

  const recovery = env.FEEDBACK_DB.database.prepare(`
    SELECT ledger_revision, status, attempts, last_error
    FROM ledger_outbox
    WHERE portfolio_id = 'us' AND kind = 'REBUILD_KV' AND ledger_revision = 2
  `).get();
  assert.equal(recovery.ledger_revision, 2);
  assert.equal(recovery.status, 'DONE');
  assert.equal(recovery.attempts, 1);
  assert.equal(recovery.last_error, null);
  assert.deepEqual(
    env.YC_KV.puts.slice(-2).map(item => JSON.parse(item.value).ledgerRevision),
    [1, 2],
  );
});
