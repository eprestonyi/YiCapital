import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  drainLedgerOutbox,
  ledgerHealth,
  materializeLedgerKv,
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
  const sql = await readFile(new URL('../migrations/0002_portfolio_ledger.sql', import.meta.url), 'utf8');
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

function historicalAdapter() {
  const calls = [];
  const dates = ['20260720', '20260721', '20260722', '20260723', '20260724'];
  const prices = [10, 10, 11, 11.5, 12];
  return {
    calls,
    async query(dataset, request) {
      calls.push({ dataset, tsCode: request.params.ts_code });
      assert.equal(dataset, 'us_daily');
      if (request.params.ts_code === 'SPY') {
        return { data: dates.map((trade_date, index) => ({
          ts_code: 'SPY', trade_date, close: 600 + index,
        })) };
      }
      assert.equal(request.params.ts_code, 'AAA');
      return { data: dates.map((trade_date, index) => ({
        ts_code: 'AAA', trade_date, close: prices[index],
      })) };
    },
  };
}

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
    ['REBUILD_KV', true],
    ['RECALC_NAV', false],
  ]);
  assert.equal(first.results.at(-1).nextPhase, 'replay');
  assert.equal(first.results.at(-1).nextCursor, '2026-07-22');
  assert.equal(navRows(env).length, 2);
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

  const finalReplay = await drain();
  assert.equal(finalReplay.ok, true, JSON.stringify(finalReplay));
  assert.equal(finalReplay.results[0].complete, false);
  assert.equal(finalReplay.results[0].nextPhase, 'materialize');
  assert.equal(finalReplay.results[0].nextCursor, null);
  assert.equal(navRows(env).length, 5);
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'nav-2').status, 'PENDING');
  assert.equal(outboxRows(env).find(row => row.outbox_id === 'xlsx-2').status, 'PENDING');
  assert.equal(env.YC_KV.values.has('navcache:us'), false);

  const callsBeforeMaterialize = adapter.calls.length;
  const materialized = await drain();
  assert.equal(materialized.ok, true, JSON.stringify(materialized));
  assert.equal(materialized.results[0].nextPhase, 'publish');
  assert.equal(materialized.results[0].complete, false);
  assert.equal(adapter.calls.length, callsBeforeMaterialize + 1);
  assert.deepEqual(adapter.calls.at(-1), { dataset: 'us_daily', tsCode: 'SPY' });
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
  assert.equal(adapter.calls.length, callsBeforeMaterialize + 1);
  assert.ok(outboxRows(env).every(row => row.status === 'DONE'));
  const cache = JSON.parse(env.YC_KV.values.get('navcache:us'));
  assert.equal(cache.navRows.length, 5);
  assert.equal(cache.as_of, '2026-07-24');

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

test('legacy outbox publishes an already-complete current-revision NAV without rewriting D1', async () => {
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
  assert.deepEqual(adapter.calls.map(call => [call.dataset, call.tsCode]), [
    ['us_daily', 'SPY'],
  ]);
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
