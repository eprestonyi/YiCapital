import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  drainLedgerOutbox,
  enqueueDailyNavReplay,
  freezeLedgerPriceTape,
  handleLedgerAdminRequest,
  ledgerHealth,
  materializeLedgerKv,
  persistLedgerValuation,
  persistLedgerValuationBatch,
  portfolioDerivationState,
} from '../worker/ledger-store.js';
import worker, { updatePortfolioNav } from '../worker/worker.js';

const FIXED_NOW = Date.parse('2026-07-24T22:00:00.000Z');
const now = () => FIXED_NOW;

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
  constructor() {
    this.values = new Map();
    this.puts = [];
  }

  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) {
    this.puts.push({ key, value });
    this.values.set(key, value);
  }
  async delete(key) { this.values.delete(key); }
}

async function setup() {
  const sql = (await Promise.all([
    '../migrations/0002_portfolio_ledger.sql',
    '../migrations/0003_frozen_price_tapes.sql',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
  return {
    FEEDBACK_DB: new D1Database(sql),
    YC_KV: new MemoryKv(),
  };
}

function seedEvents(env, revision = 2) {
  const db = env.FEEDBACK_DB.database;
  db.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = ? WHERE portfolio_id = 'us'
  `).run(revision);
  const insert = db.prepare(`
    INSERT INTO ledger_events (
      event_id, lineage_id, event_version, portfolio_id, ledger_revision,
      event_type, trade_date, sequence_no, currency, payload_json,
      source, confirmed_by, confirmed_at
    ) VALUES (?, ?, 1, 'us', ?, ?, ?, ?, 'USD', ?, 'MANUAL', 'test', 1)
  `);
  const capital = {
    event_id: 'capital-1', type: 'CAPITAL', date: '2026-07-20', shareholder: 'LP1',
    subscription: '1000.00', redemption: '0', unit_price: '1.00', status: 'confirmed',
  };
  const buy = {
    event_id: 'buy-1', type: 'BUY', date: '2026-07-21', ticker: 'AAA', name: 'AAA Inc',
    quantity: 10, gross_amount: '100.00', tax_amount: '0', fee_amount: '0',
    net_cash: '-100.00', status: 'confirmed',
  };
  insert.run('capital-1', 'capital-1', 1, 'CAPITAL', '2026-07-20', 1, JSON.stringify(capital));
  insert.run('buy-1', 'buy-1', 2, 'BUY', '2026-07-21', 1, JSON.stringify(buy));
}

function insertOutbox(env, {
  id,
  revision,
  kind,
  payload = { affectedFrom: '2026-07-20' },
  status = 'PENDING',
  createdAt = 1,
}) {
  env.FEEDBACK_DB.database.prepare(`
    INSERT INTO ledger_outbox (
      outbox_id, portfolio_id, ledger_revision, kind, payload_json,
      status, attempts, available_at, created_at
    ) VALUES (?, 'us', ?, ?, ?, ?, 0, 0, ?)
  `).run(id, revision, kind, JSON.stringify(payload), status, createdAt);
}

function outboxRows(env) {
  return env.FEEDBACK_DB.database.prepare(`
    SELECT outbox_id, ledger_revision, kind, payload_json, status, attempts,
      available_at, last_error, processed_at
    FROM ledger_outbox WHERE portfolio_id = 'us'
    ORDER BY ledger_revision, kind
  `).all().map(row => ({ ...row }));
}

function navRows(env) {
  return env.FEEDBACK_DB.database.prepare(`
    SELECT nav_date, ledger_revision, cash_minor, market_value_minor, unit_nav_micros
    FROM ledger_nav_snapshots WHERE portfolio_id = 'us' ORDER BY nav_date
  `).all().map(row => ({ ...row }));
}

function navHash(env) {
  const rows = env.FEEDBACK_DB.database.prepare(`
    SELECT * FROM ledger_nav_snapshots
    WHERE portfolio_id = 'us' ORDER BY nav_date
  `).all().map(row => ({ ...row }));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function officialCalendar(request, openDates) {
  const compactToIso = value => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const start = compactToIso(request.params.start_date);
  const end = compactToIso(request.params.end_date);
  const opens = new Set(openDates);
  const data = [];
  for (let time = Date.parse(`${start}T00:00:00.000Z`);
    time <= Date.parse(`${end}T00:00:00.000Z`);
    time += 86400000) {
    const calDate = new Date(time).toISOString().slice(0, 10).replaceAll('-', '');
    data.push({ cal_date: calDate, is_open: opens.has(calDate) ? 1 : 0 });
  }
  return { data };
}

function historicalAdapter() {
  const calls = [];
  const dates = ['20260720', '20260721', '20260722', '20260723', '20260724'];
  const prices = [10, 10, 11, 11.5, 12];
  return {
    calls,
    async query(dataset, request) {
      calls.push({ dataset, tsCode: request.params.ts_code });
      if (dataset === 'us_tradecal') return officialCalendar(request, dates);
      assert.equal(dataset, 'us_daily');
      if (request.params.ts_code === 'AAPL') return { data: dates.map((trade_date, index) => ({
        ts_code: 'AAPL', trade_date, close: 600 + index,
      })) };
      assert.equal(request.params.ts_code, 'AAA');
      return { data: dates.map((trade_date, index) => ({
        ts_code: 'AAA', trade_date, close: prices[index],
      })) };
    },
  };
}

async function seedFrozenTape(env) {
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  const prices = [10, 10, 11, 11.5, 12];
  return freezeLedgerPriceTape(env, 'us', {
    tapeFrom: dates[0],
    tapeThrough: dates.at(-1),
    calendarFrom: dates[0],
    calendarDates: dates,
    calendarSource: 'tushare:us_tradecal+us_daily',
    calendarSourceRef: 'us_tradecal:is_open+us_daily:AAPL:eod-watermark',
    requiredTickers: ['AAA'],
    priceSource: 'tushare:us_daily',
    priceBasis: 'raw_close',
    adjusted: false,
    priceRows: dates.map((date, index) => ({
      ticker: 'AAA', date, close: prices[index],
      source: 'tushare:us_daily', sourceRef: 'us_daily:close:raw-unadjusted',
    })),
  }, 2);
}

test('single and batch NAV persistence canonicalize cent-exact accounting identities', async () => {
  const env = await setup();
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  const units = 2_107_072.57018;
  const unitNav = 235_108.805 / units;
  const shared = {
    cash: -12_809.08,
    marketValue: 247_917.88,
    totalAssets: 235_108.81,
    liability: 0,
    netValue: 235_108.81,
    units,
    unitNav,
    valuation: { priceBasis: 'raw_counter', adjusted: false },
    warnings: [],
  };

  await persistLedgerValuation(env, 'us', {
    ...shared,
    date: '2026-08-04',
    source: 'yahoo:query2-chart',
    sourceRef: 'counter:half-cent',
  }, [], 1);
  await persistLedgerValuationBatch(env, 'us', {
    replaceFrom: '2026-08-05',
    replaceThrough: '2026-08-05',
    navRows: [{
      ...shared,
      date: '2026-08-05',
      market_value: shared.marketValue,
      total_assets: shared.totalAssets,
      net_value: shared.netValue,
      unit_nav: shared.unitNav,
    }],
    priceRows: [],
  }, 1);

  const rows = env.FEEDBACK_DB.database.prepare(`
    SELECT nav_date, cash_minor, market_value_minor, total_assets_minor,
      liability_minor, net_value_minor, units_micros, unit_nav_micros
    FROM ledger_nav_snapshots
    WHERE portfolio_id = 'us' AND ledger_revision = 1
    ORDER BY nav_date
  `).all().map(row => ({ ...row }));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.cash_minor, -1_280_908);
    assert.equal(row.market_value_minor, 24_791_788);
    assert.equal(row.total_assets_minor, 23_510_880);
    assert.equal(row.net_value_minor, 23_510_880);
    assert.equal(row.cash_minor + row.market_value_minor, row.total_assets_minor);
    assert.equal(row.total_assets_minor - row.liability_minor, row.net_value_minor);
    assert.equal(row.units_micros, 2_107_072_570_180);
    assert.equal(row.unit_nav_micros, 111_581);
  }
});

test('canonical liability ratio keeps Python parity for non-positive assets', async () => {
  const env = await setup();
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  await persistLedgerValuation(env, 'us', {
    date: '2026-08-04',
    cash: -100,
    marketValue: 0,
    totalAssets: -100,
    liability: 10,
    netValue: -110,
    units: 0,
    unitNav: 0,
    source: 'python-parity-fixture',
    sourceRef: 'non-positive-assets',
    valuation: { priceBasis: 'raw_counter', adjusted: false },
    warnings: [],
  }, [], 1);

  const row = env.FEEDBACK_DB.database.prepare(`
    SELECT total_assets_minor, liability_minor, net_value_minor,
      liability_asset_ratio_micros
    FROM ledger_nav_snapshots
    WHERE portfolio_id = 'us' AND ledger_revision = 1 AND nav_date = '2026-08-04'
  `).get();
  assert.deepEqual({ ...row }, {
    total_assets_minor: -10_000,
    liability_minor: 1_000,
    net_value_minor: -11_000,
    liability_asset_ratio_micros: 0,
  });
});

test('automated NAV outbox defaults to one CPU-bounded session', async () => {
  const env = await setup();
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  insertOutbox(env, { id: 'nav-1', revision: 1, kind: 'RECALC_NAV' });

  const result = await drainLedgerOutbox(env, {
    portfolio: 'us',
    refreshPortfolio: async (runtimeEnv, portfolio, options) => {
      assert.equal(runtimeEnv, env);
      assert.equal(portfolio, 'us');
      assert.equal(options.batchSize, 1);
      return {
        pf: portfolio,
        ledgerRevision: 1,
        complete: true,
        historicalReplay: true,
        fallback: false,
      };
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pending, false, JSON.stringify(result));
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-1').status, 'DONE');
});

test('interactive admin outbox keeps a bounded five-session continuation', async () => {
  const env = await setup();
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  insertOutbox(env, { id: 'nav-1', revision: 1, kind: 'RECALC_NAV' });

  const response = await handleLedgerAdminRequest(
    new Request('https://ledger.test/api/admin/ledger/outbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio: 'us' }),
    }),
    env,
    {
      actor: 'test-admin',
      refreshPortfolio: async (runtimeEnv, portfolio, options) => {
        assert.equal(runtimeEnv, env);
        assert.equal(portfolio, 'us');
        assert.equal(options.batchSize, 5);
        return {
          pf: portfolio,
          ledgerRevision: 1,
          complete: true,
          historicalReplay: true,
          fallback: false,
        };
      },
    },
  );
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pending, false, JSON.stringify(result));
});

test('daily EOD scheduling requeues DONE and attaches intent to unfinished checkpoints', async () => {
  const env = await setup();
  seedEvents(env);
  await seedFrozenTape(env);
  const queued = await enqueueDailyNavReplay(env, ['us', 'hk', 'a']);
  assert.deepEqual(queued, [{
    portfolio: 'us', ledgerRevision: 2, affectedFrom: '2026-07-24',
  }]);
  const row = env.FEEDBACK_DB.database.prepare(`
    SELECT ledger_revision, kind, status, payload_json FROM ledger_outbox
    WHERE portfolio_id = 'us' AND kind = 'RECALC_NAV'
  `).get();
  assert.equal(row.ledger_revision, 2);
  assert.equal(row.kind, 'RECALC_NAV');
  assert.equal(row.status, 'PENDING');
  assert.deepEqual(JSON.parse(row.payload_json), {
    affectedFrom: '2026-07-24', probeEod: true,
    reason: 'scheduled-eod-raw-tape-extension',
  });
  for (const status of ['PENDING', 'FAILED', 'PROCESSING']) {
    const protectedPayload = JSON.stringify({
      affectedFrom: '2026-07-20',
      navReplay: { phase: 'replay', cursor: `checkpoint-${status}` },
    });
    env.FEEDBACK_DB.database.prepare(`
      UPDATE ledger_outbox SET payload_json = ?, status = ?, attempts = 7,
        available_at = 123, last_error = ?, processed_at = 456
      WHERE portfolio_id = 'us' AND kind = 'RECALC_NAV'
    `).run(protectedPayload, status, `keep:${status}`);
    const before = env.FEEDBACK_DB.database.prepare(`
      SELECT status, attempts, available_at, last_error, processed_at
      FROM ledger_outbox WHERE portfolio_id = 'us' AND kind = 'RECALC_NAV'
    `).get();
    await enqueueDailyNavReplay(env, ['us']);
    const after = env.FEEDBACK_DB.database.prepare(`
      SELECT payload_json, status, attempts, available_at, last_error, processed_at
      FROM ledger_outbox WHERE portfolio_id = 'us' AND kind = 'RECALC_NAV'
    `).get();
    const afterPayload = JSON.parse(after.payload_json);
    delete after.payload_json;
    assert.deepEqual(after, before, `${status} checkpoint state must remain intact`);
    assert.deepEqual({
      affectedFrom: afterPayload.affectedFrom,
      navReplay: afterPayload.navReplay,
    }, JSON.parse(protectedPayload));
    assert.deepEqual({
      affectedFrom: afterPayload.followUpEod.affectedFrom,
      reason: afterPayload.followUpEod.reason,
    }, {
      affectedFrom: '2026-07-24',
      reason: 'scheduled-eod-raw-tape-extension',
    });
    assert.ok(Number.isInteger(afterPayload.followUpEod.requestedAt));
  }

  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_outbox SET status = 'DONE', attempts = 9,
      available_at = 123, last_error = 'old', processed_at = 456
    WHERE portfolio_id = 'us' AND kind = 'RECALC_NAV'
  `).run();
  await enqueueDailyNavReplay(env, ['us']);
  const requeued = env.FEEDBACK_DB.database.prepare(`
    SELECT payload_json, status, attempts, last_error, processed_at
    FROM ledger_outbox WHERE portfolio_id = 'us' AND kind = 'RECALC_NAV'
  `).get();
  assert.deepEqual({ ...requeued }, {
    payload_json: JSON.stringify({
      affectedFrom: '2026-07-24', probeEod: true,
      reason: 'scheduled-eod-raw-tape-extension',
    }),
    status: 'PENDING', attempts: 0, last_error: null, processed_at: null,
  });
});

test('a busy NAV replay remembers and automatically runs the EOD follow-up', async () => {
  const env = await setup();
  seedEvents(env);
  await seedFrozenTape(env);
  insertOutbox(env, {
    id: 'nav-2', revision: 2, kind: 'RECALC_NAV',
    payload: { affectedFrom: '2026-07-20', reason: 'long historical replay' },
  });

  let firstEnteredResolve;
  let firstReleaseResolve;
  const firstEntered = new Promise(resolve => { firstEnteredResolve = resolve; });
  const firstRelease = new Promise(resolve => { firstReleaseResolve = resolve; });
  const calls = [];
  const refreshPortfolio = async (_runtimeEnv, portfolio, options) => {
    calls.push({ portfolio, ...options });
    if (calls.length === 1) {
      firstEnteredResolve();
      await firstRelease;
    }
    return {
      historicalReplay: true,
      complete: true,
      ledgerRevision: 2,
      fallback: false,
    };
  };

  const drainPromise = drainLedgerOutbox(env, { portfolio: 'us', refreshPortfolio });
  await firstEntered;
  await enqueueDailyNavReplay(env, ['us']);
  const during = outboxRows(env).find(row => row.outbox_id === 'nav-2');
  assert.equal(during.status, 'PROCESSING');
  assert.match(during.last_error, /^OUTBOX_CLAIM:/);
  const duringPayload = JSON.parse(during.payload_json);
  assert.deepEqual({
    affectedFrom: duringPayload.followUpEod.affectedFrom,
    reason: duringPayload.followUpEod.reason,
  }, {
    affectedFrom: '2026-07-24',
    reason: 'scheduled-eod-raw-tape-extension',
  });
  assert.ok(Number.isInteger(duringPayload.followUpEod.requestedAt));

  firstReleaseResolve();
  const drained = await drainPromise;
  assert.equal(drained.ok, true, JSON.stringify(drained));
  assert.equal(drained.pending, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].probeEod, false);
  assert.equal(calls[1].probeEod, true);
  assert.equal(calls[1].affectedFrom, '2026-07-24');
  assert.equal(drained.results[0].followUpEod, true);
  const final = outboxRows(env).find(row => row.outbox_id === 'nav-2');
  assert.equal(final.status, 'DONE');
  assert.equal(final.attempts, 2);
  const finalPayload = JSON.parse(final.payload_json);
  assert.deepEqual({
    affectedFrom: finalPayload.affectedFrom,
    probeEod: finalPayload.probeEod,
    reason: finalPayload.reason,
  }, {
    affectedFrom: '2026-07-24',
    probeEod: true,
    reason: 'scheduled-eod-raw-tape-extension',
  });
  assert.ok(Number.isInteger(finalPayload.requestedAt));
});

test('historical NAV outbox resumes in bounded replay, materialize, and publish phases', async () => {
  const env = await setup();
  seedEvents(env);
  insertOutbox(env, { id: 'kv-2', revision: 2, kind: 'REBUILD_KV' });
  insertOutbox(env, { id: 'nav-2', revision: 2, kind: 'RECALC_NAV' });
  insertOutbox(env, { id: 'xlsx-2', revision: 2, kind: 'REBUILD_EXCEL' });
  const adapter = historicalAdapter();
  const refreshPortfolio = (runtimeEnv, portfolio, options) =>
    updatePortfolioNav(runtimeEnv, portfolio, { ...options, adapter, now });
  const drain = () => drainLedgerOutbox(env, {
    portfolio: 'us',
    refreshPortfolio,
    navBatchSize: 2,
  });

  const first = await drain();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.pending, true);
  assert.deepEqual(first.results.map(item => [item.kind, item.complete]), [
    ['RECALC_NAV', false],
  ]);
  assert.equal(first.results.at(-1).nextPhase, 'replay');
  assert.equal(first.results.at(-1).nextCursor, '2026-07-22');
  assert.equal(navRows(env).length, 2);
  assert.equal(adapter.calls.length, 3);
  const firstCheckpointPayload = outboxRows(env)
    .find(row => row.outbox_id === 'nav-2').payload_json;
  const firstCheckpoint = JSON.parse(firstCheckpointPayload).navReplay;
  assert.deepEqual({
    phase: firstCheckpoint.phase,
    cursor: firstCheckpoint.cursor,
    targetThrough: firstCheckpoint.targetThrough,
    lastNavDate: firstCheckpoint.lastNavDate,
  }, {
    phase: 'replay',
    cursor: '2026-07-22',
    targetThrough: '2026-07-24',
    lastNavDate: '2026-07-21',
  });
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-2').attempts, 0);
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'xlsx-2').status, 'PENDING');
  assert.equal(env.YC_KV.values.has('navcache:us'), false);

  const second = await drain();
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.results[0].nextCursor, '2026-07-24');
  assert.equal(navRows(env).length, 4);
  assert.equal(adapter.calls.length, 3);

  // Simulate a lost response after the D1 batch committed but before the caller
  // retained the newer cursor. Replaying the same range replaces, not duplicates.
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_outbox SET payload_json = ? WHERE outbox_id = 'nav-2'
  `).run(firstCheckpointPayload);
  const repeated = await drain();
  assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.results[0].nextCursor, '2026-07-24');
  assert.deepEqual(navRows(env).map(row => row.nav_date), [
    '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23',
  ]);
  assert.equal(adapter.calls.length, 3);

  const finalReplay = await drain();
  assert.equal(finalReplay.ok, true, JSON.stringify(finalReplay));
  assert.equal(finalReplay.results[0].complete, false);
  assert.equal(finalReplay.results[0].nextPhase, 'materialize');
  assert.equal(finalReplay.results[0].nextCursor, null);
  assert.equal(navRows(env).length, 5);
  assert.equal(adapter.calls.length, 3);
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-2').status, 'PENDING');
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'xlsx-2').status, 'PENDING');
  assert.equal(env.YC_KV.values.has('navcache:us'), false);

  const callsBeforeMaterialize = adapter.calls.length;
  const materialized = await drain();
  assert.equal(materialized.ok, true, JSON.stringify(materialized));
  assert.equal(materialized.results[0].nextPhase, 'publish');
  assert.equal(materialized.results[0].complete, false);
  assert.equal(adapter.calls.length, callsBeforeMaterialize);
  assert.equal(JSON.parse(env.YC_KV.values.get('ledger:us')).navRows.length, 5);
  assert.equal(env.YC_KV.values.has('navcache:us'), false);
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-2').status, 'PENDING');
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'xlsx-2').status, 'PENDING');

  const published = await drain();
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.deepEqual(published.results.map(item => [item.kind, item.complete]), [
    ['RECALC_NAV', true],
    ['REBUILD_EXCEL', true],
  ]);
  assert.equal(adapter.calls.length, callsBeforeMaterialize);
  assert.ok(outboxRows(env).every(row => row.status === 'DONE'));
  const cache = JSON.parse(env.YC_KV.values.get('navcache:us'));
  assert.equal(cache.navRows.length, 5);
  assert.equal(cache.as_of, '2026-07-24');
  assert.deepEqual(cache.base, {
    date: '2026-07-24',
    unitNav: 1.02,
    marketValue: 120,
    totalAssets: 1020,
    netValue: 1020,
    cash: 900,
    liability: 0,
    units: 1000,
  });
  assert.deepEqual(cache.holdings.map(row => ({
    ticker: row.t,
    quantity: row.q,
    price: row.price,
    marketValue: row.marketValue,
    date: row.date,
    priceBasis: row.priceBasis,
    adjusted: row.adjusted,
  })), [{
    ticker: 'AAA',
    quantity: 10,
    price: 12,
    marketValue: 120,
    date: '2026-07-24',
    priceBasis: 'raw_close',
    adjusted: false,
  }]);
  const publicResponse = await worker.fetch(
    new Request('https://portal.test/api/nav/us'), env,
  );
  assert.equal(publicResponse.status, 200);
  const publicSnapshot = await publicResponse.json();
  assert.equal(publicSnapshot.base.marketValue, 120);
  assert.equal(publicSnapshot.holdings[0].price, 12);
  assert.equal(publicSnapshot.holdings[0].marketValue, 120);

  const beforeIdempotent = navRows(env);
  const callsBeforeIdempotent = adapter.calls.length;
  const idempotent = await drain();
  assert.deepEqual(idempotent, {
    ok: true,
    processed: 0,
    pending: false,
    remaining: 0,
    nextAvailableAt: null,
    results: [],
  });
  assert.deepEqual(navRows(env), beforeIdempotent);
  assert.equal(adapter.calls.length, callsBeforeIdempotent);
});

test('materialize coverage restarts replay from the earliest missing trading session', async () => {
  const env = await setup();
  seedEvents(env);
  const dates = ['2026-07-20', '2026-07-21', '2026-07-23', '2026-07-24'];
  await persistLedgerValuationBatch(env, 'us', {
    replaceFrom: '2026-07-20',
    replaceThrough: '2026-07-24',
    navRows: dates.map((date, index) => ({
      date,
      cash: index === 0 ? 1000 : 900,
      market_value: index === 0 ? 0 : 100 + index * 5,
      total_assets: index === 0 ? 1000 : 1000 + index * 5,
      liability: 0,
      net_value: index === 0 ? 1000 : 1000 + index * 5,
      units: 1000,
      unit_nav: index === 0 ? 1 : 1 + index * 0.005,
      sourceRef: 'missing-session-fixture',
    })),
    priceRows: [],
  }, 2);
  await seedFrozenTape(env);
  await materializeLedgerKv(env, 'us', { expectedLedgerRevision: 2 });
  insertOutbox(env, { id: 'kv-2', revision: 2, kind: 'REBUILD_KV', status: 'DONE' });
  insertOutbox(env, {
    id: 'nav-2',
    revision: 2,
    kind: 'RECALC_NAV',
    payload: {
      affectedFrom: '2026-07-20',
      navReplay: {
        portfolio: 'us',
        ledgerRevision: 2,
        affectedFrom: '2026-07-20',
        phase: 'materialize',
        cursor: null,
        targetThrough: '2026-07-24',
        lastNavDate: '2026-07-24',
        lastUnitNav: 1.02,
      },
    },
  });
  insertOutbox(env, { id: 'xlsx-2', revision: 2, kind: 'REBUILD_EXCEL' });
  const adapter = historicalAdapter();

  const result = await drainLedgerOutbox(env, {
    portfolio: 'us',
    refreshPortfolio: (runtimeEnv, portfolio, options) =>
      updatePortfolioNav(runtimeEnv, portfolio, { ...options, adapter, now }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.results[0].complete, false);
  assert.equal(result.results[0].phase, 'materialize');
  assert.equal(result.results[0].nextPhase, 'replay');
  assert.equal(result.results[0].nextCursor, '2026-07-22');
  const checkpoint = JSON.parse(outboxRows(env)
    .find(row => row.outbox_id === 'nav-2').payload_json).navReplay;
  assert.equal(checkpoint.cursor, '2026-07-22');
  assert.equal(checkpoint.lastNavDate, '2026-07-21');
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-2').attempts, 0);
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'xlsx-2').status, 'PENDING');
});

test('current-revision NAV publishes without rewrite only when its raw tape is already frozen', async () => {
  const env = await setup();
  seedEvents(env);
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  await persistLedgerValuationBatch(env, 'us', {
    replaceFrom: dates[0],
    replaceThrough: dates.at(-1),
    navRows: dates.map((date, index) => {
      const marketValue = index === 0 ? 0 : [100, 110, 115, 120][index - 1];
      return {
        date,
        cash: index === 0 ? 1000 : 900,
        market_value: marketValue,
        total_assets: (index === 0 ? 1000 : 900) + marketValue,
        liability: 0,
        net_value: (index === 0 ? 1000 : 900) + marketValue,
        units: 1000,
        unit_nav: ((index === 0 ? 1000 : 900) + marketValue) / 1000,
        sourceRef: 'production-recovery-fixture',
      };
    }),
    priceRows: dates.slice(1).map((date, index) => ({
      ticker: 'AAA',
      date,
      price: [10, 11, 11.5, 12][index],
      sourceRef: 'us_daily',
    })),
  }, 2);
  await seedFrozenTape(env);
  const ledger = await materializeLedgerKv(env, 'us', { expectedLedgerRevision: 2 });
  assert.equal(ledger.navRows.length, 5);
  assert.ok(ledger.navRows.every(row => row.ledgerRevision === 2));
  env.YC_KV.values.set('navcache:us', JSON.stringify({
    cacheVersion: 2,
    navRows: ledger.navRows.slice(0, -1),
    as_of: '2026-07-23',
  }));
  insertOutbox(env, { id: 'kv-2', revision: 2, kind: 'REBUILD_KV', status: 'DONE' });
  insertOutbox(env, {
    id: 'nav-2',
    revision: 2,
    kind: 'RECALC_NAV',
    payload: { affectedFrom: '2026-07-20' },
  });
  insertOutbox(env, { id: 'xlsx-2', revision: 2, kind: 'REBUILD_EXCEL' });
  const beforeHash = navHash(env);
  const adapter = historicalAdapter();
  const recoveryNow = () => Date.parse('2026-07-27T22:00:00.000Z');

  const result = await drainLedgerOutbox(env, {
    portfolio: 'us',
    refreshPortfolio: (runtimeEnv, portfolio, options) =>
      updatePortfolioNav(runtimeEnv, portfolio, { ...options, adapter, now: recoveryNow }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.results.map(item => [item.kind, item.complete]), [
    ['RECALC_NAV', true],
    ['REBUILD_EXCEL', true],
  ]);
  assert.deepEqual(adapter.calls, []);
  assert.equal(navHash(env), beforeHash);
  assert.ok(outboxRows(env).every(row => row.status === 'DONE'));
  const cache = JSON.parse(env.YC_KV.values.get('navcache:us'));
  assert.equal(cache.cacheVersion, 3);
  assert.equal(cache.ledgerRevision, 2);
  assert.equal(cache.navRows.length, 5);
  assert.equal(cache.as_of, '2026-07-24');

  const priorPublishedValues = Object.fromEntries(
    ['live:us', 'navstatus:us', 'navcache:us'].map(key => [key, env.YC_KV.values.get(key)]),
  );
  const originalPut = env.YC_KV.put.bind(env.YC_KV);
  let revisionAdvanced = false;
  env.YC_KV.put = async (key, value) => {
    await originalPut(key, value);
    if (key === 'navcache:us' && !revisionAdvanced) {
      revisionAdvanced = true;
      env.FEEDBACK_DB.database.prepare(`
        UPDATE ledger_portfolios SET ledger_revision = 3 WHERE portfolio_id = 'us'
      `).run();
    }
  };
  await assert.rejects(
    updatePortfolioNav(env, 'us', {
      adapter,
      now: recoveryNow,
      ledgerRevision: 2,
      affectedFrom: '2026-07-20',
      phase: 'publish',
      targetThrough: '2026-07-24',
      lastNavDate: '2026-07-24',
      previousUnitNav: 1.02,
    }),
    error => error && error.details && error.details.code === 'LEDGER_REVISION_CHANGED',
  );
  env.YC_KV.put = originalPut;
  assert.equal(revisionAdvanced, true);
  for (const [key, value] of Object.entries(priorPublishedValues)) {
    assert.equal(env.YC_KV.values.get(key), value);
  }
  const staleResponse = await worker.fetch(
    new Request('https://portal.test/api/nav/us'),
    env,
  );
  assert.equal(staleResponse.status, 503);
  assert.equal((await staleResponse.json()).pending, true);
});

test('admin rebuild probes and appends a newer official EOD session', async () => {
  const env = await setup();
  seedEvents(env);
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  await persistLedgerValuationBatch(env, 'us', {
    replaceFrom: dates[0],
    replaceThrough: dates.at(-1),
    navRows: dates.map((date, index) => ({
      date,
      cash: index === 0 ? 1000 : 900,
      market_value: index === 0 ? 0 : [100, 110, 115, 120][index - 1],
      total_assets: index === 0 ? 1000 : 900 + [100, 110, 115, 120][index - 1],
      liability: 0,
      net_value: index === 0 ? 1000 : 900 + [100, 110, 115, 120][index - 1],
      units: 1000,
      unit_nav: index === 0 ? 1 : (900 + [100, 110, 115, 120][index - 1]) / 1000,
      sourceRef: 'admin-eod-probe-fixture',
    })),
    priceRows: [],
  }, 2);
  await seedFrozenTape(env);
  await materializeLedgerKv(env, 'us', { expectedLedgerRevision: 2 });

  const queuedResponse = await handleLedgerAdminRequest(
    new Request('https://ledger.test/api/admin/ledger/rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio: 'us', reason: 'probe newest official EOD' }),
    }),
    env,
    { actor: 'test-admin' },
  );
  assert.equal(queuedResponse.status, 200);
  const queued = await queuedResponse.json();
  assert.equal(queued.ledgerRevision, 2);
  const recalc = outboxRows(env).find(row => row.kind === 'RECALC_NAV');
  assert.equal(JSON.parse(recalc.payload_json).probeEod, true);

  const calls = [];
  let watermarkReady = false;
  const adapter = {
    async query(dataset, request) {
      calls.push({ dataset, params: { ...request.params } });
      if (dataset === 'us_tradecal') {
        return officialCalendar(request, ['20260727']);
      }
      assert.equal(dataset, 'us_daily');
      if (request.params.ts_code === 'AAPL') {
        return { data: [{
          ts_code: 'AAPL',
          trade_date: watermarkReady ? '20260727' : '20260724',
          close: watermarkReady ? 605 : 604,
        }] };
      }
      assert.equal(request.params.ts_code, 'AAA');
      return { data: [{ ts_code: 'AAA', trade_date: '20260727', close: 13 }] };
    },
  };
  const probeNow = () => Date.parse('2026-07-27T22:00:00.000Z');
  let drained = await drainLedgerOutbox(env, {
    portfolio: 'us',
    refreshPortfolio: (runtimeEnv, portfolio, options) =>
      updatePortfolioNav(runtimeEnv, portfolio, {
        ...options,
        adapter,
        now: probeNow,
      }),
  });
  assert.equal(drained.ok, false);
  assert.equal(drained.pending, true);
  let waiting = outboxRows(env).find(row => row.kind === 'RECALC_NAV');
  assert.equal(waiting.status, 'PENDING');
  assert.match(waiting.last_error, /portfolio_eod_watermark_pending:2026-07-27/);

  watermarkReady = true;
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_outbox SET available_at = 0
    WHERE portfolio_id = 'us' AND kind = 'RECALC_NAV'
  `).run();
  for (let index = 0; index < 10; index += 1) {
    drained = await drainLedgerOutbox(env, {
      portfolio: 'us',
      refreshPortfolio: (runtimeEnv, portfolio, options) =>
        updatePortfolioNav(runtimeEnv, portfolio, {
          ...options,
          adapter,
          now: probeNow,
        }),
    });
    if (!drained.pending) break;
  }
  assert.equal(drained.ok, true, JSON.stringify(drained));
  assert.equal(drained.pending, false, JSON.stringify(drained));
  assert.ok(calls.some(call => call.dataset === 'us_tradecal'));
  assert.ok(calls.some(call => call.dataset === 'us_daily' &&
    call.params.ts_code === 'AAPL'));
  assert.ok(calls.some(call => call.dataset === 'us_daily' &&
    call.params.ts_code === 'AAA'));
  const tape = env.FEEDBACK_DB.database.prepare(`
    SELECT tape_through, price_basis, adjusted
    FROM ledger_price_tapes WHERE portfolio_id = 'us' AND ledger_revision = 2
  `).get();
  assert.deepEqual({ ...tape }, {
    tape_through: '2026-07-27', price_basis: 'raw_close', adjusted: 0,
  });
  assert.equal(navRows(env).at(-1).nav_date, '2026-07-27');
  const cache = JSON.parse(env.YC_KV.values.get('navcache:us'));
  assert.equal(cache.as_of, '2026-07-27');
  assert.equal(cache.holdings[0].price, 13);
});

test('historical publish preserves a verified same-day counter after the EOD tape', async () => {
  const env = await setup();
  seedEvents(env);
  const dates = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'];
  const historicalRow = date => ({
    date,
    cash: date === '2026-07-20' ? 1000 : 900,
    market_value: date === '2026-07-20' ? 0 : 120,
    total_assets: date === '2026-07-20' ? 1000 : 1020,
    liability: 0,
    net_value: date === '2026-07-20' ? 1000 : 1020,
    units: 1000,
    unit_nav: date === '2026-07-20' ? 1 : 1.02,
    sourceRef: 'counter-preservation-history',
    valuation: { priceBasis: 'raw_close', adjusted: false },
  });
  await persistLedgerValuationBatch(env, 'us', {
    replaceFrom: dates[0],
    replaceThrough: dates.at(-1),
    navRows: dates.map(historicalRow),
    priceRows: [],
  }, 2);
  await seedFrozenTape(env);
  await materializeLedgerKv(env, 'us', { expectedLedgerRevision: 2 });

  await persistLedgerValuation(env, 'us', {
    date: '2026-07-27',
    cash: 900,
    marketValue: 130,
    totalAssets: 1030,
    liability: 0,
    netValue: 1030,
    units: 1000,
    unitNav: 1.03,
    source: 'tushare:rt_k',
    sourceRef: 'rt_k:AAA:2026-07-27',
    valuation: {
      source: 'tushare:rt_k',
      source_endpoint: 'rt_k',
      fetched_at: '2026-07-27T19:00:00.000Z',
      freshness_class: 'intraday_snapshot',
      priceBasis: 'raw_counter',
      adjusted: false,
      quoteDate: '2026-07-27',
      sessionVerified: true,
    },
    warnings: [],
  }, [{
    ticker: 'AAA',
    date: '2026-07-27',
    close: 13,
    source: 'tushare:rt_k',
    sourceRef: 'rt_k:AAA:2026-07-27',
    valuation: {
      priceBasis: 'raw_counter',
      adjusted: false,
      quoteDate: '2026-07-27',
      sessionVerified: true,
    },
  }], 2);

  // This is the final historical replay batch. It must prune invalid future
  // rows while retaining the already-verified current-session counter.
  await persistLedgerValuationBatch(env, 'us', {
    replaceFrom: '2026-07-24',
    replaceThrough: '2026-07-24',
    pruneAfter: true,
    preserveCurrentSessionDate: '2026-07-27',
    navRows: [historicalRow('2026-07-24')],
    priceRows: [],
  }, 2);
  assert.deepEqual(navRows(env).slice(-2).map(row => row.nav_date), [
    '2026-07-24', '2026-07-27',
  ]);

  insertOutbox(env, { id: 'kv-2', revision: 2, kind: 'REBUILD_KV' });
  insertOutbox(env, {
    id: 'nav-2',
    revision: 2,
    kind: 'RECALC_NAV',
    payload: {
      affectedFrom: '2026-07-20',
      navReplay: {
        portfolio: 'us',
        ledgerRevision: 2,
        affectedFrom: '2026-07-20',
        phase: 'materialize',
        cursor: null,
        targetThrough: '2026-07-24',
        lastNavDate: '2026-07-24',
        lastUnitNav: 1.02,
      },
    },
  });
  insertOutbox(env, { id: 'xlsx-2', revision: 2, kind: 'REBUILD_EXCEL' });
  const replayNow = () => Date.parse('2026-07-27T19:00:00.000Z');
  const adapter = historicalAdapter();
  let drained;
  for (let index = 0; index < 3; index += 1) {
    drained = await drainLedgerOutbox(env, {
      portfolio: 'us',
      refreshPortfolio: (runtimeEnv, portfolio, options) =>
        updatePortfolioNav(runtimeEnv, portfolio, {
          ...options,
          adapter,
          now: replayNow,
        }),
    });
    if (!drained.pending) break;
  }
  assert.equal(drained.ok, true, JSON.stringify(drained));
  assert.equal(drained.pending, false, JSON.stringify(drained));
  assert.equal(navRows(env).at(-1).nav_date, '2026-07-27');
  const status = JSON.parse(env.YC_KV.values.get('navstatus:us'));
  assert.equal(status.counterPreserved, true);
  assert.equal(status.historicalThrough, '2026-07-24');
  assert.equal(status.as_of, '2026-07-27');
  const cache = JSON.parse(env.YC_KV.values.get('navcache:us'));
  assert.equal(cache.as_of, '2026-07-27');
  assert.equal(cache.holdings[0].price, 13);
  assert.equal(cache.holdings[0].priceBasis, 'raw_counter');
  const health = await ledgerHealth(env);
  assert.equal(health.rawNavPortfolios.us.ready, true,
    JSON.stringify(health.rawNavPortfolios.us));
  assert.equal(health.rawNavPortfolios.us.expectedCompletedSession, '2026-07-27');
});

test('revision change cannot advance a stale NAV checkpoint or mark Excel complete', async () => {
  const env = await setup();
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 1 WHERE portfolio_id = 'us'
  `).run();
  insertOutbox(env, { id: 'kv-1', revision: 1, kind: 'REBUILD_KV', status: 'DONE' });
  insertOutbox(env, { id: 'nav-1', revision: 1, kind: 'RECALC_NAV' });
  insertOutbox(env, { id: 'xlsx-1', revision: 1, kind: 'REBUILD_EXCEL' });

  const result = await drainLedgerOutbox(env, {
    portfolio: 'us',
    navBatchSize: 2,
    refreshPortfolio: async (runtimeEnv, portfolio, options) => {
      assert.equal(portfolio, 'us');
      assert.equal(options.ledgerRevision, 1);
      runtimeEnv.FEEDBACK_DB.database.prepare(`
        UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
      `).run();
      insertOutbox(runtimeEnv, {
        id: 'nav-2', revision: 2, kind: 'RECALC_NAV',
        payload: { affectedFrom: '2026-07-19' }, createdAt: 2,
      });
      return {
        historicalReplay: true,
        complete: false,
        phase: 'replay',
        nextPhase: 'replay',
        ledgerRevision: 1,
        batchFrom: '2026-07-20',
        batchThrough: '2026-07-21',
        targetThrough: '2026-07-24',
        nextCursor: '2026-07-22',
        lastNavDate: '2026-07-21',
        lastUnitNav: 1,
        navRows: 2,
        fallback: false,
      };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(result.results[0].superseded, true);
  const rows = outboxRows(env);
  const stale = rows.find(row => row.outbox_id === 'nav-1');
  assert.equal(stale.status, 'DONE');
  assert.equal(stale.attempts, 0);
  assert.equal(JSON.parse(stale.payload_json).navReplay, undefined);
  assert.equal(rows.find(row => row.outbox_id === 'nav-2').status, 'PENDING');
  assert.equal(rows.find(row => row.outbox_id === 'xlsx-1').status, 'PENDING');
});

test('a newer revision ignores an older cursor, restarts from the earliest affected date, and drains once', async () => {
  const env = await setup();
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_portfolios SET ledger_revision = 2 WHERE portfolio_id = 'us'
  `).run();
  insertOutbox(env, { id: 'kv-2', revision: 2, kind: 'REBUILD_KV', status: 'DONE' });
  insertOutbox(env, {
    id: 'nav-1', revision: 1, kind: 'RECALC_NAV',
    payload: {
      affectedFrom: '2026-07-20',
      navReplay: {
        portfolio: 'us', ledgerRevision: 1, affectedFrom: '2026-07-20',
        phase: 'replay', cursor: '2026-07-22', targetThrough: '2026-07-24',
        lastNavDate: '2026-07-21', lastUnitNav: 1,
      },
    },
  });
  insertOutbox(env, {
    id: 'nav-2', revision: 2, kind: 'RECALC_NAV',
    payload: { affectedFrom: '2026-07-19' }, createdAt: 2,
  });

  let calls = 0;
  const first = await drainLedgerOutbox(env, {
    portfolio: 'us',
    refreshPortfolio: async (_runtimeEnv, portfolio, options) => {
      calls += 1;
      assert.equal(portfolio, 'us');
      assert.equal(options.ledgerRevision, 2);
      assert.equal(options.affectedFrom, '2026-07-19');
      assert.equal(options.phase, null);
      assert.equal(options.cursor, null);
      assert.equal(options.targetThrough, null);
      return { historicalReplay: true, complete: true, ledgerRevision: 2, fallback: false };
    },
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(calls, 1);
  assert.ok(outboxRows(env).filter(row => row.kind === 'RECALC_NAV')
    .every(row => row.status === 'DONE'));

  const second = await drainLedgerOutbox(env, {
    portfolio: 'us',
    refreshPortfolio: async () => { calls += 1; },
  });
  assert.deepEqual(second, {
    ok: true,
    processed: 0,
    pending: false,
    remaining: 0,
    nextAvailableAt: null,
    results: [],
  });
  assert.equal(calls, 1);
});

test('concurrent drains atomically claim one row and report the active lease as remaining work', async () => {
  const env = await setup();
  seedEvents(env);
  insertOutbox(env, { id: 'kv-2', revision: 2, kind: 'REBUILD_KV', status: 'DONE' });
  insertOutbox(env, { id: 'nav-2', revision: 2, kind: 'RECALC_NAV' });

  let enterResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enterResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  let calls = 0;
  const refreshPortfolio = async () => {
    calls += 1;
    enterResolve();
    await release;
    return { historicalReplay: true, complete: true, ledgerRevision: 2, fallback: false };
  };

  const beforeClaim = Date.now();
  const firstPromise = drainLedgerOutbox(env, { portfolio: 'us', refreshPortfolio });
  await entered;
  const processing = outboxRows(env).find(row => row.outbox_id === 'nav-2');
  assert.equal(processing.status, 'PROCESSING');
  assert.match(processing.last_error, /^OUTBOX_CLAIM:/);
  assert.ok(processing.available_at >= beforeClaim + 4 * 60_000);
  assert.ok(processing.available_at <= Date.now() + 6 * 60_000);

  const second = await drainLedgerOutbox(env, { portfolio: 'us', refreshPortfolio });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.processed, 0);
  assert.equal(second.pending, true);
  assert.equal(second.remaining, 1);
  assert.equal(second.nextAvailableAt, processing.available_at);
  assert.equal(calls, 1);
  assert.deepEqual(await portfolioDerivationState(env, 'us'), {
    ledgerRevision: 2,
    derivedWorkPending: true,
    pendingCount: 1,
  });
  assert.equal((await ledgerHealth(env)).outboxPending, 1);

  releaseResolve();
  const first = await firstPromise;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.pending, false);
  assert.equal(first.remaining, 0);
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-2').status, 'DONE');
});

test('an expired PROCESSING lease is reclaimed and a stale owner cannot resurrect DONE', async () => {
  const env = await setup();
  seedEvents(env);
  insertOutbox(env, { id: 'kv-2', revision: 2, kind: 'REBUILD_KV', status: 'DONE' });
  insertOutbox(env, { id: 'nav-2', revision: 2, kind: 'RECALC_NAV' });

  let firstEnteredResolve;
  let firstReleaseResolve;
  const firstEntered = new Promise(resolve => { firstEnteredResolve = resolve; });
  const firstRelease = new Promise(resolve => { firstReleaseResolve = resolve; });
  let calls = 0;
  const refreshPortfolio = async () => {
    calls += 1;
    if (calls === 1) {
      firstEnteredResolve();
      await firstRelease;
      throw new Error('late stale owner failure');
    }
    return { historicalReplay: true, complete: true, ledgerRevision: 2, fallback: false };
  };

  const firstPromise = drainLedgerOutbox(env, { portfolio: 'us', refreshPortfolio });
  await firstEntered;
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_outbox SET available_at = ? WHERE outbox_id = 'nav-2'
  `).run(Date.now() - 1);

  const reclaimed = await drainLedgerOutbox(env, { portfolio: 'us', refreshPortfolio });
  assert.equal(reclaimed.ok, true, JSON.stringify(reclaimed));
  assert.equal(reclaimed.pending, false);
  assert.equal(reclaimed.remaining, 0);
  assert.equal(calls, 2);
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-2').status, 'DONE');

  firstReleaseResolve();
  const stale = await firstPromise;
  assert.equal(stale.ok, false);
  assert.equal(stale.results[0].error, 'outbox claim lost');
  const finalRow = outboxRows(env).find(row => row.outbox_id === 'nav-2');
  assert.equal(finalRow.status, 'DONE');
  assert.equal(finalRow.attempts, 1);
  assert.equal(finalRow.last_error, null);
});

test('a reclaimed partial checkpoint cannot be rolled back by its stale promise', async () => {
  const env = await setup();
  seedEvents(env);
  insertOutbox(env, { id: 'kv-2', revision: 2, kind: 'REBUILD_KV', status: 'DONE' });
  insertOutbox(env, { id: 'nav-2', revision: 2, kind: 'RECALC_NAV' });

  let firstEnteredResolve;
  let firstReleaseResolve;
  const firstEntered = new Promise(resolve => { firstEnteredResolve = resolve; });
  const firstRelease = new Promise(resolve => { firstReleaseResolve = resolve; });
  let calls = 0;
  const refreshPortfolio = async () => {
    calls += 1;
    if (calls === 1) {
      firstEnteredResolve();
      await firstRelease;
      return {
        historicalReplay: true,
        complete: false,
        phase: 'replay',
        nextPhase: 'replay',
        ledgerRevision: 2,
        batchFrom: '2026-07-20',
        batchThrough: '2026-07-21',
        targetThrough: '2026-07-24',
        nextCursor: '2026-07-22',
        lastNavDate: '2026-07-21',
        lastUnitNav: 1,
        navRows: 2,
        fallback: false,
      };
    }
    return {
      historicalReplay: true,
      complete: false,
      phase: 'replay',
      nextPhase: 'materialize',
      ledgerRevision: 2,
      batchFrom: '2026-07-22',
      batchThrough: '2026-07-24',
      targetThrough: '2026-07-24',
      nextCursor: null,
      lastNavDate: '2026-07-24',
      lastUnitNav: 1.02,
      navRows: 3,
      fallback: false,
    };
  };

  const firstPromise = drainLedgerOutbox(env, { portfolio: 'us', refreshPortfolio });
  await firstEntered;
  env.FEEDBACK_DB.database.prepare(`
    UPDATE ledger_outbox SET available_at = ? WHERE outbox_id = 'nav-2'
  `).run(Date.now() - 1);
  const advanced = await drainLedgerOutbox(env, { portfolio: 'us', refreshPortfolio });
  assert.equal(advanced.ok, true, JSON.stringify(advanced));
  assert.equal(advanced.pending, true);
  assert.equal(advanced.remaining, 1);
  let checkpoint = JSON.parse(outboxRows(env)
    .find(row => row.outbox_id === 'nav-2').payload_json).navReplay;
  assert.equal(checkpoint.phase, 'materialize');
  assert.equal(checkpoint.lastNavDate, '2026-07-24');

  firstReleaseResolve();
  const stale = await firstPromise;
  assert.equal(stale.ok, false);
  assert.equal(stale.results[0].error, 'outbox claim lost');
  checkpoint = JSON.parse(outboxRows(env)
    .find(row => row.outbox_id === 'nav-2').payload_json).navReplay;
  assert.equal(checkpoint.phase, 'materialize');
  assert.equal(checkpoint.lastNavDate, '2026-07-24');
});

test('older non-DONE work is superseded even when the newer row is already DONE', async () => {
  const env = await setup();
  seedEvents(env);
  insertOutbox(env, { id: 'nav-1', revision: 1, kind: 'RECALC_NAV' });
  insertOutbox(env, { id: 'nav-2', revision: 2, kind: 'RECALC_NAV', status: 'DONE' });

  const result = await drainLedgerOutbox(env, {
    portfolio: 'us',
    refreshPortfolio: async () => { throw new Error('superseded row must not run'); },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.pending, false);
  assert.equal(result.remaining, 0);
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-1').status, 'DONE');
});
